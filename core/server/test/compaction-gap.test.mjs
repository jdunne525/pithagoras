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

const { createSession, COMPACT_STOP_NOTICE, COMPACT_STOP_NO_MODEL, appendEvent, chatsWithCompactionOffByChoice, chatModel, clearCompactionStops, compactionStopWasAnswered, compactionStops, eventsSince, getSession, getDb, noteCompactionChoice, setSingleActiveSession } = await import("../dist/db.js");
const { readCompactionSettings, writeCompactionSettings } = await import("../dist/pi-settings.js");
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
    return { model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off", autoCompactionEnabled: this.autoCompaction };
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
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
  noModel.clear();
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
