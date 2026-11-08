import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
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

const { createSession, COMPACT_STOP_NOTICE, COMPACT_STOP_NO_MODEL, appendEvent, chatsWithCompactionOffByChoice, chatModel, clearCompactionStops, compactionStopWasAnswered, compactionStops, eventsSince, getSession, getDb, noteCompactionChoice, setSingleActiveSession, noteCompactionPlan, compactionPlanFor, portalCompactionPlans } = await import("../dist/db.js");
const { readCompactionSettings, writeCompactionSettings, writeCompactionModelRoom } = await import("../dist/pi-settings.js");
const { planForModel, planRoom, roomShapeFor, roomFaultFor } = await import("../dist/compaction-ladder.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
test.after(() => getDb().close());

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
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
    // A chat whose pi cannot say what it is running: a container's pi, an older one.
    if (noModel.has(this.sessionId)) return { model: { name: "M" }, thinkingLevel: "off", autoCompactionEnabled: this.autoCompaction };
    return {
      model: { id: "m", name: "M", provider: "p", input: ["text"], ...(knownSizes.get(this.sessionId) ?? {}) },
      thinkingLevel: "off",
      autoCompactionEnabled: this.autoCompaction,
    };
  }
  async abort() {}
  /**
   * The chat's own auto-compaction switch, which pi has too — and pi has exactly one of
   * it for every chat: `compaction.enabled` in its settings file, which is what every
   * chat reads at its start and at every reload. So a write here is a write to that
   * file, and a chat started after it takes whatever was last written.
   */
  autoCompaction = true;
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionFile = path.join(opts.sessionDir, "conversation.jsonl");
    // A chat started now is pi reading its file: the switch stands as the last write
    // left it, which is the damage the portal's stop did before it kept its own off.
    this.autoCompaction = readCompactionSettings().enabled;
  }
  async setAutoCompaction(enabled) {
    this.autoCompaction = enabled;
    await writeCompactionSettings({ enabled });
  }
  /** pi reading its own settings file: the switch in it lands on this chat, off included. */
  async refreshSettings() {
    this.autoCompaction = readCompactionSettings().enabled;
    this.reloads = (this.reloads ?? 0) + 1;
  }
  /**
   * How full a chat's context is, for the tests that read where a run ended.
   *
   * Only the chats a test has given a height are measured; the rest answer what pi
   * answers when it has not measured a context — nothing — and the line about a run
   * that ended at the wall of one stays silent for them, as it did before.
   */
  async getStats() {
    const at = wallAt.get(this.sessionId);
    if (at === undefined) return undefined;
    return { contextUsage: { percent: at, contextWindow: (knownSizes.get(this.sessionId) ?? {}).contextWindow } };
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
/** Chats whose pi cannot name its model. */
const noModel = new Set();
/** What each chat's pi reports its model's window and answer to be, for the tests that read a model's size. */
const knownSizes = new Map();
/** How full each chat's context is, for the tests that read where a run ended. */
const wallAt = new Map();
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
async function reset() {
  started.length = 0;
  sessions.inRun.clear();
  sessions.compacting.clear();
  sessions.compactionInterruptedRun.clear();
  sessions.compactionResumePending.clear();
  sessions.compactionFailures.clear();
  // Nor one test's line about a model whose numbers cannot work the next one's.
  sessions.compactionRoomSaid.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
  noModel.clear();
  knownSizes.clear();
  wallAt.clear();
  sessions.contextWallSaid.clear();
  // One test's stopped chats are not the next one's record.
  clearCompactionStops({});
  // Nor is one test's own switch on compaction the next one's.
  for (const id of chatsWithCompactionOffByChoice()) noteCompactionChoice(id, true);
  // And pi's file is left as a portal that has stopped nothing leaves it.
  await writeCompactionSettings({ enabled: true });
}

/** The chat's lines of its own, in order: what the portal said in it. */
const noticesOf = (id) =>
  eventsSince(id)
    .filter((r) => r.type === "portal_notice")
    .map((r) => String(JSON.parse(r.payload).text ?? ""));

/** pi 1.4's report when the summary it asked the model for stopped in the middle for want of room. */
const COMPACT_FAILED = {
  type: "compaction_end",
  reason: "threshold",
  willRetry: false,
  errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete. Compaction stopped: 185932 > 119072.",
};

/** Two failures in a row — what asks the portal to stop a chat's attempts. */
async function failCompactionTwice(pi) {
  for (let n = 0; n < 2; n++) {
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", ...COMPACT_FAILED });
    await flush();
  }
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
    await reset();
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
    await reset();
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
    await reset();
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
    await reset();
  }
});

