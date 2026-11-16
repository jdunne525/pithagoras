import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// A Task's chat resumed after the server went away.
//
// What notices a Task's run reaching its end is a watcher held in the execution
// module's memory, and a restart takes memory with it. The chat does not lose its
// Task — the attempt row that points at it is in the database — but nothing read
// that back, so the person who sent a line into an interrupted chat got the work
// carried on in the same conversation and watched it finish, while the Task above
// it still read what startup recovery had left it: pending, or failed. Nothing
// closed it, because nothing was listening for that run (a night of Tasks in
// BlastRunHero, each of its chats resumed by hand and none of its Tasks marked
// done over a marker the chat had printed).
//
// So a message that starts a run in a chat this server never registered is read
// back from its attempt row: the Task and a new attempt of it go running on that
// same conversation, the brief is written again so the resumed run is told the
// marker it ends on, and the end is judged as any other run's is. An ordinary chat
// has no attempt against it and is left alone; a child chat works under the run
// that made it and is not an attempt of its own either.

const home = inProcessHome("pithagoras-task-resume-");
mkdirSync(path.join(home, "work"), { recursive: true });

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const execution = await import("../dist/task-execution.js");
const recovery = await import("../dist/task-recovery.js");
const briefs = await import("../dist/task-brief.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
test.after(() => db.getDb().close());

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionFile = path.join(opts.sessionDir ?? ".", "conversation.jsonl");
  }
  idle = true;
  prompts = [];
  isIdle() {
    return this.idle;
  }
  dialogsOpen() {
    return 0;
  }
  async getTools() {
    return [];
  }
  async getCommands() {
    return [];
  }
  async getState() {
    return {
      model: { id: "m", name: "M", provider: "p", contextWindow: 131_072, maxTokens: 16_384, input: ["text"] },
      thinkingLevel: "off",
    };
  }
  async abort() {}
  async shutdown() {}
  dispose() {}
  /** Accepting a message starts a run of its own, as a real pi's does. */
  async prompt(message) {
    this.prompts.push(message);
    this.idle = false;
    this.emit("event", { type: "agent_start" });
    return { outcome: "started" };
  }
  /** One turn of work: an answer that went on asking for tools. */
  async turn() {
    this.emit("event", { type: "turn_start" });
    this.emit(
      "event",
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "working" }] } },
    );
    this.emit("event", { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} });
    this.emit("event", { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [] } });
    this.emit("event", { type: "message_end", message: { role: "toolResult", content: [] } });
    this.emit("event", { type: "turn_end" });
  }
  /** The run reaching its own end, with `text` as its last answer. */
  async end(text = "all of it") {
    this.emit(
      "event",
      { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } },
    );
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_end", willRetry: false });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
}

/** The marker a Task finishes on, on its own line. */
const MARKER = "<PROMISE>THIS TASK IS DONE</PROMISE>";

/** Every pi started, in order, and the fake behind each session. */
const started = [];
const pis = new Map();
SdkPiClient.create = async (opts) => {
  started.push(opts.sessionId);
  const pi = new FakePi(opts);
  pis.set(opts.sessionId, pi);
  return pi;
};

/** Lets the fire-and-forget run path reach pi and the watcher see what came. */
const flush = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for an attempt to be written as settled. The completion check reads the
 * transcript with its own bounded waits before it decides, so a settled attempt
 * comes some time after the end that decided it; the limit is past that.
 */
