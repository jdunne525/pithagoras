import { nanoid } from "nanoid";
import { sessions, PromptQueuedForSingleActive } from "./session-manager.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import * as db from "./db.js";
import * as tasks from "./tasks.js";
import { buildTaskPrompt, DEFAULT_MAX_ATTEMPTS } from "./task-prompt.js";
import { readTaskInstructions } from "./projects.js";
import { roomRefused, runAway } from "./compaction-ladder.js";
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

/** A run that reached its end and whose outcome has not been written yet.
    `finishSettled` takes the run out of the registry the moment it ends, because
    nothing is going any more, and then reads the transcript to decide
    complete-or-failed — a bounded read, but a window all the same, and through
    it the Task and its attempt still read running. The queue's gate counts this
    state as work in hand, which is what keeps a loop from taking another Task
    across it: on the machine a Task's fifth attempt had settled its session at
    13:10:09 and was written settled at 13:10:21, and a loop for another Project
    started a fresh Task at 13:10:11 inside that window — a next Task begun over
    a present one that was not done. The Task is put here for the whole of the
    judgement and taken out the moment its statuses are written. */
const judging = new Set<string>();

/** Whether a Task is working anywhere at all — going, or being judged at its end
 *  — which is what the queue loop of every Project reads before it takes a Task:
 *  one agent at a time, and no next Task begun over a present one that is not
 *  done. A run that ended but whose outcome has not been written is not work the
 *  queue may start beside either, so both states answer here. */