// The same turn, from the other direction: the compaction is not pi's and not the
// person's, it is the portal's — the ladder's attempt at a summary the chat's own
// call could not write. pi stops the run for it exactly as it does for a manual
// compaction, but the settled line for that run is emitted *before* the compact's
// own start: the run reads over, and the chat reads idle, with the compaction still
// to come. Detected from the events alone, the marker would be a beat late — the
// Task watcher would settle the attempt on that idle and the queue would start a
// brand-new session for the same Task — which is what six chats in a row on one
// BlastRunHero brief did, each of them ending on a compaction that had worked.
// The mark, then, is made where the portal starts its attempt.
test("a compaction the portal runs for a chat is carried on when its run settles first", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    assert.equal(sessions.inRun.has(a), true, "A is working");
    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "B waits its turn");

    // pi's own attempt, at a turn boundary, with the summary it asked for stopping
    // in the middle of its answer: the one shape the portal answers for.
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", ...COMPACT_FAILED });
    assert.equal(
      sessions.compactionInterruptedRun.has(a),
      true,
      "the portal's attempt marks the turn it will stop, before pi stops it",
    );

    // pi doing the portal's compact, as it does a manual one: the run it stops
    // settles first, and only then does the compaction start and end.
    pi.compact = async () => {
      pi.emit("event", { type: "turn_end" });
      pi.idle = true;
      pi.emit("event", { type: "agent_settled", aborted: true });
      assert.equal(getSession(a).status, "idle", "the aborted run marks the session idle");
      assert.equal(sessions.isCompacting(a), true, "and the chat is not read as ended on it");
      assert.equal(sessions.isActive(a), true, "and it still holds the room");
      pi.emit("event", { type: "compaction_start", reason: "manual" });
      pi.emit("event", { type: "compaction_end", reason: "manual", willRetry: false, result: { summary: "s" } });
      assert.equal(sessions.compactionResumePending.has(a), true, "its end hands the turn to a resume");
    };
    await flush();
    assert.equal(sessions.compactionResumePending.has(a), false, "the resume landed");
    assert.deepEqual(
      pi.prompts,
      ["work on A", "Compaction detected, resume where you left off if needed."],
      "the turn was carried on in the same chat, once the attempt had ended",
    );
    assert.match(
      noticesOf(a).at(-1),
      /That worked: the chat is compacted/,
      "and the chat says what its compactor did just before it",
    );
    assert.equal(sessions.inRun.has(a), true, "the resumed run holds the room");
    assert.deepEqual(started, [a], "B never took the room across the gap");

    pi.settle();
    await flush();
    assert.deepEqual(started, [a, b], "only its own end hands the room over");
  } finally {
    await reset();
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
    // What is said here, in order: each of the two failures, the one try the portal
    // makes when the same summary fails twice (asked for short, so the room is the
    // model's answer, not the summary), what it found when that try did not work
    // either — the model has no numbers that would make a compaction worth — and the
    // switch off, which is what the chat is left on.
    assert.equal(after.length, 5, "the failures, the one try and what it found, and the switch off, each said");
    assert.equal(after[0].payload.text, after[1].payload.text, "the same failure is said each time it happens");
    assert.equal(pi.autoCompaction, false, "the chat stops paying minutes for attempts that cannot work");
    assert.equal(after[1].payload.text, "Auto-compaction failed: the summary did not fit in what the model can write in one answer, so nothing was compacted.");
    assert.match(after[2].payload.text, /Trying it once more with the summary asked for short/, "and the try the portal makes before it gives up, naming what it asks for");
    assert.match(after[3].payload.text, /p\/m has no compaction numbers that would/, "and, when that fails too, the model named as having no numbers that would work");
    assert.match(after[3].payload.text, /takes no tokens out/, "said as the fact: an attempt here costs a model call and removes nothing");
    assert.match(after[4].payload.text, /Auto-compaction is off for this chat after failing twice in a row/);

    // A chat whose compactions work again is a chat left to itself.
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "s" } });
    assert.equal(sessions.compactionFailures.has(a), false, "the count starts afresh");
    assert.equal(pi.autoCompaction, false, "the chat's own switch is the person's to turn back");
  } finally {
    await reset();
  }
});

// The stop is recorded, and it is recorded as the portal's own act: pi has one
// auto-compaction switch for every chat, so a chat whose summary cannot be written
// leaves them all without compaction — the chats started after it included. What
// answers it is the room the summary needs (this model's keep-recent, its keep-free,
// its Max output tokens), and the record is what lets that room be answered for
// exactly the chats that were stopped, and for nobody who switched it off by hand.
test("a chat the portal stopped is recorded with its model, said after a restart, and answered by that model's room", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    await failCompactionTwice(pi);
    assert.equal(pi.autoCompaction, false, "the attempts are stopped");
    assert.deepEqual(compactionStops().filter((s) => s.sessionId === a), [{ sessionId: a, modelKey: "p/m" }], "the stop is on the books, with the model its room is asked for");

    // The room given to a model that is not this chat's answers nothing here.
    assert.deepEqual(clearCompactionStops({ modelKey: "other/m" }), [], "another model's room is not this chat's answer");
    assert.equal(compactionStops().some((s) => s.sessionId === a), true, "the stop stands until its own model is given room");

    // A restart leaves the switch off in pi's own file and nothing of the chat says
    // so: reopened, the chat answers with a token of thinking and reads as broken.
    assert.equal(sessions.explainCompactionStops(), 1, "one chat the portal stopped is explained");
    const restart = noticesOf(a).at(-1);
    assert.match(restart, /Auto-compaction is off for this chat: the portal stopped it here/);
    assert.match(restart, /\(p\/m\)/, "the line names the model whose room answers it");

    // A provider's saved Max output tokens is the room of every model on it, so it
    // answers every chat stopped on that provider, in the order they were stopped.
    const b = chat();
    await sessions.prompt(b, "work on B");
    await flush();
    await failCompactionTwice(pis.get(b));
    assert.deepEqual(clearCompactionStops({ providerPrefix: "p/" }), [a, b], "every chat of that provider");
    assert.equal(sessions.explainCompactionStops(), 0, "and no chat is left standing as stopped");

    // The room arriving as one model's own numbers answers the chats stopped on that
    // model, and each of them is told in its own transcript.
    const c = chat();
    await sessions.prompt(c, "work on C");
    await flush();
    const cPi = pis.get(c);
    await failCompactionTwice(cPi);
    const cleared = clearCompactionStops({ modelKey: "p/m" });
    assert.deepEqual(cleared, [c], "this model's room answers this chat");
    assert.equal(await sessions.resumeStoppedCompaction(cleared, "p/m"), 1, "its pi was reached");
    assert.equal(cPi.autoCompaction, true, "its attempts are back on");
    assert.match(noticesOf(c).at(-1), /Auto-compaction is back on for this chat: p\/m was given room/);
    assert.deepEqual(compactionStops(), [], "the stop is off the books: the portal may try compaction here again");
  } finally {
    await reset();
  }
});

