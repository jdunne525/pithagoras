import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a Task does when a compaction catches its run mid-turn: the session
// reads idle twice around the compaction — while the aborted turn unwinds, and
// again before the resume that carries the turn on starts its own run. Neither
// idle is the run's end. The queue loop must not hand the room to another
// session across that gap (two Tasks running at once), and the Task's own
// completion watcher must not settle the attempt on it.

const home = inProcessHome("pithagoras-compaction-gap-");
mkdirSync(path.join(home, "work"), { recursive: true });

const { createSession, eventsSince, getSession, getDb, setSingleActiveSession } = await import("../dist/db.js");
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
  /** The chat's own auto-compaction switch, which pi has too. */
  autoCompaction = true;
  async setAutoCompaction(enabled) {
    this.autoCompaction = enabled;
  }
  async shutdown() {}
  dispose() {}
  /** Accepting a message starts a run of its own, as pi's does. */
  async prompt(message) {
    this.prompts.push(message);
    this.idle = false;
    this.emit("event", { type: "agent_start" });
    return { outcome: "started" };
  }
  /** The end of a run: pi says so, and the session goes idle. */
  settle() {
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
  const id = `cg${++count}`;
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
  sessions.compactionFailures.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
}

test("the room stays held from the compaction's end until its resume lands", async () => {
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

    // A compaction catches A's run mid-turn...
    aPi.emit("event", { type: "compaction_start", reason: "threshold" });
    assert.equal(sessions.compactionInterruptedRun.has(a), true, "the compaction caught the run");
    assert.equal(sessions.isActive(a), true, "and the session still holds the room");

    // ...it ends, and pi will not resume the turn itself: the marker is handed
    // to the resume-pending one in the same breath, so the session is still
    // active and still mid-compaction.
    aPi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false });
    assert.equal(sessions.compactionInterruptedRun.has(a), false, "the compaction itself is over");
    assert.equal(sessions.compactionResumePending.has(a), true, "the gap is marked");
    assert.equal(sessions.isActive(a), true, "the session still holds the room");
    assert.equal(sessions.isCompacting(a), true, "and is not read as ended");

    // The aborted run settles right there, marking the session idle.
    aPi.settle();
    assert.equal(sessions.inRun.has(a), false, "the aborted run settled");
    assert.equal(getSession(a).status, "idle", "the session reads idle in the gap");
    assert.equal(sessions.isActive(a), true, "the idle session still holds the room");
    assert.equal(sessions.isCompacting(a), true, "and is not read as ended");

    await flush();
    assert.deepEqual(started, [a], "B did not take the room in the gap");
    assert.equal(sessions.singleActiveQueue.length, 1, "B is still waiting");

    // The resume lands and carries the turn on; its run holds the room from here.
    assert.deepEqual(
      aPi.prompts,
      ["work on A", "Compaction detected, resume where you left off if needed."],
      "the resume went to A",
    );
    assert.equal(sessions.inRun.has(a), true, "the resumed run holds the room");
    assert.equal(sessions.compactionResumePending.has(a), false, "the gap is over");
    assert.deepEqual(started, [a], "still only A at the engine");

    // Only the resumed turn's own end hands the room over.
    aPi.settle();
    await flush();
    assert.deepEqual(started, [a, b], "B starts once A's resumed turn has truly ended");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");
  } finally {
    reset();
  }
});

test("a compaction pi resumes itself keeps holding the room", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    assert.deepEqual(started, [a]);
    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "B waits");

    // pi resumes the turn itself (overflow recovery): no resume message of ours,
    // and the run never settled, so nothing hands the room over mid-way.
    aPi.emit("event", { type: "compaction_start", reason: "overflow" });
    aPi.emit("event", { type: "compaction_end", reason: "overflow", willRetry: true });
    assert.equal(sessions.compactionResumePending.has(a), false, "no resume of ours is coming");
    assert.equal(sessions.isActive(a), true, "the run still holds the room");

    await flush();
    assert.deepEqual(started, [a], "B did not start mid-compaction");

    aPi.emit("event", { type: "agent_start" });
    aPi.settle();
    await flush();
    assert.deepEqual(started, [a, b], "B starts once the run has ended");
  } finally {
    reset();
  }
});