async function settled(attemptId, limitMs = 12_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const row = db.getAttempt(attemptId);
    if (row && row.status !== "running") return row;
    if (Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
}

let count = 0;
const work = () => path.join(home, "work");

/** A chat of its own, as the sidebar lists them. */
function chat(parentId = null) {
  const id = `tresume${++count}`;
  db.createSession({
    id,
    title: id,
    workspace: work(),
    executor: "host",
    kind: "task",
    ...(parentId ? { parent_id: parentId } : {}),
  });
  return id;
}

/**
 * A Task whose run went in a chat of its own and whose server died mid-run: what
 * the next start finds. Nothing of it is in this process's memory, which is the
 * whole point of the test — the Task is only ever reachable from the database.
 */
function interruptedRun(status = "running") {
  const t = tasks.createTask({ title: `tr${++count}`, workspace: work() });
  const sessionId = chat();
  const { attempt } = tasks.startAttempt(t.id, sessionId);
  db.updateSession(sessionId, { status: "interrupted" });
  if (status !== "running") {
    tasks.finishAttempt(attempt.id, status);
    tasks.setTaskStatus(t.id, status);
  }
  return { task: t, sessionId, attempt };
}

/** What startup recovery makes of a run that died with the previous server. */
function restart({ task, attempt }) {
  recovery.reconcileInterruptedTasks();
  assert.equal(db.getAttempt(attempt.id).status, "failed", "the dead attempt is written as it ended: abnormally");
  assert.equal(db.getTask(task.id).status, "pending", "the Task is back on the queue, not left working");
}

/** The attempt a resume opened, newest first. */
const resumedAttempt = (taskId) => tasks.listAttemptsByTask(taskId).at(-1);

/**
 * Waits for the queue's gate to open. An attempt is written before its run's
 * outcome is released from the gate, so the gate opens just after the row does.
 */
async function gateOpen(limitMs = 5_000) {
  const deadline = Date.now() + limitMs;
  while (execution.hasLiveTaskRun() && Date.now() < deadline) await flush(100);
  return execution.hasLiveTaskRun();
}

test.afterEach(async () => {
  // Whatever this test left going is ended, and its outcome waited for, so no
  // test reads the queue's gate over another test's work still hanging open.
  for (const pi of pis.values()) if (!pi.idle) await pi.end("nothing more");
  const deadline = Date.now() + 15_000;
  while (execution.hasLiveTaskRun() && Date.now() < deadline) await flush(200);

  sessions.inRun.clear();
  sessions.compacting.clear();
  sessions.compactionInterruptedRun.clear();
  sessions.compactionResumePending.clear();
  sessions.cutOffResumePending.clear();
  sessions.cutOffCarries.clear();
  sessions.cutOffAnswer.clear();
  sessions.lastStopReason.clear();
  sessions.modelOutputLimit.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
  started.length = 0;
  pis.clear();
});

test("the Task a chat belongs to outlives the server: read from the attempt that ran in it", () => {
  const { task, sessionId } = interruptedRun();
  assert.deepEqual(
    db.taskRunOf(sessionId),
    { taskId: task.id, attemptId: tasks.listAttemptsByTask(task.id)[0].id },
    "the chat still says which Task it was made for",
  );
  assert.equal(db.taskRunOf(chat()), undefined, "a chat nobody ran a Task in says nothing");
});

test("a chat resumed after a restart is taken up as its Task's run again", async () => {
  const run = interruptedRun();
  const { task, sessionId } = run;
  restart(run);
  assert.equal(briefs.briefExists(sessionId), false, "recovery took the dead attempt's brief with it");

  await sessions.prompt(sessionId, "resume where you left off");
  await flush(200);

  const attempt = resumedAttempt(task.id);
  assert.equal(attempt.session_id, sessionId, "the resumed run works in the same conversation, not a new one");
  assert.equal(attempt.attempt_number, 2, "it is the Task's next attempt");
  assert.equal(attempt.status, "running", "and it is open");
  assert.equal(db.getTask(task.id).status, "running", "the Task reads working again, not pending");
  assert.equal(db.getSession(sessionId).status, "running", "the chat is working");
  assert.equal(execution.hasLiveTaskRun(), true, "the queue's gate says work is in hand: no next Task is started");
  assert.ok(briefs.briefExists(sessionId), "the resumed run has its brief back, so it is told how to finish");
  assert.match(readFileSync(briefs.briefFileOf(sessionId), "utf8"), /Attempt 2 of up to 5/, "as this attempt");
  assert.deepEqual([...new Set(started)], [sessionId], "one engine, and it is this chat's");
});

test("a resumed run that ends on the completion marker closes its Task", async () => {
  const run = interruptedRun();
  const { task, sessionId } = run;
  restart(run);

  await sessions.prompt(sessionId, "finish it");
  await flush(200);
  const attempt = resumedAttempt(task.id);

  await pis.get(sessionId).turn();
  await pis.get(sessionId).end(`everything is committed.\n\n${MARKER}`);
  await settled(attempt.id);

  assert.equal(db.getAttempt(attempt.id).status, "completed", "the marker decides the attempt");
  assert.equal(db.getTask(task.id).status, "completed", "and closes the Task above it");
  assert.ok(db.getTask(task.id).completed_at, "with when it closed");
  assert.equal(briefs.briefExists(sessionId), false, "the attempt's brief goes with the attempt");
  assert.equal(await gateOpen(), false, "and the queue's gate opens again");
});

test("a resumed run that ends without the marker leaves the Task where the resume found it", async () => {
  // A Task stopped by hand, its chat resumed to keep working in it. An end with
  // no marker is not the queue's to answer: putting a Task the person stopped
  // back on the queue would have a loop begin it in a brand-new session beside
  // the chat they were just working in.
  const run = interruptedRun("stopped");
  const { task, sessionId } = run;
  assert.equal(db.getTask(task.id).status, "stopped");

  await sessions.prompt(sessionId, "one more look");
  await flush(200);
  const attempt = resumedAttempt(task.id);
  assert.equal(db.getTask(task.id).status, "running", "working while the resumed run goes");

  await pis.get(sessionId).end("not finished yet");
  await settled(attempt.id);

  assert.equal(db.getAttempt(attempt.id).status, "failed", "no marker, so the attempt is not a completed one");
  assert.equal(db.getTask(task.id).status, "stopped", "back where the resume found it, not onto the queue");
});

test("a resumed run whose Task had been sent back to the queue stays on it", async () => {
  const run = interruptedRun();
  const { task, sessionId } = run;
  restart(run);

  await sessions.prompt(sessionId, "keep going");
  await flush(200);
  const attempt = resumedAttempt(task.id);

  await pis.get(sessionId).end("still working");
  await settled(attempt.id);

  assert.equal(db.getAttempt(attempt.id).status, "failed");
  assert.equal(db.getTask(task.id).status, "pending", "a Task that was queued again is queued again after a resume that did not finish");
});

test("an ordinary chat resumed opens no attempt and touches no Task", async () => {
  const sessionId = chat();
  await sessions.prompt(sessionId, "hello");
  await flush(200);

  assert.equal(db.taskRunOf(sessionId), undefined, "nothing points at it");
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE session_id = ?").get(sessionId).n, 0);
  assert.equal(execution.hasLiveTaskRun(), false, "and no queue gate closes over it");
});

test("a child chat is not taken as an attempt of the Task its parent ran", async () => {
  const run = interruptedRun();
  const { task, sessionId } = run;
  restart(run);
  const child = chat(sessionId);

  await sessions.prompt(child, "work under the parent's run");
  await flush(200);

  assert.equal(db.taskRunOf(child), undefined, "a child has no attempt of its own");
  assert.equal(tasks.listAttemptsByTask(task.id).length, 1, "the Task's history is the run that died, not the child");
  assert.equal(db.getTask(task.id).status, "pending", "and the Task is not set working by a child's run");
});

test("a Task already completed is not reopened by a message in its chat", async () => {
  const { task, sessionId, attempt } = interruptedRun();
  tasks.finishAttempt(attempt.id, "completed");
  tasks.setTaskStatus(task.id, "completed");

  await sessions.prompt(sessionId, "and one more thing");
  await flush(200);

  assert.equal(tasks.listAttemptsByTask(task.id).length, 1, "no attempt of a completed Task");
  assert.equal(db.getTask(task.id).status, "completed", "a Task that is done stays done");
});

test("a resume whose line never reached pi leaves no attempt behind", async () => {
  const run = interruptedRun();
  const { task, sessionId } = run;
  restart(run);

  await sessions.prompt(sessionId, "resume");
  await flush(100);
  assert.equal(tasks.listAttemptsByTask(task.id).length, 2, "the resume opened its attempt");

  // What the chat path does when the line comes back as never sent — a Stop got
  // in front of it — is to hand back everything taken up for it.
  execution.abandonResumedRun(sessionId);

  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ?").get(task.id).n, 1, "only the run that died remains");
  assert.equal(db.getTask(task.id).status, "pending", "the Task is where the resume found it, with its count as it was");
  assert.equal(db.getTask(task.id).attempts, 0, "and it did not spend an attempt");
  assert.equal(briefs.briefExists(sessionId), false, "the brief written for it went with it");
  assert.equal(execution.hasLiveTaskRun(), false, "and nothing is watched in its name");
});

test("a Task whose dead run already wrote the marker is closed at startup, not queued again", () => {
  const { task, sessionId, attempt } = interruptedRun();
  db.appendEvent(sessionId, "message_end", {
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `done.\n\n${MARKER}` }] },
  });

  assert.equal(recovery.reconcileInterruptedTasks(), 1);
  assert.equal(db.getAttempt(attempt.id).status, "completed", "the run said it was finished before it died");
  assert.equal(db.getTask(task.id).status, "completed", "so the Task is closed rather than begun again from nothing");
});