// A container's pi, and an older one, cannot say what the chat is running. An empty
// model key is what `putSetting` writes as no row at all, which would leave this
// chat's stop unrecorded — never explained, and never answered by the plain numbers,
// which are the only remedy for a chat with no name to give its room to.
test("a chat whose pi cannot name its model is recorded, its stop said without a name, and answered only by the plain numbers", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    noModel.add(a);
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    await failCompactionTwice(pi);
    assert.deepEqual(compactionStops().filter((s) => s.sessionId === a), [{ sessionId: a, modelKey: COMPACT_STOP_NO_MODEL }], "a row stands for it, naming no model");
    const said = noticesOf(a).at(-1);
    assert.match(said, /give this chat's model room/, "the line asks for the room in the chat's own words");
    assert.ok(!said.includes(COMPACT_STOP_NO_MODEL), "the marker is not shown as a model name");

    // Nothing named is a room for every model, so a named model's number is not this
    // chat's answer — and the plain numbers are.
    assert.deepEqual(clearCompactionStops({ modelKey: "p/m" }), [], "a named model's room is not this chat's");
    assert.deepEqual(clearCompactionStops({ providerPrefix: "p/" }), [], "nor is its provider's, as long as the chat cannot name it");
    assert.deepEqual(clearCompactionStops({}), [a], "the plain numbers, which are every model's, answer it");
    assert.equal(await sessions.resumeStoppedCompaction([a], ""), 1, "its pi was reached");
    assert.equal(pi.autoCompaction, true, "its attempts are back on");
    assert.match(noticesOf(a).at(-1), /Auto-compaction is back on for this chat: its model was given room/);

    // The same marker read at a restart says the same thing.
    const c = chat();
    noModel.add(c);
    await sessions.prompt(c, "work on C");
    await flush();
    await failCompactionTwice(pis.get(c));
    assert.equal(sessions.explainCompactionStops(), 1, "the chat left standing as stopped is one");
    const restart = noticesOf(c).at(-1);
    assert.match(restart, /Give this chat's model room in this chat's Context card/);
    assert.ok(!restart.includes(COMPACT_STOP_NO_MODEL), "and the marker is not shown as its model");
  } finally {
    await reset();
  }
});

// The person's own move on the switch is a move on a file every chat shares: pi has one
// auto-compaction switch, and switching it on one chat's pi writes that file. Left to
// itself, one chat's own off leaves every chat started after it without compaction, and
// the room given to some other chat — which writes the same switch back on, because pi
// has no other — switches this chat's compaction on under the person who turned it off.
// The record of their move is what keeps both: the chat stays off on its own pi, and the
// file keeps the switch for every chat nobody switched off.
test("a chat whose person switched compaction off keeps it off, and no other chat loses it", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    const b = chat();

    // The card's move, as the chat's config route makes it: their off on the books.
    noteCompactionChoice(a, false);

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    assert.equal(aPi.autoCompaction, false, "the chat is started off, as its person left it");
    assert.equal(readCompactionSettings().enabled, true, "pi's file keeps the switch: a chat nobody switched off is not left without compaction");

    // A chat started after it, on that same file.
    await sessions.prompt(b, "work on B");
    await flush();
    assert.equal(pis.get(b).autoCompaction, true, "B switched nothing off, and keeps its compaction");

    // A settings reload is pi reading its own file, which is the switch: the chat
    // told off would come back on under the person who turned it off.
    await sessions.refreshSettings();
    assert.equal(aPi.autoCompaction, false, "the chat told off is put back off, with its reload");
    assert.equal(pis.get(b).autoCompaction, true, "and every other chat is left as its own reload read it");

    // Their own way back: switching it on leaves nothing recorded, and nothing is applied.
    noteCompactionChoice(a, true);
    aPi.autoCompaction = true;
    assert.equal(await sessions.honorCompactionOffs({ ids: [a] }), 0, "a chat nobody switched off is left alone");
    assert.deepEqual(chatsWithCompactionOffByChoice(), [], "their move is off the books");
  } finally {
    await reset();
  }
});