export const hasLiveTaskRun = (): boolean =>
  judging.size > 0 || [...runs.values()].some((r) => !r.ended);

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

  // Project-specific Task instructions (§14 / Phase 7): appended as their own
  // block inside this prompt for every autonomous run. Kept out of AGENTS.md,
  // so they never leak into ordinary chats — read straight from the folder and
  // handed here explicitly. A failure to read them must not stop the Task.
  let projectInstructions = "";
  try {
    projectInstructions = readTaskInstructions(task.workspace);
  } catch (e) {
    console.error(`[portal] task ${taskId}: could not read project instructions:`, e);
  }

  // Kick off the autonomous work. The CodeLoop prompt marks the session
  // running itself; listen first so the guard only settles the attempt after
  // that. It wraps the task in the shared framing plus the completion marker,
  // warning about the server-wide attempt budget.
  void sessions.prompt(
    sessionId,
    buildTaskPrompt(task, { maxAttempts: DEFAULT_MAX_ATTEMPTS, projectInstructions }),
  )
    .catch((e: unknown) => {
      // Held because something else holds the room under the single-active
      // setting: the request was queued, and will start when the room frees,
      // so this is not a failure and must not settle the attempt.
      if (e instanceof PromptQueuedForSingleActive) return;
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
 * Abort a Task's running attempt without changing its status — used by delete,
 * where the row is going away anyway and there is no state to record. It unwinds
 * the underlying pi process (via SessionManager) so nothing is left running after
 * the Task is dropped. Nothing to unwind means this is a no-op.
 */
export const abortLiveRun = (taskId: string): void => {
  const run = liveRunOf(taskId);
  if (!run) return;
  run.ended = true;
  forget(run);
  void sessions.abort(run.sessionId).catch(() => {});
};

/** How often the fallback re-checks a run's session while it is still going.
 *  One tick is enough to notice a stop that the live stream never reported, and
 *  far from frequent enough to matter for the normal, event-driven path. */
const STOP_DETECTION_GAP_MS = 2000;

/** Carries of ours a run is given when a compaction, rather than the work, ended
 *  it. Counted like the model's own cut-off carries: each one is the same work in
 *  the same session, and a Task whose chat cannot be cut further gets a few turns
 *  to continue before its attempt is concluded as an end. */
const COMPACT_CARRY_BUDGET = 3;

/** The line that carries a compaction's turn back on. The SessionManager's own
 *  words for the same act: the run continues because of a compaction either way,
 *  and a chat reads one kind of resumption, not a third sentence of its own. */
const COMPACT_PICK_UP = "Compaction detected, resume where you left off if needed.";

/**
 * Detect the moment a run reaches its own end and settle it, so completion
 * detection can judge the outcome (complete-or-failed) exactly once. A failed
 * attempt is then retried by the queue loop with a brand-new session/context,
 * and a stop — which clears the run first — never races the settle into a
 * second one.
 *
 * Detection rides on two independent signals so that missing either one cannot
 * strand the run forever (leaving the Task stuck showing working over a status
 * nothing observed). The fast path is the live `portal_status` transition:
 * once the run has been confirmed working, any later non-running status reaches
 * the run's end at once — which `endOrCarry` below decides between an end to
 * settle and a compaction's cut-short to carry on. The fallback reads the session's persisted status instead — the
 * very thing the view renders as working — so a dropped or missed transition
 * still settles the run and lets the queue move on. Confirming the run has
 * started also rides on persistence as well as the live event, and a fresh
 * attempt works in a brand-new session whose initial idle status must never be
 * mistaken for a stop, so the fallback only settles once it has first seen the
 * session persist as running.
 */
function trackEnd(run: TaskRun): void {
  // Confirmed working: the run has been seen transitioning to running, whether
  // by the live event or by the persisted status. Before this, any non-running
  // status (notably the fresh session's starting idle) is ignored. run.ended is
  // deliberately left to finishSettled: see settle().
  let confirmedRunning = false;
  let settled = false;
  let watchTimer: NodeJS.Timeout | undefined;

  // A compaction that caught this run mid-turn leaves the turn unfinished, and
  // the session reads idle twice around it: while the compaction unwinds the
  // aborted turn, and again in the gap before the resume that carries the turn
  // on starts its own run. The same idle appears a third time when the model
  // ends a run out of output tokens mid-answer ("length"): the answer was cut
  // off, not finished, and SessionManager carries the turn on in the same
  // session. None of these idles is a real end. SessionManager.isCompacting()
  // covers all of them — it stays true from compaction_start, or from a run
  // that ended cut off, until the carried-on run's agent_start lands — and
  // while it holds we must never settle: doing so drops the run from the
  // registry while the session still works, so the queue loop would launch a
  // second session for the same Task ("the same task running twice"), and the
  // single-active gate would hand the room to another Task in the gap. Last
  // night in BlastRunHero that is what a Task did four times over: each run
  // ended with the model rambling to its 16,384-token output limit, the idle
  // settled the attempt as failed, and a brand-new session started the Task
  // again from nothing. We instead keep waiting for the carried-on turn's own
  // natural end, which fires settle exactly once afterwards.
  const possiblyCompacting = (): boolean => sessions.isCompacting(run.sessionId);

  const settle = (): void => {
    if (settled) return;
    settled = true;
    sessions.off(`session:${run.sessionId}`, handler);
    if (watchTimer) clearTimeout(watchTimer);
    // finishSettled owns run.ended (setting it here, synchronously, is what puts
    // the Task out of the permanent "running" state and stops the queue loop)
    // and judges complete-or-failed exactly once — including reading for the
    // completion promise. Setting run.ended beforehand would trip its guard and
    // skip that check, leaving a finished Task stuck working, so it must not be
    // set here. A failed attempt is retried by the queue loop with a fresh
    // session/context.
    finishSettled(run);
  };

  // A compaction, and not the work, can end a run: pi stops the run for a compact
  // of a conversation that is mid-turn, the turn it starts back afterwards can be
  // refused before it writes (the answer comes back errored — "This operation was
  // aborted"), and the compact the portal runs for the chat can answer that it has
  // nothing at all to take out of it ("Nothing to compact (session too small)").
  // None of those says the Task finished; they say the chat cannot be cut further,
  // and the work is still in hand. Read on the whole machine this is not rare: on
  // the Tasks page nine different Tasks lost an attempt this way over their own
  // attempt numbers 1 to 6, every attempt written as failed seconds after such a
  // compaction, and the queue then launched a brand-new session that started the
  // Task again from nothing. So the reason a run ended on is kept here beside a
  // bounded count of the carries of ours this handler asks for, in the same shape
  // the cut-off answer's carries are counted, and an end that came from a
  // compaction hands the work back to the same session — where its context, and
  // with it the part of the Task already done, still lives — instead of settling
  // the attempt. An end on its own terms, or one after the carries run out, settles
  // exactly as it always did.
  let compactionSeen = false;
  let endedByCompaction = false;
  let carries = 0;
  // A carry of this run the room refused sits in the room's queue until the
  // holder lets go. One waiting line is enough for this turn; see below.
  let carryWaiting = false;

  const endOrCarry = (): void => {
    // The SessionManager still holds the turn (a compaction mid-run, or a cut-off
    // answer waiting for its carry-on): neither the settle nor a carry of ours
    // belongs here, and that mechanism sends its own line.
    if (possiblyCompacting()) return;
    if (endedByCompaction && carries < COMPACT_CARRY_BUDGET) {
      // Never into a run that is going: pi queues the line into that run, where
      // the model reads it as an order to start working again — which is how a
      // chat comes to answer the same sentence every turn and never finish. The
      // marker stays set, so the run's own end decides again.
      if (db.getSession(run.sessionId)?.status === "running") return;
      // A carry the room refused is none of this run's carries: the line waits
      // in the queue, and the queue starts it when the room frees. Counting the
      // refusals spent the budget on the room instead of on the chat, and the
      // fourth look settled the attempt as failed over work still in hand —
      // which is what every BlastRunHero Task lost over a night, nine Tasks at
      // their own attempt numbers 1 to 6 (the chats beside `sQSaW8RT78AD`), each
      // attempt written failed seconds after a compaction and a brand-new
      // session starting the Task again from nothing. Only a carry that reached
      // the chat counts, and only one line for this turn waits in the queue:
      // asking again on every look at the room stacks copies of it, which is
      // how a chat comes to answer the carry-on sentence every turn.
      if (carryWaiting) return;
      // The reason stays set while the line is in flight: a settled attempt
      // beside a carry that has not gone is the failure the queue loop would
      // otherwise answer by starting the Task again in a fresh session.
      void sessions.prompt(run.sessionId, COMPACT_PICK_UP, { resume: "compaction" }).then(
        () => {
          // The line reached the chat and started its run there: that is one of
          // this run's carries, and the turn is no longer waiting for one.
          carries += 1;
          endedByCompaction = false;
          carryWaiting = false;
        },
        (e: unknown) => {
          if (e instanceof PromptQueuedForSingleActive) {
            // Held behind another room-holder: the queue starts it once the room
            // frees, so this is not a failure, and it is not a carry either.
            // The reason stays set, because the turn is still in hand.
            carryWaiting = true;
            return;
          }
          console.error(`[portal] task ${run.taskId} could not be carried on after a compaction:`, e);
          // The carry will not come: the turn is over as far as this handler knows,
          // and the attempt settles like any ended run.
          settle();
        },
      );
      return;
    }
    settle();
  };

  // Fast path: the live portal_status transition. A transition away from
  // running, once the run is confirmed working, is the run reaching its end —
  // which endOrCarry decides between an end and a compaction's cut-short.
  const handler = (row: { type: string; payload: string }): void => {
    if (run.ended) return;
    // What a compaction did in this run, and what the last answer stopped on,
    // are read here: they are the difference between a Task that ended and one a
    // compaction cut short.
    if (row.type === "compaction_start" || row.type === "compaction_end") {
      compactionSeen = true;
      try {
        const landed = JSON.parse(row.payload);
        if (landed.type === "compaction_end" && roomRefused(landed.errorMessage)) {
          // Pi found nothing to take out: the chat's count of failures and its
          // switch are nobody's to move, and the run's end is not the Task's.
          endedByCompaction = true;
        }
      } catch {
        // A row that cannot be read says nothing about where the run ends.
      }
      return;
    }
    if (row.type === "message_end") {
      try {
        const answer = JSON.parse(row.payload)?.message;
        if (answer?.role === "assistant") {
          // An errored answer beside a compaction, and an answer whose reason names
          // a request that was stopped (the model's words for the same end: pi ends
          // the run on being run away with a compaction, or with an ask of the
          // portal's, and writes this sentence) both say the run was cut short,
          // nothing that the Task reached its end — fact 9 of the ladder, read at
          // the run's last message rather than at the compaction's own answer.
          endedByCompaction =
            (compactionSeen && answer.stopReason === "error") || runAway(answer?.errorMessage);
          // An answer that stopped on anything else went through: the work
          // carried on past the compaction, so the next one is the next chance.
          if (!endedByCompaction) compactionSeen = false;
        }
      } catch {
        // A message that cannot be read says nothing about where the run ends.
      }
      return;
    }
    let status: string | undefined;
    try {
      status = JSON.parse(row.payload)?.status;
    } catch {
      return;
    }
    if (!status) return;
    if (status === "running") {
      confirmedRunning = true;
      // A run started where a carry of this run was waiting for the room: the
      // queue passed the line on, so the turn is not waiting any more, and a
      // later cut short of another compaction may be carried on again.
      carryWaiting = false;
      return;
    }
    if (confirmedRunning) endOrCarry();
  };
  sessions.on(`session:${run.sessionId}`, handler);

  // Fallback: read the session's persisted status — what the view actually
  // renders as working — so a missed live transition cannot strand the run. It
  // also confirms the run has started from persistence itself, so losing the
  // live "running" event alone cannot strand it either. Only after the session
  // has first persisted as running does a later non-running status settle it,
  // so the fresh session's starting idle never counts as an immediate stop.
  watchTimer = setInterval(() => {
    if (run.ended) {
      clearTimeout(watchTimer);
      return;
    }
    const status = db.getSession(run.sessionId)?.status;
    if (status === "running") {
      confirmedRunning = true;
      // A run started where a carry of this run was waiting for the room: the
      // queue passed the line on, so the turn is not waiting any more, and a
      // later cut short of another compaction may be carried on again. Read
      // from persistence, this says the same as the live transition above.
      carryWaiting = false;
    } else if (confirmedRunning) {
      endOrCarry();
    }
  }, STOP_DETECTION_GAP_MS).unref();
}

/** Judge a run that reached its own end (Phase 4/5): the completion marker
    decides complete-or-failed, and a failed attempt is retried by the loop with
    the same Task — never with the one behind it — up to the server-wide budget
    before the Task is marked failed. This keeps the Task out of the permanent
    "running" state and gives the queue a clear next action every time. */
const finishSettled = async (run: TaskRun): Promise<void> => {
  if (run.ended) return;
  run.ended = true;
  forget(run);
  // The gate holds across the whole judgement below: the run has gone, but the
  // Task is not done until its outcome is written, and a loop that polled in
  // between the two would otherwise move on to the next Task in its Project —
  // or, being a shared gate, to a Task of another Project's — over work still
  // in hand. It is released by the `finally`, which runs once the attempt and
  // the Task have both been written.
  judging.add(run.taskId);
  try {
    const completed = await waitForCompletionPromise(run.sessionId, run.startSeq);
    tasks.finishAttempt(run.attemptId, completed ? "completed" : "failed");
    const task = tasks.getTask(run.taskId);
    if (completed) {
      tasks.setTaskStatus(run.taskId, "completed");
      return;
    }
    // No completion marker: the queue loop runs this same Task again while
    // attempts under the server-wide default remain — it is the first Task not
    // finished, so it is the one taken — and otherwise the Task is marked
    // failed, which the loop stalls on rather than passing. Never left hanging.
    tasks.setTaskStatus(
      run.taskId,
      task.attempts < DEFAULT_MAX_ATTEMPTS ? "pending" : "failed",
    );
  } finally {
    // The Task's outcome is written: the run is over, and the queue's gate may
    // answer for the next Task. Deleting before these writes, or never at all,
    // would leave the gate closed forever or open over work still in hand.
    judging.delete(run.taskId);
  }
};
