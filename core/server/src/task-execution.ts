import { nanoid } from "nanoid";
import { sessions, setTaskRunBridge, PromptQueuedForSingleActive } from "./session-manager.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import * as db from "./db.js";
import * as tasks from "./tasks.js";
import { buildTaskBrief, buildTaskPrompt, DEFAULT_MAX_ATTEMPTS } from "./task-prompt.js";
import { briefFileOf, briefSeenBy, removeBrief, writeBrief } from "./task-brief.js";
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
  /** Where this attempt's brief file is, as its agent reads it; unset when it could
      not be written, and then the prompt holds the instructions itself. */
  briefPath?: string;
  /** Where the Task goes when this run ends without the marker, for a run the
      person resumed rather than one the portal started: the state the chat was in
      before the resume. A resume is not the queue's attempt, so it does not put
      the Task back on the queue — that would have a loop begin it again in a
      brand-new session over the chat the person was working in. */
  resumeTo?: db.TaskStatus;
  /** The Task's attempt count before this run was opened, to put back where an
      adoption never got as far as running. */
  prevAttempts?: number;
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
 * Write one attempt's brief, and say where its agent reads it.
 *
 * The brief (task-brief.ts) holds the standing instructions of the attempt — the
 * task, the project's own Task instructions, and the marker the run has to finish
 * on — in a file no compaction can rewrite. Project instructions (§14 / Phase 7)
 * are read straight from the folder for every autonomous run and kept out of
 * AGENTS.md, so they never leak into ordinary chats. A failure to read them, or to
 * write the file, must not lose the attempt: the prompt then carries the same words.
 *
 * Written before the message goes in, so the session's first load of its prompt
 * already points at it — which is why a resumed chat gets it from here too, before
 * the line the person typed reaches pi.
 */