// The damage a portal older than the record left behind: its stop of one chat's attempts
// was a write to pi's one compaction switch, which is every chat's, and it left nothing
// on the books. Every chat opened after it ran to the wall of its context, the model
// answered with a token of thinking, and the portal's carry-on line came back at it —
// which is the shape the gunner chats ended in. The portal takes its own hand off that
// file at its start: the chats it stopped are read back from the sentence they were
// told, each keeps its off on its own pi, and the file is given the switch back.
test("the switch one chat's stop left in pi's file is taken back at the portal's start", async () => {
  const keyOf = (row) => {
    const { provider, model } = chatModel(row);
    return provider && model ? `${provider}/${model}` : COMPACT_STOP_NO_MODEL;
  };

  try {
    setSingleActiveSession(false);
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();

    // What the portal said in that chat when it stopped it, and what it wrote to pi's
    // file by doing it: the sentence is the only record that shape left.
    appendEvent(a, "portal_notice", {
      text: `${COMPACT_STOP_NOTICE} (the summary did not fit in what the model can write in one answer.)`,
      warning: true,
    });
    await writeCompactionSettings({ enabled: false });
    assert.deepEqual(compactionStops().filter((s) => s.sessionId === a), [], "a stop of that shape left no record");
    assert.equal(readCompactionSettings().enabled, false, "the file is left without the switch");

    // Two other chats live in the same shadow: one whose person switched its compaction
    // off, one nobody told off. Both read the same file at their start.
    const b = chat();
    noteCompactionChoice(b, false);
    const c = chat();
    await sessions.prompt(b, "work on B");
    await flush();
    await sessions.prompt(c, "work on C");
    await flush();
    // The chat nobody told off does not wait for the portal's start to be repaired: it read
    // this off file at its own start, and that start is where its compaction — and the file's
    // switch, which is every chat's — is taken back. See honorCompactionOffs.
    assert.equal(pis.get(c).autoCompaction, true, "the chat nobody told off is put back on at its start");
    assert.equal(readCompactionSettings().enabled, true, "and pi's file has its switch back with it");

    const { seeded, takenBack } = await sessions.repairCompactionSwitch();
    assert.deepEqual(seeded, [a], "the chat told in its own transcript is the chat recorded");
    assert.equal(takenBack, false, "nothing was left for the portal's start to take back");
    assert.equal(compactionStops().find((s) => s.sessionId === a)?.modelKey, keyOf(getSession(a)), "recorded with the model its room is asked for");
    assert.equal(readCompactionSettings().enabled, true, "pi's file has its switch back");
    assert.equal(pis.get(a).autoCompaction, false, "the chat the portal stopped keeps its off, on its own pi");
    assert.equal(pis.get(b).autoCompaction, false, "and the chat whose person switched it off keeps that");
    assert.equal(pis.get(c).autoCompaction, true, "the chat nobody told off takes the switch back with its reload");

    // Each chat the portal stopped says so in its own transcript, naming the room that
    // turns its attempts back on.
    assert.equal(sessions.explainCompactionStops(), 1, "one chat stands as stopped: the one the portal stopped");
    const said = noticesOf(a).at(-1);
    assert.match(said, /Auto-compaction is off for this chat: the portal stopped it here/);
    assert.match(said, /Give .* room in this chat's Context card/, "the line names the room that answers it");

    // A file that already reads on is left alone: nothing is written at a start, a
    // reload, or a repair when nobody moved the switch.
    const { seeded: again, takenBack: idle } = await sessions.repairCompactionSwitch();
    assert.deepEqual(again, [], "a chat already on the books is not recorded a second time");
    assert.equal(idle, false, "a file that reads on is not written");

    // The chat whose stop was answered is not read back as stopped. The sentence the
    // portal said in it stays in its transcript for good, so a start that reads sentences
    // finds it every time: read as stopped again, the chat whose room arrived long ago
    // would be switched off on its own pi and told its own stop line a second time — and
    // a person who took the switch back on in the card would find it off again after a
    // restart, with a line saying they never asked for it.
    const answered = clearCompactionStops({ modelKey: keyOf(getSession(a)) });
    assert.deepEqual(answered, [a], "the room of its model is what answers it");
    assert.equal(compactionStopWasAnswered(a), true, "its answered stop is kept, off the notices' reach");
    assert.equal(sessions.explainCompactionStops(), 0, "no chat is left standing as stopped");

    // A chat the portal stops after it — and a portal that leaves its file off, as this
    // chat's stop did before the portal kept records.
    await writeCompactionSettings({ enabled: false });
    const { seeded: third } = await sessions.repairCompactionSwitch();
    assert.deepEqual(third, [], "the chat whose room arrived is not recorded as stopped a second time");
    assert.equal(readCompactionSettings().enabled, true, "its file is given the switch back");
    assert.equal(pis.get(a).autoCompaction, true, "and it is not put back off on the strength of its own past");
    assert.equal(pis.get(b).autoCompaction, false, "the chat whose person switched it off keeps that");
  } finally {
    await reset();
  }
});

// The damage of a shared switch, the way it actually arrives: the portal stops one
// chat, and the off of that chat reaches the chats nobody stopped. pi has one switch,
// the chats the portal stopped carry it off in their memory, and the next thing any of
// them saves writes the whole file — compaction switch included. Nothing in the portal
// sees that write, so the chats that come after read an off nobody asked for and run to
// the wall of their context without compacting: the failures with no compaction at all.
test("a chat that reads pi's file off takes its compaction back, and the file its switch", async () => {
  try {
    setSingleActiveSession(false);
    const stopped = chat();
    await sessions.prompt(stopped, "work on S");
    await flush();
    await failCompactionTwice(pis.get(stopped));
    assert.equal(compactionStops().some((s) => s.sessionId === stopped), true, "its stop is on the books");
    assert.equal(pis.get(stopped).autoCompaction, false, "the chat the portal stopped has the switch off on its own pi");
    assert.equal(readCompactionSettings().enabled, true, "and the file keeps the switch for every other chat");

    // The write nobody in the portal sees: that chat's pi saving its settings.
    await writeCompactionSettings({ enabled: false });

    // A chat started on the off file: pi reads its settings at the start of its first
    // prompt, so this chat has compaction off, and that is what sends it past the wall.
    const later = chat();
    await sessions.prompt(later, "work on L");
    await flush();
    assert.equal(pis.get(later).autoCompaction, true, "its start took the compaction the file's off had left it with");
    assert.equal(readCompactionSettings().enabled, true, "and the file is given the switch back, so the next chat reads it");
    assert.equal(pis.get(stopped).autoCompaction, false, "the chat the portal stopped keeps its off through it");

    // The other moment the file's off is taken for a chat's own: the portal tending the
    // file on its timer. A chat's pi re-read the file between the steps of a run, and a
    // state fetch asked of that chat at its run's start would be a request among the run's
    // own — so the switch is tended by the timer, and its next step is worked on a pi that
    // was told.
    const work = chat();
    await sessions.prompt(work, "work on W");
    await flush();
    const w = pis.get(work);
    assert.equal(w.autoCompaction, true, "it started on compaction");
    await writeCompactionSettings({ enabled: false });
    w.autoCompaction = false; // its pi re-read the file between the run's requests
    sessions.startSwitchTender(20);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(w.autoCompaction, true, "the tender gave this chat the compaction its reload read off");
    assert.equal(readCompactionSettings().enabled, true, "and the file its switch, for the chat started next");
    assert.equal(compactionStops().some((s) => s.sessionId === work), false, "a chat with no record is the one repaired, and no record is written for it");
  } finally {
    await reset();
  }
});

// What one chat's room costs the other chats. The numbers are arithmetic on a model's
// window and answer, and both are on the model's row in pi's models file — the same file
// Settings → Providers writes. So sizing is not something a chat has to ask for: the
// portal sizes every model it has at its start, which is what reaches every chat at once
// instead of only the one that hit the wall of its window and failed there. A pair of
// plain numbers is not widened here, because one pair cannot be right for two windows —
// which is why pi scopes the number to a model at all — and a person's numbers, plain or
// for a model, are never written over.

const piDir = () => path.join(home, "agent");
/** The rows the portal has: a wide model that names its window and not its answer, as a
    row added in Settings usually looks, a narrow one that names both, and one too small
    for any room to fit in. `wideWindow` stands in for the row a person edits later. */
const writeRows = (wideWindow) =>
  writeFileSync(
    path.join(piDir(), "models.json"),
    JSON.stringify(
      {
        providers: {
          testwide: { models: [{ id: "wide-1", contextWindow: wideWindow }] },
          testmid: { models: [{ id: "mid-1", contextWindow: 65536, maxTokens: 16384 }] },
          testtiny: { models: [{ id: "tiny-1", contextWindow: 8192 }] },
        },
      },
      null,
    ),
  );

test("every model the portal has is sized at its start, before a chat is asked", async () => {
  mkdirSync(piDir(), { recursive: true });
  writeRows(131072);
  // The plain numbers are the person's, typed in the Settings card for every chat.
  writeFileSync(path.join(piDir(), "settings.json"), JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 30000, reserveTokens: 20000 } }, null));
  const sized = await sessions.sizeEveryModel();
  assert.deepEqual(
    [...sized.models].sort(),
    ["testmid/mid-1", "testwide/wide-1"],
    "the models the portal has are sized; the one no room fits in is not asked for",
  );
  const settings = readCompactionSettings();
  const wide = settings.modelOverrides?.["testwide/wide-1"];
  const mid = settings.modelOverrides?.["testmid/mid-1"];
  assert.ok(wide && mid, "each of them under its own name");
  assert.ok(131072 - wide.reserveTokens <= 131072 * 0.9, "the wide one is asked for before the wall of its window, not at it");
  assert.ok(wide.reserveTokens !== mid.reserveTokens && wide.keepRecentTokens !== mid.keepRecentTokens, "the numbers are each model's own, not one pair for both");
  assert.ok(!settings.modelOverrides?.["testtiny/tiny-1"], "a model no room fits in is left as pi has it");
  assert.equal(settings.keepRecentTokens, 30000, "the person's plain numbers stand for every chat");
  assert.equal(settings.reserveTokens, 20000, "the person's plain numbers stand for every chat");
});

