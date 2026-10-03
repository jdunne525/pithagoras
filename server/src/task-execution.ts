import { nanoid } from "nanoid";
import { sessions, EXECUTOR_KIND } from "./session-manager.js";
import * as db from "./db.js";
import * as tasks from "./tasks.js";
import { buildTaskPrompt, DEFAULT_MAX_ATTEMPTS } from "./task-prompt.js";
import { waitForCompletionPromise } from "./task-completion.js";

/**
 * Autonomous Task execution (Phase 3).
 *
 * Persistence (Phase 1) and the queue/UI (Phase 2) already own the Task row and
 * its attempts. This module is the one place the Task is actually *run*: it
 * creates a fresh Pithagoras session for an attempt, hands the Task to that
 * session through the existing SessionManager, and keeps the Task/attempt
 * statuses honest while it runs. Completion detection (Phase 4) and retry
 * (Phase 5) sit on top of the attempt rows here record.
 *
 * The design follows the architectural rule that orchestration stays separate
 * from ordinary chat execution: the routes stay thin, calling one function
 * here, and every run goes through the same SessionManager a normal chat uses.
 */

interface TaskRun {
  /** The Task whose lifecycle owns this run. */
  taskId: string;
  /** First event seq to search for the completion promise (reads forward only). */
  startSeq: number;
  /** The attempt row created for it. */
  attemptId: string;
  /** The fresh session the attempt worked in. */
  sessionId: string;
  /** Set once the run has settled, whether by ending or stopping, so a later
      stop or second end cannot double-count it. */
  ended: boolean;
}

/** Runs currently executing, keyed by their session. A Task has at most one
    live attempt at a time; a new attempt replaces the old rather than doubling. */
const runs = new Map<string, TaskRun>();

/** The live run of a Task, if any is still going. */
export const liveRunOf = (taskId: string): TaskRun | undefined =>
  [...runs.values()].find((r) => r.taskId === taskId && !r.ended);

/** Whether a Task is executing right now. */
export const isRunning = (taskId: string): boolean => !!liveRunOf(taskId);

/** Any Task attempt running at all, anywhere. The queue loop runs one agent
 *  at a time across every project, so it waits while this is true. */
export const hasLiveTaskRun = (): boolean => [...runs.values()].some((r) => !r.ended);

/** Remove a run from the registry without touching its settled status. */
const forget = (run: TaskRun): void => {
  runs.delete(run.sessionId);
};

/**
 * Start a Task (Phase 3): create a fresh session for a new attempt, mark both
 * it and the Task running, and hand the Task to the session through
 * SessionManager. The run continues server-side after this returns; the
 * session's SSE stream carries its events to the Tasks view.
 *
 * A Task already running is reported back unchanged rather than started twice.
 * When the agent finishes on its own the attempt cannot tell it succeeded,
 * so a natural end asks completion detection to judge it — see finishSettled.
 */
export const startTask = (taskId: string): { task: db.TaskRow; attempt: db.TaskAttemptRow; sessionId: string } => {
  const task = tasks.getTask(taskId);
  const existing = liveRunOf(taskId);
  if (existing) {
    return {
      task,
      attempt: db.getAttempt(existing.attemptId)!,
      sessionId: existing.sessionId,
    };
  }

  const sessionId = nanoid(12);
  db.createSession({
    id: sessionId,
    title: task.title,
    workspace: task.workspace,
    executor: EXECUTOR_KIND,
    kind: "task",
    // A Task is named already, so it is never auto-titled like a blank chat.
    auto_title: 0,
  });

  // Open the attempt and mark it (and the Task) running before the session is
  // touched, so the UI shows work happening the moment we begin.
  const { attempt } = tasks.startAttempt(taskId, sessionId);
  // Each attempt works in a fresh session, so there is nothing before the
  // prompt to confuse the completion check.
  const run: TaskRun = { taskId, attemptId: attempt.id, sessionId, startSeq: 0, ended: false };
  runs.set(sessionId, run);

  // Watch the session for its own end: a non-running status means the run
  // reached its own end without being stopped, which completion detection then
  // judges complete-or-failed.
  trackEnd(run);

  // Kick off the autonomous work. The CodeLoop prompt marks the session
  // running itself; listen first so the guard only settles the attempt after
  // that. It wraps the task in the shared framing plus the completion marker,
  // warning about the server-wide attempt budget.
  void sessions.prompt(sessionId, buildTaskPrompt(task, { maxAttempts: DEFAULT_MAX_ATTEMPTS }))
    .catch((e: unknown) => {
      // The run could not even begin: settle it honestly rather than leave it
      // hanging running forever.
      finishSettled(run);
      console.error(`[portal] task ${taskId} failed to start:`, e);
    });

  return { task, attempt, sessionId };
};

/**
 * Stop a Task (Phase 3): settle its current attempt as stopped and ask
 * SessionManager to abort the underlying run. Marking stopped first makes the
 * change immediate; the abort unwinds pi afterwards.
 */
export const stopTask = (taskId: string): db.TaskRow => {
  const task = tasks.getTask(taskId);
  const run = liveRunOf(taskId);
  if (run) {
    run.ended = true;
    forget(run);
    // Settled before the abort resolves, so the view reflects the stop at once.
    tasks.finishAttempt(run.attemptId, "stopped");
    // An intentional stop is its own state, kept distinct from a natural-end
    // failure. Retain the attempt/session as history; it can be Rerun later.
    tasks.setTaskStatus(taskId, "stopped");
    void sessions.abort(run.sessionId).catch(() => {});
  } else {
    // Nothing to unwind: just move the Task to stopped if it was running.
    tasks.setTaskStatus(taskId, "stopped");
  }
  return tasks.getTask(taskId);
};

/**
 * Once a run has marked its session running, a later non-running status is the
 * run reaching its own end. Completion detection then judges the outcome
 * (complete-or-failed) exactly once, and this removes its own listener, so a
 * stop (which clears the run first) never races it into a second settling.
 */
function trackEnd(run: TaskRun): void {
  let seenRunning = false;
  const handler = (row: { type: string; payload: string }) => {
    if (run.ended) return;
    let status: string | undefined;
    try {
      status = JSON.parse(row.payload)?.status;
    } catch {
      return;
    }
    if (!status) return;
    if (status === "running") {
      seenRunning = true;
      return;
    }
    if (seenRunning) {
      run.ended = true;
      sessions.off(`session:${run.sessionId}`, handler);
      finishSettled(run);
    }
  };
  sessions.on(`session:${run.sessionId}`, handler);
}

/** Judge a run that reached its own end (Phase 4/5): the completion marker
    decides complete-or-failed, and a failed attempt is retried by the loop up
    to the server-wide budget before the Task is marked failed. This keeps the
    Task out of the permanent "running" state and gives the queue a clear next
    action every time. */
const finishSettled = (run: TaskRun): Promise<void> => {
  if (run.ended) return Promise.resolve();
  run.ended = true;
  forget(run);
  return waitForCompletionPromise(run.sessionId, run.startSeq).then((completed) => {
    tasks.finishAttempt(run.attemptId, completed ? "completed" : "failed");
    const task = tasks.getTask(run.taskId);
    if (completed) {
      tasks.setTaskStatus(run.taskId, "completed");
      return;
    }
    // No completion marker: retried by the queue loop while attempts under the
    // server-wide default remain, otherwise failed. Never left hanging.
    tasks.setTaskStatus(
      run.taskId,
      task.attempts < DEFAULT_MAX_ATTEMPTS ? "pending" : "failed",
    );
  });
};