const writeRunBrief = (
  sessionId: string,
  task: db.TaskRow,
  attemptNumber: number,
  executor: string = EXECUTOR_KIND,
): { briefPath?: string; projectInstructions: string } => {
  let projectInstructions = "";
  try {
    projectInstructions = readTaskInstructions(task.workspace);
  } catch (e) {
    console.error(`[portal] task ${task.id}: could not read project instructions:`, e);
  }
  const seen = briefSeenBy(sessionId, executor);
  const written = writeBrief(
    briefFileOf(sessionId),
    buildTaskBrief(task, {
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      projectInstructions,
      attemptNumber,
      // Where the agent will read it, which is not where the portal wrote it for a
      // container's pi: that one has the attempt's brief folder mounted beside its workspace.
      briefPath: seen,
    }),
  );
  return written ? { briefPath: seen, projectInstructions } : { projectInstructions };
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

  // The brief, and with it the project's own Task instructions: written before the
  // prompt, so the session's first load of its prompt already points at them.
  const { briefPath, projectInstructions } = writeRunBrief(sessionId, task, attempt.attempt_number);
  // Kept on the run as well: a turn a compaction cut short is carried on by a line of
  // ours, and that line has to name the file the model no longer holds.
  run.briefPath = briefPath;

  // Kick off the autonomous work. The CodeLoop prompt marks the session
  // running itself; listen first so the guard only settles the attempt after
  // that. It wraps the task in the shared framing plus the completion marker,
  // warning about the server-wide attempt budget. An attempt above the first is
  // told what it is, so it reads the folder's own state before it re-does work an
  // earlier attempt left uncommitted (see `buildTaskPrompt`).
  void sessions.prompt(
    sessionId,
    buildTaskPrompt(task, {
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      projectInstructions,
      attemptNumber: attempt.attempt_number,
      briefPath,
    }),
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
    // The brief goes with the attempt: nothing is going to read it again.
    removeBrief(run.sessionId);
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
  removeBrief(run.sessionId);
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
 * The line that carries a Task's turn back on, with its brief named.
 *
 * A compaction is exactly the moment this run needs the file: it has just lost
 * part of what it was told, including, very likely, the Completion Requirement
 * and the marker it must finish with. The brief is untouched by it, so the
 * carry-on says where to read it again rather than leaving the model to
 * remember words that are no longer in its context.
 */
const carryLine = (briefPath?: string): string =>
  briefPath
    ? `${COMPACT_PICK_UP} The instructions of this task — including the completion marker you must ` +
      `print to finish it — are in \`${briefPath}\`; read that file again before you go on, and do not ` +
      `begin the task from nothing.`
    : COMPACT_PICK_UP;

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
function trackEnd(run: TaskRun, started = false): void {
  // Confirmed working: the run has been seen transitioning to running, whether
  // by the live event or by the persisted status. Before this, any non-running
  // status (notably the fresh session's starting idle) is ignored. run.ended is
  // deliberately left to finishSettled: see settle().
  //
  // A run this process did not start — a chat the person resumed after a restart
  // (see adoptResumedRun) — is taken over with the message already on its way to
  // pi, so its first running transition can be missed by the listener below and
  // its last answer can land before the fallback's first look at the room. It is
  // confirmed working at once, which is what keeps a resumed run that answers
  // quickly from being left unsettled forever with the queue's gate closed on it.
  let confirmedRunning = started;
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
      void sessions.prompt(run.sessionId, carryLine(run.briefPath), { resume: "compaction" }).then(
        (sent: boolean) => {
          if (!sent) {
            // A Stop got there first, and the line never went: prompt() says so
            // by answering false, not by throwing, and it wrote the line in the
            // chat as not sent. Read as a carry that reached the chat, that is
            // a carry counted that never was — the reason the work is still in
            // hand is cleared, the next look at the run's end settles the
            // attempt as failed, and nothing carries the work on. That is
            // exactly the shape of a night in BlastRunHero: at 12:35:59 the run
            // settled, the carry was asked at 12:35:59.576, a Stop taken during
            // the compaction behind it answered it as not sent at 12:36:12.904,
            // and the Task's attempt was written failed over work still in hand.
            // The carry will not come, so this is the same end as the refusal
            // below.
            settle();
            return;
          }
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
    // The attempt is over: its brief has nothing left to hold for the run. A retry
    // of the Task is a fresh session with a brief of its own.
    removeBrief(run.sessionId);
    const task = tasks.getTask(run.taskId);
    if (completed) {
      tasks.setTaskStatus(run.taskId, "completed");
      return;
    }
    // No completion marker. A run the portal started goes back to pending while
    // attempts under the server-wide default remain — it is the first Task not
    // finished, so the queue loop runs this same Task again — and otherwise the
    // Task is marked failed, which the loop stalls on rather than passing. A run
    // the person resumed by sending a line into its own chat goes back where that
    // resume found it instead: the queue has no part in a chat the person is
    // working in, and moving a stopped or failed Task back onto the queue over a
    // resume that did not finish would have a loop begin it again in a brand-new
    // session beside the chat it was just in. Never left hanging.
    tasks.setTaskStatus(
      run.taskId,
      run.resumeTo ?? (task.attempts < DEFAULT_MAX_ATTEMPTS ? "pending" : "failed"),
    );
  } finally {
    // The Task's outcome is written: the run is over, and the queue's gate may
    // answer for the next Task. Deleting before these writes, or never at all,
    // would leave the gate closed forever or open over work still in hand.
    judging.delete(run.taskId);
  }
};

/**
 * Take over a Task's chat that this process did not start — the run resumed from
 * the last one.
 *
 * What notices a Task's run reaching its end lives in the `runs` map above, and
 * a restart takes that memory with it. The chat does not lose its parent: the
 * attempt row that points at it (`task_attempts.session_id`, db.ts) is in the
 * database, so a chat left `interrupted` still says which Task it was made for.
 * Until now nothing read that back — a person who resumed such a chat by sending
 * a line into it got the work carried on in the same conversation, and the run
 * then ended with its answer in the transcript while the Task still read what
 * recovery had left it: pending, or failed. Nothing closed it, because nothing
 * was listening for this run at all.
 *
 * So a message that starts a run in a chat this process never registered is read
 * back from the attempt row here and watched like a run it did start: the Task
 * and a new attempt of it go running on the same conversation, the brief is
 * written again for that attempt — which is how a resumed chat is told the marker
 * it has to finish on, the restart having taken the previous attempt's file with
 * it — and `trackEnd` judges the end exactly as it judges a run started from the
 * Tasks view. The marker closes the parent Task; anything else settles the
 * attempt and leaves the Task where the resume found it.
 *
 * A chat with no attempt pointing at it is an ordinary chat and is left alone. A
 * child chat works under its parent's run and is left alone too — its own end is
 * nobody's Task, and its parent's run is watched on its own session. A Task that
 * already has a live attempt is not started a second time beside it, and one
 * already completed has nothing left to close.
 *
 * Nothing here is worth losing the person's message over, so a failure to read or
 * write the Task is said and the chat is left to run unwatched; the next message
 * into it is adopted again.
 */
export const adoptResumedRun = (sessionId: string): TaskRun | undefined => {
  try {
    return takeOverResumedRun(sessionId);
  } catch (e) {
    console.error(`[portal] could not take over a resumed Task run in chat ${sessionId}:`, e);
    return undefined;
  }
};

const takeOverResumedRun = (sessionId: string): TaskRun | undefined => {
  const session = db.getSession(sessionId);
  // A child chat is part of the run that made it, not an attempt of its own.
  if (!session || session.parent_id) return undefined;
  // Already watched, whether by the portal's own start or by an earlier resume.
  if (runs.has(sessionId)) return undefined;
  const parent = db.taskRunOf(sessionId);
  if (!parent) return undefined;
  // Read from the row, not from the service: a Task that is gone is nobody's
  // parent, and a chat's message must not fail over a lookup of one.
  const task = db.getTask(parent.taskId);
  if (!task || task.status === "completed") return undefined;
  if (liveRunOf(task.id)) return undefined;
  // A run of this Task that has ended and is being judged: its outcome is on its
  // way to being written, and a resume taken up in that window would have the two
  // write over each other — one attempt completed and the Task closed over a chat
  // that has work going in it. The judgement is short; this message simply starts
  // no attempt of its own, and the next one is adopted.
  if (judging.has(task.id)) return undefined;

  const prevAttempts = task.attempts;
  // Where the Task goes if this run ends without the marker. A Task that read
  // working with nothing working it is the odd case — a run the portal started
  // settles itself — and such a Task goes back to pending rather than being left
  // reading working by the resume that only visited it.
  const resumeTo = task.status === "running" ? "pending" : task.status;
  const { attempt } = tasks.startAttempt(task.id, sessionId);
  const run: TaskRun = {
    taskId: task.id,
    attemptId: attempt.id,
    sessionId,
    // Read forward from the resume, as every other attempt reads forward from its
    // own prompt: what the chat said before the restart is the earlier attempt's
    // answer, and that attempt is already written — recovery judged it at startup
    // (task-recovery.ts reads the transcript for exactly that).
    startSeq: db.latestSeq(),
    ended: false,
    resumeTo,
    prevAttempts,
  };
  runs.set(sessionId, run);
  // The brief as this chat's own executor reads it: a container's pi has the
  // folder mounted beside its workspace and cannot open the portal's path.
  run.briefPath = writeRunBrief(sessionId, task, attempt.attempt_number, session.executor).briefPath;
  // The message is already on its way, so the run counts as working from here.
  trackEnd(run, true);
  console.log(`[portal] task ${task.id} resumed in chat ${sessionId} as attempt ${attempt.attempt_number}`);
  return run;
};

/**
 * Undo a takeover whose message never reached pi.
 *
 * A line a Stop got in front of starts no run, so the attempt opened for it is
 * taken back out rather than left in the Task's history as a run that never went,
 * and the Task goes back to the state the resume found it in. The watcher is
 * already watching; `ended` is what it checks before doing anything, so there is
 * nothing to unwire.
 */
export const abandonResumedRun = (sessionId: string): void => {
  try {
    const run = runs.get(sessionId);
    if (!run || run.resumeTo === undefined) return;
    run.ended = true;
    forget(run);
    db.deleteAttempt(run.attemptId);
    removeBrief(sessionId);
    db.updateTaskFields(run.taskId, { status: run.resumeTo, attempts: run.prevAttempts ?? 0 });
  } catch (e) {
    console.error(`[portal] could not hand back a resumed Task run in chat ${sessionId}:`, e);
  }
};

// The SessionManager hands these to itself: it is the one who knows a message has
// reached pi, and the Task's own chat is where a person resumes a run this server
// never started. Wired here rather than imported, so the execution module stays
// the only place the Task's lifecycle is decided and nothing in the chat path has
// to know about Tasks.
setTaskRunBridge({ adopt: adoptResumedRun, release: abandonResumedRun });