test("the portal's own sizing follows the row when the row changes", async () => {
  const before = readCompactionSettings().modelOverrides?.["testwide/wide-1"];
  assert.ok(before, "the wide one was sized with numbers");
  assert.ok(compactionPlanFor("testwide/wide-1"), "as the portal's hand, on the books");
  writeRows(200000);
  const sized = await sessions.sizeEveryModel();
  assert.ok(sized.models.includes("testwide/wide-1"), "a model the portal has sized is brought up to date");
  const after = readCompactionSettings().modelOverrides?.["testwide/wide-1"];
  assert.ok(after.reserveTokens !== before.reserveTokens, "the numbers follow the row, rather than being written once");
  assert.ok(200000 - after.reserveTokens <= 200000 * 0.9, "at the new window, asked for before its wall too");
});

test("a person's numbers for one of the models stay their's, the others are sized", async () => {
  const modelKey = "testwide/wide-1";
  const theirs = { keepRecentTokens: 4000, reserveTokens: 4000 };
  writeFileSync(
    path.join(piDir(), "settings.json"),
    JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 30000, reserveTokens: 20000, modelOverrides: { [modelKey]: theirs } } }, null),
  );
  const sized = await sessions.sizeEveryModel();
  assert.ok(!sized.models.includes(modelKey), "the model the person gave numbers is not sized");
  assert.ok(sized.models.includes("testmid/mid-1"), "the model nobody gave numbers is");
  const settings = readCompactionSettings();
  assert.deepEqual(settings.modelOverrides?.[modelKey], theirs, "the person's numbers for that model are untouched");
  // The portal's own earlier write is on the books; it does not pull the person's
  // numbers back under its hand.
  const again = await sessions.sizeEveryModel();
  assert.ok(!again.models.includes(modelKey), "a record of the portal's earlier write does not size it again over what they typed");
  assert.ok(portalCompactionPlans().includes("testmid/mid-1"), "what the portal sized is on the books, so it can tell its own write next time");
});

