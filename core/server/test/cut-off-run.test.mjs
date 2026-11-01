import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a Task does when the model ends a run out of output tokens in mid-answer
// ("length"): pi ends the run there, but the turn is not over — the answer was
// cut off mid-sentence. The session reads idle through the gap before the carry-on
// prompt resumes it, and that idle is not the run's end either: the queue loop
// must not hand the room to another session across it (two Tasks running at once),
// and the Task's own completion watcher must not settle the attempt on it. Last
// night in BlastRunHero one Task did exactly this four times over: each run ended
// with the model rambling to its 16,384-token output limit, the idle settled the
// attempt as failed, and a brand-new session started the Task again from nothing.

const home = inProcessHome("pithagoras-cut-off-");
mkdirSync(path.join(home, "work"), { recursive: true });

const { createSession, getSession, getDb, setSingleActiveSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
test.after(() => getDb().close());

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  constructor(opts) {
    super();
    this.sessionFile = path.join(opts.sessionDir, "conversation.jsonl");
  }
  running = true;
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
    return { model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off" };
  }
  async abort() {}
  async shutdown() {}
  dispose() {}
  /** Accepting a message starts a run of its own, as pi's does. */
  async prompt(message) {
    this.prompts.push(message);
    this.idle = false;
    this.emit("event", { type: "agent_start" });
    return { outcome: "started" };
  }
  /** The last message of a run, and how the model stopped: "length" is cut off. */
  end(stopReason = "stop") {
    this.emit(
      "event",
      { type: "message_end", message: { role: "assistant", stopReason } },
    );
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

/** A Task's session: autonomous, in a folder of its own that exists. */
let count = 0;
function chat() {
  const id = `co${++count}`;
  createSession({ id, title: id, workspace: path.join(home, "work"), executor: "host", kind: "task" });
  return id;
}

/** Lets the fire-and-forget run path reach pi and the queue reach its next item. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

/** One test's sessions do not leave another's room held. */
function reset() {
  started.length = 0;
  sessions.inRun.clear();
  sessions.compacting.clear();
  sessions.compactionInterruptedRun.clear();
  sessions.compactionResumePending.clear();
  sessions.cutOffResumePending.clear();
  sessions.cutOffCarries.clear();
  sessions.lastStopReason.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
}

const CARRY_ON = "Carry on where you left off. Your last answer was cut off at the model's output limit, mid-sentence, not at the end of the work.";

test("a run the model cut itself off on keeps its room and carries on", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    // A Task working, and a second one held behind it under the setting.
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    assert.deepEqual(started, [a], "A reached the engine");
    assert.equal(sessions.inRun.has(a), true, "A holds the room");

    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "B waits its turn");
    assert.deepEqual(started, [a], "B has not started");

    // The run ends with the model out of output tokens mid-answer.
    aPi.end("length");
    assert.equal(sessions.inRun.has(a), false, "the run settled");
    assert.equal(getSession(a).status, "idle", "the session reads idle in the gap");
    assert.equal(sessions.cutOffResumePending.has(a), true, "the gap is marked");
    assert.equal(sessions.isActive(a), true, "the idle session still holds the room");
    assert.equal(sessions.isCompacting(a), true, "and is not read as ended");

    await flush();
    assert.deepEqual(started, [a], "B did not take the room in the gap");
    assert.equal(sessions.singleActiveQueue.length, 1, "B is still waiting");

    // The carry-on lands in the same session: the work keeps its context.
    assert.deepEqual(aPi.prompts, ["work on A", CARRY_ON], "the carry-on went to A");
    assert.equal(sessions.inRun.has(a), true, "the carried-on run holds the room");
    assert.equal(sessions.cutOffResumePending.has(a), false, "the gap is over");
    assert.deepEqual(started, [a], "still only A at the engine");

    // Only the carried-on turn's own natural end hands the room over.
    aPi.end("stop");
    await flush();
    assert.deepEqual(started, [a, b], "B starts once the carried-on turn has truly ended");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");
  } finally {
    reset();
  }
});

test("a model that keeps hitting its output limit is carried on a bounded number of times", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();

    // Four cut-off ends in a row: the first three are carried on, the fourth is
    // left as an end, so a model rambling forever cannot keep the room open.
    for (let cutOffs = 1; cutOffs <= 4; cutOffs++) {
      aPi.end("length");
      await flush();
      const carried = aPi.prompts.filter((p) => p === CARRY_ON).length;
      assert.equal(carried, Math.min(cutOffs, 3), `carried on ${Math.min(cutOffs, 3)} time(s)`);
      if (cutOffs < 4) assert.deepEqual(started, [a], "B never started beside A");
    }
    assert.equal(sessions.cutOffResumePending.has(a), false, "the last idle let the room go");
    assert.equal(sessions.isActive(a), false, "A is done, out of carry-on budget");
    assert.deepEqual(started, [a, b], "B takes the room once A is truly done");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");
  } finally {
    reset();
  }
});
