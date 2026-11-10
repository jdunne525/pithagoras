import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { inProcessHome } from "./server-harness.mjs";

// What the queue loop is for, and the state it was read breaking.
//
// A queue runs one Task at a time, in the order the person put them, and it must
// finish the Task it took before anything else is begun. Two shapes of "not
// finished" were read on the machine across a night of Tasks in BlastRunHero, and
// both of them answered with a Task after the present one being started over it.
//
// The one seen most: a Task's run ending, and its outcome being judged. `finishSettled`
// takes the run out of the registry the moment the run ends, because nothing is
// going any more, and only then reads the transcript to decide complete-or-failed
// — a bounded read, but a window all the same, and through it the Task and its
// attempt still say working. At 13:10:09 a Task's fifth attempt settled its
// session, at 13:10:21 that attempt was written settled, and at 13:10:11, inside
// that window, the loop of another Project started a fresh Task: a next Task begun
// over a present one that was not done. The gate every loop reads answered with
// nothing live.
//
// The other: a Task marked running that the loop walked past. The walk took the
// first pending Task, so anything the person queued behind a running one — a
// crash's Task, a run whose outcome had not been written — could be started beside
// it, and the same Task was reached again in a brand-new session while the old one
// still had work in hand.
//
// Neither state is work the loop may start beside. A Task that is running is the
// present one, and it is waited for; a Task that errored out is settled back to
// pending with its runs kept as history, which makes it the first Task not
// finished again, so the loop runs that same Task and not the one behind it. A
// Task that cannot be run at all — failed at its budget, or stopped by hand —
// still cannot be bypassed, and the loop stalls until the person intervenes.

const home = inProcessHome("pithagoras-task-queue-order-");
const project = (name) => {
  const p = path.join(home, name);
  mkdirSync(p, { recursive: true });
  return p;
};

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const execution = await import("../dist/task-execution.js");
const queue = await import("../dist/task-queue.js");
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
  /** Whether a run is going; the manager asks before settling a prompt. */
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
  /**
   * Where the run ends: the last answer, and how the model stopped. `error` with
   * the words pi writes for a request it stopped mid-run is a compaction's cut;
   * anything else is the run reaching its own end — which the completion check
   * then judges, and an end that did not write the promise is not a Task that is
   * done.
   */
  async end(stopReason = "stop", errorMessage) {
    this.emit(
      "event",
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason,
          ...(errorMessage ? { errorMessage } : {}),
          content: [{ type: "text", text: stopReason === "error" ? "" : "all of it" }],
        },
      },
    );
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_end", willRetry: false });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
}

/** Every pi started, in order, and the fake behind each session. */
const started = [];
const pis = new Map();
SdkPiClient.create = async (opts) => {
  started.push(opts.sessionId);
  const pi = new FakePi(opts);
  pis.set(opts.sessionId, pi);
  return pi;
};

/** The Task a session was started for: the attempt row that names it. */
const taskOf = (sessionId) =>
  db.getDb().prepare("SELECT task_id FROM task_attempts WHERE session_id = ?").get(sessionId)?.task_id;