/* ── A compaction that does not compact is said; a compaction that works is silent. ── */

test("the shapes of a compaction that cannot work are read off the numbers, and this module plan is not one of them", async () => {
  const wide = { contextWindow: 131_072, maxTokens: 16_384 };
  const read = (keep, free) => roomFaultFor(roomShapeFor(wide, { keepRecentTokens: keep, reserveTokens: free }));
  // The pair the chats on this machine ran on, and the same pair typed the other way
  // round: one hands the summariser a head no single answer of this model writes up,
  // and the other leaves a compaction that works and a chat whose next summary has
  // nothing beside it to grow into.
  assert.equal(read(20_000, 30_000), "summary-wont-fit", "the pair pi leaves a 131,072-token model on");
  assert.equal(read(30_000, 20_000), "walks-to-the-cap", "the same shape, with the two numbers typed the other way round: a cut exists, and the chain of summaries reaches one answer's whole length");
  assert.equal(read(1_000, 131_072), "keeps-free-the-whole-window", "it keeps free as much of the window as the window has: pi is asked only past the end of it");
  assert.equal(read(130_100, 1_000), "keeps-past-its-point", "it keeps more word for word than it compacts above, so there is nothing to summarise");
  assert.equal(read(42_000, 33_000), "head-too-small", "it leaves a head smaller than the document written about it, which takes nothing out of the chat");
  assert.equal(read(44_000, 33_000), "nothing-left-to-cut", "its keep twice, and the document beside it, reach past the point it compacts above: there is no cut, and never will be");
  assert.equal(read(110_000, 20_000), "nothing-left-to-cut", "it keeps, and carries back over the keep, more than it compacts above: there is no cut for pi to make");
  assert.equal(read(129_500, 1_000), "nothing-left-to-cut", "and a keep at the top of the window is the same shape read the other way: the cut is out of reach, not below the document");
  assert.equal(read(58_072, 33_000), "nothing-left-to-cut", "the pair this portal wrote for a model this big before, read on its own shape: its keep twice and the summary beside it come past the 98,072 it compacted above, which is what left a chat that had just compacted answering `Nothing to compact`");
  for (const size of [{ contextWindow: 200_000, maxTokens: 16_384 }, { contextWindow: 65_536, maxTokens: 16_384 }]) {
    const plan = planForModel(size);
    assert.ok(plan, "a model this module can size has a plan");
    assert.equal(roomFaultFor(roomShapeFor(size, planRoom(plan))), null, "and its plan is never read as one of the shapes that cannot work");
  }
  assert.equal(planForModel({ contextWindow: 8_192, maxTokens: 4_096 }), null, "a model with no room that fits has no plan at all, and nothing is claimed about it");
  assert.equal(planForModel({ contextWindow: 32_768, maxTokens: 8_192 }), null, "a window that cannot hold the document this model writes, and room for the next one beside it, has no plan either");
});

