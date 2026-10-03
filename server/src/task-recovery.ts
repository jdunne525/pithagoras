import { getSetting, putSetting, listAllRunningTasks } from "./db.js";
import * as tasks from "./tasks.js";
import { activeLoopWorkspaces, clearPersistedLoop, startLoop } from "./task-queue.js";

/**
 * Restart recovery and queue-loop state for autonomous Tasks (Phase 8).
 *
 * Two things survive a restart and must be made honest again:
 *
 *   1. Tasks left marked `running`. At startup nothing is executing yet, so any
 *      such Task was owned by the previous process, which is gone. Return it to
 *      `pending` (keeping its attempts as history) so it can be run again rather
 *      than hanging forever. This runs alongside orphan-session recovery.
 *
 *   2. Queue loops that were running. Recovery of the loop itself is a
 *      configuration setting (§13): the default is OFF, so a restarted server
 *      never starts running Tasks on its own. When an operator opts in, the
 *      loop is restarted for every Project that was running at shutdown.
 */

const RESUME_KEY = "task_loop_resume_on_startup";

/** Whether a restarted server may resume queued loops (default: off). */
export function taskLoopResumeEnabled(): boolean {
  try {
    return getSetting(RESUME_KEY) === "true";
  } catch {
    return false;
  }
}

/** Toggle the restart-resume setting (§13). Stored like any other portal
 *  setting; absent means the default, off. */
export function setTaskLoopResumeEnabled(enabled: boolean): void {
  putSetting(RESUME_KEY, enabled ? "true" : "false");
}

/**
 * Reconcile Tasks left `running` by a crashed/restarted server (Phase 8/§13).
 *
 * Nothing executes at startup, so every running Task is stale. Its live attempt
 * — if any is still flagged running, because the crash took the flag with it —
 * is recorded as failed (the run ended abnormally rather than by a user stop),
 * and the Task itself is returned to `pending` so it can be Rerun/Run again.
 * Attempts are kept as history. Returns how many Tasks were reconciled.
 */
export function reconcileInterruptedTasks(): number {
  const running = listAllRunningTasks();
  for (const task of running) {
    const attempts = tasks.listAttemptsByTask(task.id);
    // The run that died mid-flight: whichever attempt is still open, otherwise
    // the most recent one. Record it as failed — it ended abnormally, not by a
    // user stop — so the history does not show a perpetually running attempt.
    const stuck = attempts.find((a) => a.status === "running") ?? attempts.at(-1);
    if (stuck && stuck.status === "running") {
      tasks.finishAttempt(stuck.id, "failed");
    }
    // Back onto the queue, ready to run again. Never leaves the Task running.
    // (Not Rerun: that refuses a still-running Task, which this one is.)
    tasks.setTaskStatus(task.id, "pending");
  }
  return running.length;
}

/**
 * Restore queue-loop state after a restart (Phase 8/§13).
 *
 * Default behaviour is OFF: the loop does not re-enable itself on boot, so no
 * Task starts running just because the server came back up. Any loop flag left
 * running by a crash is cleared so the in-memory view (stopped) matches
 * persisted state. When an operator has opted in via {@link taskLoopResumeEnabled},
 * each Project that was running at shutdown resumes its loop instead.
 */
export function recoverQueuedLoopsAfterRestart(): void {
  const active = activeLoopWorkspaces();
  if (active.length === 0) return;
  if (taskLoopResumeEnabled()) {
    for (const ws of active) startLoop(ws);
  } else {
    for (const ws of active) clearPersistedLoop(ws);
  }
}