/** Lets the fire-and-forget run path reach pi and the watcher see what came. */
const flush = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` answers, saying whether it did before the limit. */
async function until(check, limitMs = 30_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A Task in a folder of its own: what the queue runs, and the watcher watches. */
let count = 0;
const task = (ws) => tasks.createTask({ title: `tq${++count}`, workspace: ws });

/** Unwinds what a test left running, without judging it: an end of a test would
 *  otherwise start another outcome read, and the harness closes the database
 *  after the last test while that read is still going. */
async function endRunning() {
  for (const sessionId of [...started]) execution.abortLiveRun(taskOf(sessionId));
  await flush(500);
}

function reset() {
  started.length = 0;
  pis.clear();
  sessions.inRun.clear();
  sessions.compactionInterruptedRun.clear();
  sessions.compactionResumePending.clear();
  sessions.cutOffResumePending.clear();
  sessions.cutOffCarries.clear();
  sessions.cutOffAnswer.clear();
  sessions.lastStopReason.clear();
  sessions.modelOutputLimit.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
}

test("a queue waits through the moment a run's outcome is being judged, and runs that same Task again", async () => {
  const ws = project("one");
  const first = task(ws);
  const second = task(ws);
  queue.startLoop(ws);
  try {
    // The loop's first poll takes the first Task of the Project.
    assert(await until(() => started.length === 1), "the queue started a Task");
    const sessionId = started[0];
    assert.equal(taskOf(sessionId), first.id, "and it was the first Task, in queue order");
    const at = () => pis.get(sessionId);

    // The work happens and the run reaches its own end, without the completion
    // promise: the outcome is now being decided, and that is a window.
    await at().turn();
    await at().end("stop");

    // The read is bounded (its own first wait, then its cap) and this is well
    // inside it: the attempt is still open and the Task still says working.
    await flush(3000);
    assert.equal(execution.hasLiveTaskRun(), true, "the gate every queue reads holds across the judgement: work is still in hand");
    assert.deepEqual([...started], [sessionId], "nothing else was started across it, in this Project or anywhere");
    assert.equal(db.getTask(first.id).status, "running", "the present Task still says working: it is not done");
    assert.equal(db.getTask(second.id).status, "pending", "the Task behind it was not taken over the present one");

    // The judgement finishes: the attempt is written settled as failed — no
    // promise came — and the Task goes back onto the queue for another run.
    const attempt = tasks.listAttemptsByTask(first.id)[0];
    assert(await until(() => db.getAttempt(attempt.id).status !== "running"), "the attempt is settled at the end of the run");
    assert.equal(db.getAttempt(attempt.id).status, "failed", "an end that did not carry the completion promise is not read as done");
    assert.equal(execution.hasLiveTaskRun(), false, "the gate opens the moment the present Task's outcome is written");
    assert.equal(db.getTask(first.id).status, "pending", "and the errored Task is back on the queue with its run kept as history");

    // The queue's next answer is that same Task, not the one behind it.
    assert(await until(() => started.length === 2), "the queue started another run");
    assert.equal(taskOf(started[1]), first.id, "the Task run again is the present one");
    assert.equal(tasks.listAttemptsByTask(first.id).length, 2, "as its next attempt, its first run kept");
    assert.deepEqual(tasks.listAttemptsByTask(second.id), [], "the Task behind it was never reached");
    assert.equal(db.getTask(second.id).status, "pending", "and is still waiting its turn");
  } finally {
    queue.stopLoop(ws);
    await endRunning();
    await reset();
  }
});

test("no loop takes a Task across the moment another Project's run is being judged", async () => {
  const a = project("a");
  const b = project("b");
  const firstOfA = task(a);
  const other = task(b);
  queue.startLoop(a);
  queue.startLoop(b);
  try {
    // One agent at a time: whichever loop polls first takes a Task, and the
    // other waits while that run is going.
    assert(await until(() => started.length === 1), "a queue started a Task");
    assert.equal(taskOf(started[0]), firstOfA.id, "and it was the first Project's");
    const at = () => pis.get(started[0]);

    await at().turn();
    await at().end("stop");
    await flush(3000);

    // The other Project's loop polled inside this window: nothing it took was
    // waited for by the gate before, which is what began a Task over a present
    // one that was not done.
    assert.equal(execution.hasLiveTaskRun(), true, "the gate holds while a run's outcome is being judged");
    assert.deepEqual([...started], [started[0]], "no loop of any Project took a Task across it");
    assert.equal(db.getTask(other.id).status, "pending", "another Project's Task was not started beside it");
    assert.deepEqual(tasks.listAttemptsByTask(other.id), [], "and it never reached the engine");
  } finally {
    queue.stopLoop(a);
    queue.stopLoop(b);
    await endRunning();
    await reset();
  }
});

test("a Task marked running is waited for, never passed over for one behind it", async () => {
  const ws = project("two");
  const first = task(ws);
  const second = task(ws);
  // A Task left marked running with its run not in hand: the state a Task reads
  // through the judgement of an end, and the state a Task was found in when a
  // process took its run with it. The walk of the queue must not reach past it.
  tasks.startAttempt(first.id);
  queue.startLoop(ws);
  try {
    // Past several of the loop's own polls (two seconds each).
    await flush(8000);
    assert.deepEqual([...started], [], "the loop waited on the present Task instead of starting one behind it");
    assert.equal(db.getTask(second.id).status, "pending", "the Task behind it was not taken");
    assert.equal(db.getTask(first.id).status, "running", "the present Task is left as it reads, and the loop does not answer for it");

    // The present Task is answered the way an errored run is: back onto the
    // queue, its runs kept. It is now the first Task not finished.
    tasks.setTaskStatus(first.id, "pending");
    assert(await until(() => started.length === 1), "the queue started a run");
    assert.equal(taskOf(started[0]), first.id, "and it is that same Task, not the one behind it");
    assert.equal(tasks.listAttemptsByTask(second.id).length, 0, "nothing of the Task behind it was opened");
  } finally {
    queue.stopLoop(ws);
    await endRunning();
    await reset();
  }
});