// pi's cut point never walks back past the newest compaction record, and that record
// carries its summary and the stretch of conversation it kept into the context the next
// one is handed (fact 4 of `compaction-ladder.ts`). A pair read the way pi reads it has
// five numbers that add up, and the plan writes them so the head it names is the head
// the summariser is given: the last keep, this keep, the summary beside them, and the
// head. The pair this portal wrote for these chats before — 58,072 of a 131,072 window
// — added up past the point it compacted at, which is what left a chat that had just
// compacted with `Nothing to compact` and a window to fill to the top.
test("the plan a model gets leaves its head reachable with the last keep and its own summary beside it", async () => {
  for (const size of [
    { contextWindow: 131_072, maxTokens: 16_384 },
    { contextWindow: 200_000, maxTokens: 16_384 },
    { contextWindow: 65_536, maxTokens: 16_384 },
  ]) {
    const plan = planForModel(size);
    assert.ok(plan, "a model this module can size has a plan");
    assert.equal(plan.carriedSummaryTokens, plan.summaryTokens, "the summary a chat carries is the document these same numbers write, which is what a chain of them reaches");
    assert.equal(
      plan.triggersAtTokens,
      plan.keepRecentTokens * 2 + plan.carriedSummaryTokens + plan.headTokens,
      "the point it compacts above is the last keep, this keep, that summary, and the head beside them",
    );
    assert.equal(plan.landsAtTokens, plan.keepRecentTokens + plan.summaryTokens, "and a compaction that works leaves exactly its keep and that document");
    assert.equal(plan.progressTokens, plan.headTokens + plan.keepRecentTokens, "which is why the chat works its head and its keep again before the next one is asked for");
    assert.equal(roomFaultFor(roomShapeFor(size, planRoom(plan))), null, "and its plan is never read as one of the shapes that cannot work");
  }
  const wide = { contextWindow: 131_072, maxTokens: 16_384 };
  const plan = planForModel(wide);
  assert.ok(
    plan.keepRecentTokens < 58_072 && plan.landsAtTokens < 74_456,
    "the keep this model gets now is below the pair it was left on before, and a chat that compacts lands further below the top of its window",
  );
});

// The other no-result answer pi gives, and the one only a pair of numbers asks for:
// the chat has added less than its keep since the compaction before this one. Nothing
// about a summary went wrong, the chat's own count of failures is nobody's to advance,
// and its switch is nobody's to turn off; what the ladder has to offer is where the
// room lives and what starts the chat over.
test("a compaction with no cut to make is said as what pi found, not as an attempt that failed", async () => {
  try {
    setSingleActiveSession(false);
    const a = chat();
    knownSizes.set(a, { contextWindow: 131_072, maxTokens: 16_384 });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    // The chat's own attempt, with the summary stopped in the middle of its answer:
    // the shape the ladder is asked for.
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", ...COMPACT_FAILED });
    // pi doing the portal's compact, on a chat that has only just been compacted: the
    // conversation since that compaction is less than any keep worth writing, so the
    // call has nothing to cut and says so.
    pi.compact = async () => {
      throw new Error("Nothing to compact (session too small)");
    };
    await flush();
    const said = noticesOf(a);
    assert.equal(said.length, 4, "the failure, the one try, the room, and what pi found on the try that followed");
    assert.match(said[1], /Trying it once more with the summary asked for short/, "the try the ladder makes first");
    assert.match(said[2], /Giving p\/m the compaction its own size asks for: keep-recent 30,460/, "the room this model's size asks for now, which keeps far less than the 58,072 the chats on this machine were left on");
    assert.match(said[2], /beside the 12,384 of summary that compaction left and the 30,460 it keeps word for word/, "named with the summary a chat carries into the next compaction, and the keep before it, which is why it keeps less");
    assert.match(said[3], /Pi has nothing to take out of this chat/, "and what pi found, in the words for what it means");
    assert.equal(said.filter((t) => t.includes("That did not work either")).length, 0, "no cut to make is not an attempt that failed");
    assert.equal(pi.autoCompaction, true, "and the chat's switch is left to the person: a chat cannot be cut is not its count of failures");
  } finally {
    await reset();
  }
});

/** The rows of a model whose numbers cannot work, and of one that is left to the portal. */
const brokenRows = () =>
  writeFileSync(
    path.join(piDir(), "models.json"),
    JSON.stringify(
      {
        providers: {
          testbroken: { models: [{ id: "wide-1", contextWindow: 131_072 }, { id: "ok-1", contextWindow: 100_000 }] },
        },
      },
      null,
    ),
  );

test("a model that cannot compact is named at the portal start, with the numbers that would work", async () => {
  brokenRows();
  // A person has set one of these models to keep almost the whole window: pi will do
  // as it is told, and nothing in a chat would say where the trouble is.
  writeFileSync(
    path.join(piDir(), "settings.json"),
    JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 30_000, reserveTokens: 20_000, modelOverrides: { "testbroken/wide-1": { keepRecentTokens: 130_000, reserveTokens: 5_000 } } } }, null),
  );
  const sized = await sessions.sizeEveryModel();
  const broken = "testbroken/wide-1";
  const ok = "testbroken/ok-1";
  assert.ok(sized.models.includes(ok), "the model nobody gave numbers is sized from its row");
  assert.ok(!sized.models.includes(broken), "the model a person gave numbers for is left theirs");
  const named = sized.faults.filter((f) => f.includes(broken));
  assert.equal(named.length, 1, "the model that cannot compact is named once at the start, under its own name");
  assert.match(named[0], /it keeps 130,000 word for word of a 131,072-token window/, "with what its numbers do to that window");
  assert.match(named[0], /keep-recent \d/, "and the numbers that would work for its size");
  assert.match(named[0], /Settings → Providers/, "and where those numbers are changed");
  assert.ok(!sized.faults.some((f) => f.includes(ok)), "a model sized with numbers that work is not named at all");
});

