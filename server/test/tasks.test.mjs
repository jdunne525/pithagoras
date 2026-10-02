import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-tasks-"));
// A fresh throwaway project folder every call, so nothing leaks between tests.
const ws = () => {
  const w = path.join(home, "ws", randomUUID());
  mkdirSync(w, { recursive: true });
  return w;
};

// The database opens on first import using DATA_DIR, so point it at a throwaway
// folder before anything that touches db.js loads.
process.env.DATA_DIR = path.join(home, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");

test("a fresh database has the task tables and can create a task", () => {
  const d = db.getDb();
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM task_attempts").get().n, 0);

  const project = ws();
  const created = tasks.createTask({ workspace: project, title: "Fix the login bug" });
  assert.equal(created.title, "Fix the login bug");
  assert.equal(created.status, "pending");
  assert.equal(created.attempts, 0);
  assert.ok(created.id, "a random id was assigned");
  assert.equal(created.max_attempts, null, "unset means unbounded");
  assert.equal(created.workspace, project);
});

test("tasks are scoped to their project and editable/deletable", () => {
  const pa = ws("a");
  const pb = ws("b");
  const a = tasks.createTask({ workspace: pa, title: "A task" });
  const b = tasks.createTask({ workspace: pb, title: "B task" });

  assert.deepEqual(tasks.listTasks(pa).map((t) => t.id), [a.id]);
  assert.deepEqual(tasks.listTasks(pb).map((t) => t.id), [b.id], "each project sees only its own task");

  const edited = tasks.editTask(a.id, { title: "Renamed", description: "notes" });
  assert.equal(edited.title, "Renamed");
  assert.equal(edited.description, "notes");

  tasks.deleteTask(a.id);
  assert.equal(db.getTask(a.id), undefined, "the row is gone from the database");
  assert.deepEqual(tasks.listTasks(pa), [], "project a is now empty");
  assert.deepEqual(tasks.listTasks(pb).map((t) => t.id), [b.id], "project b untouched");
});

test("max_attempts is validated", () => {
  assert.throws(() => tasks.createTask({ workspace: ws("v"), title: "" }), /title/);
  assert.throws(() => tasks.createTask({ workspace: ws("v"), title: "x", maxAttempts: 0 }), /max_attempts/);
  assert.throws(() => tasks.createTask({ workspace: ws("v"), title: "x", maxAttempts: 2.5 }), /max_attempts/);
  const ok = tasks.createTask({ workspace: ws("v"), title: "capped", maxAttempts: 3 });
  assert.equal(ok.max_attempts, 3);
});

test("editing cannot change max_attempts while running, but edits freely otherwise", () => {
  const task = tasks.createTask({ workspace: ws("e"), title: "run", maxAttempts: 1 });
  tasks.startAttempt(task.id);
  assert.throws(() => tasks.editTask(task.id, { maxAttempts: 9 }), /running/);
  const edited = tasks.editTask(task.id, { title: "still going" });
  assert.equal(edited.title, "still going");
  assert.equal(edited.max_attempts, 1, "the running ceiling is kept");
});

test("starting an attempt is sequential and marks both running", () => {
  const task = tasks.createTask({ workspace: ws("s"), title: "Run twice", maxAttempts: 5 });

  const first = tasks.startAttempt(task.id);
  assert.equal(first.task.status, "running");
  assert.equal(first.task.attempts, 1);
  assert.equal(first.attempt.attempt_number, 1);
  assert.equal(first.attempt.status, "running", "the returned attempt reflects the update");
  assert.equal(first.attempt.session_id, null);
  assert.ok(first.task.started_at, "started_at is stamped");

  // A second attempt gets a new row and number; the first stays as history.
  const second = tasks.startAttempt(task.id, "session-two");
  assert.equal(second.task.attempts, 2);
  assert.equal(second.attempt.attempt_number, 2);
  assert.equal(second.attempt.session_id, "session-two");

  const attempts = db.listAttemptsByTask(task.id);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((a) => [a.attempt_number, a.status]),
    [
      [1, "running"],
      [2, "running"],
    ],
    "the earlier attempt is left intact as history",
  );
});

test("lifecycle stamps timestamps and lets an attempt end without the task", () => {
  const task = tasks.createTask({ workspace: ws("l"), title: "Stop it", maxAttempts: 2 });
  const attempt = tasks.startAttempt(task.id);

  const finished = tasks.finishAttempt(attempt.attempt.id, "stopped");
  assert.equal(finished.status, "stopped");
  assert.ok(finished.completed_at, "an attempt records when it ended");

  const stopped = tasks.setTaskStatus(task.id, "stopped");
  assert.equal(stopped.status, "stopped");
  assert.ok(stopped.completed_at, "a task settles into completed_at");
  assert.ok(stopped.started_at, "it keeps when it first started");

  // Rerun clears the marker so it can finish again, keeping the first start time.
  const pending = tasks.setTaskStatus(task.id, "pending");
  assert.equal(pending.completed_at, null);
  assert.equal(pending.started_at, stopped.started_at, "first start time is kept across reruns");
});
