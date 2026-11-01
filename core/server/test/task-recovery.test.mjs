import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-recovery-"));
const ws = () => {
  const w = path.join(home, "ws", randomUUID());
  mkdirSync(w, { recursive: true });
  return w;
};

process.env.DATA_DIR = path.join(home, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const recovery = await import("../dist/task-recovery.js");

test("reconcile returns a Task left running back to pending (Phase 8)", () => {
  const project = ws();
  const task = tasks.createTask({ workspace: project, title: "Stuck run" });
  tasks.startAttempt(task.id);
  assert.equal(db.getTask(task.id).status, "running", "as left by a crashed server");

  const reconciled = recovery.reconcileInterruptedTasks();
  assert.equal(reconciled, 1, "one running Task was found");
  const reset = db.getTask(task.id);
  assert.equal(reset.status, "pending", "back onto the queue, never left running");
  assert.equal(reset.completed_at, null);
});

test("reconcile records the dead attempt as failed, keeping history", () => {
  const project = ws();
  const task = tasks.createTask({ workspace: project, title: "Dead attempt" });
  tasks.startAttempt(task.id);
  const attempt = tasks.listAttemptsByTask(task.id)[0];
  assert.equal(attempt.status, "running");

  recovery.reconcileInterruptedTasks();

  const attempts = tasks.listAttemptsByTask(task.id);
  assert.equal(attempts.length, 1, "the attempt stays as history, not deleted");
  assert.equal(attempts[0].status, "failed", "it ended abnormally, not by a user stop");
  // Ready to run again without losing the earlier run.
  assert.equal(db.getTask(task.id).status, "pending");
});

test("reconcile only touches Tasks that are actually running", () => {
  const project = ws();
  const done = tasks.createTask({ workspace: project, title: "Done" });
  tasks.setTaskStatus(done.id, "completed");
  const pending = tasks.createTask({ workspace: project, title: "Waiting" });

  const reconciled = recovery.reconcileInterruptedTasks();
  assert.equal(reconciled, 0, "nothing running here");
  assert.equal(db.getTask(done.id).status, "completed", "a completed Task is untouched");
  assert.equal(db.getTask(pending.id).status, "pending", "a pending Task is untouched");
});

test("reconcile is global across projects", () => {
  const pa = ws();
  const pb = ws();
  const ta = tasks.createTask({ workspace: pa, title: "A stuck" });
  const tb = tasks.createTask({ workspace: pb, title: "B stuck" });
  tasks.startAttempt(ta.id);
  tasks.startAttempt(tb.id);

  const reconciled = recovery.reconcileInterruptedTasks();
  assert.equal(reconciled, 2, "both projects' running Tasks are cleared");
});

test("restart-resume defaults off and can be toggled (Phase 8/§13)", () => {
  assert.equal(recovery.taskLoopResumeEnabled(), false, "default is disabled");
  recovery.setTaskLoopResumeEnabled(true);
  assert.equal(recovery.taskLoopResumeEnabled(), true);
  recovery.setTaskLoopResumeEnabled(false);
  assert.equal(recovery.taskLoopResumeEnabled(), false);
});

test("recoverQueuedLoopsAfterRestart clears a stale loop flag when resume is off", () => {
  const project = ws();
  // A loop that was running before the crash: its only record is the setting.
  db.putSetting(`taskLoop:${project}`, JSON.stringify({ running: true, currentTask: null }));
  assert.ok(
    Object.keys(db.settingValuesWithPrefix("taskLoop:")).some((k) => k.endsWith(project)),
    "the stale flag is recognised as an active loop",
  );

  // Default off: the loop is NOT resumed, its flag is cleared so memory matches.
  recovery.recoverQueuedLoopsAfterRestart();
  const stored = db.getSetting(`taskLoop:${project}`);
  assert.deepEqual(JSON.parse(stored ?? ""), { running: false, currentTask: null });
});

test("deleteTasksByWorkspace cascades a Project's Tasks and their attempts", () => {
  const project = ws();
  const task = tasks.createTask({ workspace: project, title: "Cascade" });
  tasks.startAttempt(task.id, "session-x");
  tasks.finishAttempt(tasks.listAttemptsByTask(task.id)[0].id, "stopped");

  db.deleteTasksByWorkspace(project);
  assert.deepEqual(db.listTasksByWorkspace(project), [], "the Tasks are gone");
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ?").get(task.id).n,
    0,
  );
});
