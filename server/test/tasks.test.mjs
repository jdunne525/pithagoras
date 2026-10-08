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

test("there is no per-task max attempts; the budget is server-wide (Phase 5)", () => {
  // max_attempts is one server-wide default, not stored per Task. Passing it to
  // create or edit is simply ignored.
  assert.throws(() => tasks.createTask({ workspace: ws("v"), title: "" }), /title/);
  const task = tasks.createTask({ workspace: ws("v"), title: "x", maxAttempts: 99 });
  assert.equal(task.max_attempts, null, "no per-Task value is stored");
  const edited = tasks.editTask(task.id, { title: "renamed", maxAttempts: 42 });
  assert.equal(edited.title, "renamed");
  assert.equal(edited.max_attempts, null, "editing does not set a per-Task ceiling");
});

test("rerun resets a task to pending without starting it (Phase 5)", () => {
  const task = tasks.createTask({ workspace: ws("r"), title: "fail me" });
  tasks.startAttempt(task.id);
  assert.equal(tasks.getTask(task.id).status, "running");
  // Rerun cannot fire while a run is live.
  assert.throws(() => tasks.rerunTask(task.id), /running/);
  // Settle the attempt and mark the task failed, then Rerun.
  const attempt = tasks.listAttemptsByTask(task.id)[0];
  tasks.finishAttempt(attempt.id, "failed");
  tasks.setTaskStatus(task.id, "failed");
  const reset = tasks.rerunTask(task.id);
  assert.equal(reset.status, "pending", "Rerun returns it to the queue");
  assert.equal(reset.completed_at, null, "the terminal marker is cleared");
  assert.equal(reset.attempts, 0, "the spent budget is cleared for a fresh run");
  assert.equal(db.lastAttemptNumber(task.id), 1, "no fresh attempt row is opened");
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

test("tasks are queued in order by a persisted slot", () => {
  const project = ws();
  const a = tasks.createTask({ workspace: project, title: "One" });
  const b = tasks.createTask({ workspace: project, title: "Two" });
  const c = tasks.createTask({ workspace: project, title: "Three" });
  const queue = tasks.listTasks(project);
  assert.deepEqual(queue.map((t) => t.id), [a.id, b.id, c.id], "creation order is the queue order");
  assert.deepEqual(queue.map((t) => t.position), [1, 2, 3], "each takes one past the highest slot");
});

test("setTaskOrder rewrites the queue order and keeps projects separate", () => {
  const pa = ws();
  const pb = ws();
  const a1 = tasks.createTask({ workspace: pa, title: "A1" });
  const a2 = tasks.createTask({ workspace: pa, title: "A2" });
  const b1 = tasks.createTask({ workspace: pb, title: "B1" });

  tasks.setTaskOrder(pa, [a2.id, a1.id]);
  assert.deepEqual(tasks.listTasks(pa).map((t) => t.id), [a2.id, a1.id], "the new order wins");
  assert.deepEqual(tasks.listTasks(pa).map((t) => t.position), [1, 2], "positions are reassigned 1..n");
  assert.deepEqual(tasks.listTasks(pb).map((t) => t.id), [b1.id], "other projects are untouched");
  assert.throws(() => tasks.setTaskOrder(pa, [a1.id, "not-a-task"]), /unknown/, "ids must belong to this project");
});

test("a task is named from its prompt when no title is given", () => {
  assert.equal(
    tasks.createTask({ workspace: ws(), description: "Summarise the discussion" }).title,
    "Summarise the discussion",
  );
  // The first line only, collapsed to one line — exactly like a chat title.
  const multi = tasks.createTask({ workspace: ws(), description: "Line one\nline two" }).title;
  assert.equal(multi, "Line one");
  // A prompt that starts with a slash is not a name, so nothing is derived.
  assert.throws(() => tasks.createTask({ workspace: ws(), description: "/clear this up" }), /prompt/);
  // An explicit title wins over the prompt.
  assert.equal(
    tasks.createTask({ workspace: ws(), title: "Chosen", description: "ignored prompt" }).title,
    "Chosen",
  );
});

test("editing only the description re-names the task from its first line, clipped", () => {
  const project = ws();
  const task = tasks.createTask({ workspace: project, title: "Old name", description: "First line of the work\ndetails below" });
  assert.equal(task.title, "Old name");
  // Sending just a description updates the content and re-derives the name,
  // like creation does — no explicit title means "name it from the prompt".
  const edited = tasks.editTask(task.id, { description: "A brand new job\nmore notes" });
  assert.equal(edited.description, "A brand new job\nmore notes");
  assert.equal(edited.title, "A brand new job", "the title follows the new first line");
  // A long first line clips exactly as a chat title does.
  const long = tasks.editTask(task.id, { description: "y".repeat(80) }).title;
  assert.equal(long, "y".repeat(47) + "…");
  // An explicit title still wins over the derived one.
  const chosen = tasks.editTask(task.id, { title: "Chosen", description: "ignored body" });
  assert.equal(chosen.title, "Chosen");
  // A first line that cannot be named leaves the old title rather than dropping the edit.
  const unnamed = tasks.editTask(task.id, { description: "/clear this up" });
  assert.equal(unnamed.title, "Chosen");
  assert.equal(unnamed.description, "/clear this up");
});

test("a task title clips from the prompt the same way a chat title does", () => {
  const long = "x".repeat(80);
  assert.equal(tasks.createTask({ workspace: ws(), description: long }).title, "x".repeat(47) + "…");
});

test("creating without any title or prompt is rejected", () => {
  assert.throws(() => tasks.createTask({ workspace: ws() }), /prompt/);
});