test("a chat whose compaction cannot work says so at its start, once for its model", async () => {
  // The chat is on a model that says its size, and on numbers of the person's that
  // keep almost the whole window: the chat will run to the wall of its context with
  // nothing ever compacted. The line belongs to its model, so the next chat on it is
  // silent.
  await writeCompactionModelRoom("p/m", { keepRecentTokens: 129_000, reserveTokens: 5_000 });
  const a = chat();
  const b = chat();
  knownSizes.set(a, { contextWindow: 131_072, maxTokens: 16_384 });
  knownSizes.set(b, { contextWindow: 131_072, maxTokens: 16_384 });
  await sessions.prompt(a, "work on A");
  await flush();
  const said = noticesOf(a).filter((t) => t.includes("cannot work as configured"));
  assert.equal(said.length, 1, "the chat says once, before its first answer, what its compaction cannot do");
  assert.match(said[0], /This chat's compaction cannot work as configured/, "of this chat's compaction, and not of a run that stopped");
  assert.match(said[0], /it keeps 129,000 word for word of a 131,072-token window/, "naming the numbers it is left on and the window they belong to");
  assert.match(said[0], /keep-recent \d/, "and the numbers that would work for a model this size");
  assert.ok(
    noticesOf(b).filter((t) => t.includes("cannot work as configured")).length === 0,
    "the next chat on the same model is silent: the numbers, and the fact, are the model's",
  );
});

test("a chat whose compaction works says nothing about it at its start", async () => {
  // A clean file first: the numbers are nobody's, so the portal sizes them, and a
  // configuration that works is left unmentioned.
  writeFileSync(path.join(piDir(), "settings.json"), JSON.stringify({ compaction: { enabled: true } }, null));
  const a = chat();
  knownSizes.set(a, { contextWindow: 131_072, maxTokens: 16_384 });
  await sessions.prompt(a, "work on A");
  await flush();
  assert.equal(
    noticesOf(a).filter((t) => t.includes("cannot work as configured") || t.includes("is sized from")).length,
    0,
    "a compaction that works is not commented on, and the sizing that fixed one says nothing either",
  );
});

// The one place the room is read out rather than only written: a chat has spent a
// run at the top of its window, the model answered with a token of thinking, and the
// pair it was compacting on is one the portal wrote and no longer works. This is the
// shape a chat of the week before reached at 96% of a 131,072-token window: the keep
// that pair leaves is counted twice against the point it compacts above, so no cut is
// reachable and the chat walked to the wall with nothing ever taken out. The room is
// the portal's, so it is written there, and said there — a transcript that only shows
// a chat stopping leaves the person no way to tell a room that arrived from a chat
// that gave up. The chat is one whose pi named no model's size when it opened, which
// is why it was not sized at its start.
test("a chat that ends a run at the wall of its context is given its model's room there, and says what arrived", async () => {
  try {
    setSingleActiveSession(false);
    mkdirSync(piDir(), { recursive: true });
    // The pair an earlier build of the portal wrote for this model, with its record:
    // the numbers are the portal's, so they may be brought up to date.
    writeFileSync(
      path.join(piDir(), "settings.json"),
      JSON.stringify({ compaction: { enabled: true, modelOverrides: { "p/m": { keepRecentTokens: 58_072, reserveTokens: 33_000 } } } }, null),
    );
    noteCompactionPlan("p/m", { keepRecentTokens: 58_072, reserveTokens: 33_000 });

    const a = chat();
    // Its pi says which model it runs, but names no size: nothing is written at the
    // chat's start, and the chat opens on the pair above.
    await sessions.prompt(a, "work on A");
    await flush();
    // Now its pi can name the window and the answer it is working in, and how full
    // the chat's context got while the run went: the wall of one.
    knownSizes.set(a, { contextWindow: 131_072, maxTokens: 16_384 });
    wallAt.set(a, 91);
    pis.get(a).settle();
    await flush();

    const wall = noticesOf(a).filter((t) => t.includes("ends its run at"));
    assert.equal(wall.length, 1, "the wall the run ended at is named in the chat once");
    assert.match(wall[0], /ends its run at 91% of p\/m's 131,072-token window/);
    assert.match(wall[0], /Its compaction cannot work as configured: it keeps 58,072 word for word, and that keep is counted twice against 98,072/, "the trouble the chat's own numbers cause, in the words for the shape they make");
    assert.match(wall[0], /The portal has written this model's own numbers/, "the room that arrived, and who wrote it");
    assert.match(wall[0], /keep-recent 30,460, keep-free 33,000/, "the pair this model's size asks for, which keeps less than the pair it was left on");
    assert.match(wall[0], /ask the question again, or start a new chat/, "and what the person does with the turn that stopped at the wall");

    // The numbers in pi's file are the new pair, under the model's name, and the
    // portal's record of what it wrote follows the write: this chat's pi has read
    // them, and its next turn has a cut to take.
    const sized = readCompactionSettings().modelOverrides["p/m"];
    const plan = planForModel({ contextWindow: 131_072, maxTokens: 16_384 });
    assert.equal(sized.keepRecentTokens, plan.keepRecentTokens, "the chat's model is now compacted with this model's keep");
    assert.equal(sized.reserveTokens, plan.reserveTokens, "and its keep-free");
    assert.deepEqual(compactionPlanFor("p/m"), planRoom(plan), "and the record says these numbers are the portal's again");

    // A second run ending at the same height says nothing: the numbers are already
    // this model's, so there is no new room, and a chat that settles at 91% every
    // run for a day is one line, not forty.
    pis.get(a).settle();
    await flush();
    assert.equal(noticesOf(a).filter((t) => t.includes("ends its run at")).length, 1, "the same wall says nothing twice");
  } finally {
    await reset();
  }
});