// From pi 1.2 the session is busy from the moment a run starts preparing, and
// from pi 1.5 an auto-compaction at a turn boundary is followed by pi's own
// next turn of that same run: the portal's "the compaction ended and pi will
// not resume the turn" is read as an unfinished turn, and the resume it sends
// lands in a run that is going — queued, and answered as an order to work on.
// BlastRunHero answered "Compaction detected, resume where you left off"
// forty-four times in one day and never finished. What the portal may do is
// carry a turn on that nothing else will, and say what a failing compaction
// leaves the chat with.

test("a compaction pi carries on itself gets no resume of ours", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    // Auto-compaction at a turn boundary: the run does not end, and pi's next
    // turn of it follows in the same breath compaction_end says it will retry
    // nothing.
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "s" } });
    assert.equal(sessions.compactionResumePending.has(a), true, "the gap is marked until it is known");
    pi.emit("event", { type: "turn_start" });
    assert.equal(sessions.compactionResumePending.has(a), false, "the turn carried on: nothing to resume");

    pi.settle();
    await flush();
    assert.deepEqual(pi.prompts, ["work on A"], "no resume was sent into the carried-on turn");
  } finally {
    reset();
  }
});

test("a run pi stops for a mid-turn compaction is carried on at its end", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    // A manual compaction of a running chat: pi aborts the run, compacts, and
    // the run settles. The turn is in nobody's hands, so the resume waits for
    // that settle rather than landing in the middle of it.
    pi.emit("event", { type: "compaction_start", reason: "manual" });
    pi.emit("event", { type: "compaction_end", reason: "manual", willRetry: false, result: { summary: "s" } });
    assert.deepEqual(pi.prompts, ["work on A"], "nothing sent while the run was still winding down");
    assert.equal(sessions.compactionResumePending.has(a), true, "the gap is marked, and holds the room");

    pi.settle();
    await flush();
    assert.deepEqual(pi.prompts, ["work on A", "Compaction detected, resume where you left off if needed."], "carried on once the run had ended");
  } finally {
    reset();
  }
});

test("compactions that keep failing are said, and stop being attempted", async () => {
  const notices = (id) =>
    eventsSince(id)
      .map((r) => ({ type: r.type, payload: JSON.parse(r.payload) }))
      .filter((r) => r.type === "portal_notice");

  try {
    setSingleActiveSession(false);
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    // The shape pi 1.4 reports when the summary it asked the model to write
    // stopped in the middle for want of room: no result, and its own text.
    const failed = {
      type: "compaction_end",
      reason: "threshold",
      willRetry: false,
      errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete. Compaction stopped: 185932 > 119072.",
    };

    // The first failure is said, not acted on: one summary can fail for a
    // provider that was having a bad minute.
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "s" } });
    assert.equal(notices(a).length, 0, "a compaction that worked says nothing");

    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", ...failed });
    assert.equal(notices(a).length, 1, "the failure is said");
    assert.equal(pi.autoCompaction, true, "one failure of thirty is not the chat's to decide on");

    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", ...failed });
    // The switch-off line follows the call that asks pi for it, so it lands a
    // moment after the failure it explains.
    await flush();
    const after = notices(a);
    assert.equal(after.length, 3, "the failure, and the switch off, each said");
    assert.equal(pi.autoCompaction, false, "the chat stops paying minutes for attempts that cannot work");
    assert.equal(after[1].payload.text, "Auto-compaction failed: the summary did not fit in what the model can write in one answer, so nothing was compacted.");
    assert.match(after[2].payload.text, /Auto-compaction is off for this chat after failing twice in a row/);

    // A chat whose compactions work again is a chat left to itself.
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "s" } });
    assert.equal(sessions.compactionFailures.has(a), false, "the count starts afresh");
    assert.equal(pi.autoCompaction, false, "the chat's own switch is the person's to turn back");
  } finally {
    reset();
  }
});
