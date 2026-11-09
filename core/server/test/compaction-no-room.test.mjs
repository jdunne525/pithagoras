import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a chat does when a compaction that worked leaves it where it was asked to be
// compacted again: the next turn meets the threshold again, and the next merge has only
// what the chat just added to take out of. Nothing about a summary went wrong there — the
// numbers this chat runs on keep a stretch at least as long as the room they leave before
// that point, and the part of the chat's context no compaction reads (its instructions and
// the tools it is offered) sits above the reach of both. Measured on bWDX-fMbF8eo (8
// November): seven compactions in half an hour, each taking 6,400-7,000 tokens out of a
// context it had only just been asked above, leaving it at 95,665 → 108,816 of a 131,072
// token window against the 98,072 it was asked above at. That chat's own compaction, the
// one its person read, took 6,788 out of 105,285 and left the chat at 98,497 — 425 tokens
// above the point — on a keep of 30,460 with a document of 5,777 beside it: the part of
// that chat no compaction reads is the remaining 62,260, and that is what closes the gap.
// A pair of keep-recent and keep-free numbers cannot reach the part, so the answer to that
// state is a pair asked with it (`planForModel` with fact 7's term), not a second
// summarization and not a notice; the notice is for the state no pair answers, where the
// chat's room is its own and the line says what its part is. So the stop and the line are
// worked at the compaction that won no room, once per chat, and a chat whose compaction
// did win room is left on the question of length, which was already answered there.

const home = inProcessHome("pithagoras-compaction-no-room-");
mkdirSync(path.join(home, "work"), { recursive: true });

const {
  createSession,
  appendEvent,
  chatsWithCompactionOffByChoice,
  chatFixedPart,
  clearCompactionStops,
  compactionStops,
  compactionStopShape,
  eventsSince,
  getDb,
  modelFixedPart,
  noteCompactionChoice,
  putSetting,
  setSingleActiveSession,
} = await import("../dist/db.js");
const { readCompactionSettings, writeCompactionSettings, writeCompactionModelRoom, effectiveCompactionTokens } = await import("../dist/pi-settings.js");
const {
  carriedSummaryOf,
  COMPACT_NO_ROOM_NOTICE,
  COMPACT_SHORT_SUMMARY,
  planForModel,
  nextDocumentFitsFor,
  landedRoomOf,
  fixedPartOf,
  planRoom,
  compactionRoomWonFor,
} = await import("../dist/compaction-ladder.js");
const { COMPACT_STOP_NO_ROOM } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
test.after(() => getDb().close());

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  running = true;
  /** Whether a run is going; the manager asks before settling a prompt. */
  idle = true;
  prompts = [];
  /** Whether this chat's pi has its own auto-compaction switch on. */
  autoCompaction = true;
  /** What this chat's pi was asked to compact, and in whose words. */
  compacts = [];
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
    // A chat started now is pi reading its file: the switch stands as the last write
    // left it, which is the damage the portal's stop did before it kept its own off.
    this.autoCompaction = readCompactionSettings().enabled;
  }
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
      model: { input: ["text"], ...(modelOf.get(this.sessionId) ?? { id: "m", provider: "p" }), ...(knownSizes.get(this.sessionId) ?? {}) },
      thinkingLevel: "off",
      autoCompactionEnabled: this.autoCompaction,
    };
  }
  async abort() {}
  /** A pi asked to compact by name. Only the bounded-ask test opts a chat in. */
  async compact(instructions) {
    this.compacts.push(instructions ?? "");
    if (!canCompact.has(this.sessionId)) throw new Error("this pi cannot compact on request");
  }
  async setAutoCompaction(enabled) {
    this.autoCompaction = enabled;
    await writeCompactionSettings({ enabled });
  }
  async refreshSettings() {
    this.autoCompaction = readCompactionSettings().enabled;
  }
  async shutdown() {}
  dispose() {}
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
/** What each chat's pi reports its model's window and answer to be, for the tests that read a model's size. */
const knownSizes = new Map();
/** A chat's model, for the tests that mean a model of their own: the default is p/m. */
const modelOf = new Map();
/** Chats whose pi answers a compaction asked of it, for the tests that read the portal's attempts. */
const canCompact = new Set();
SdkPiClient.create = async (opts) => {
  started.push(opts.sessionId);
  const pi = new FakePi(opts);
  pis.set(opts.sessionId, pi);
  return pi;
};

/** A Task's session: autonomous, in a folder of its own that exists. */
let count = 0;
function chat() {
  const id = `nr${++count}`;
  createSession({ id, title: id, workspace: path.join(home, "work"), executor: "host", kind: "task" });
  return id;
}

/** Lets the fire-and-forget run path reach pi and the queue reach its next item. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

/** One test's sessions do not leave another's room held. */
async function reset() {
  started.length = 0;
  canCompact.clear();
  knownSizes.clear();
  modelOf.clear();
  sessions.inRun.clear();
  sessions.compacting.clear();
  sessions.compactionInterruptedRun.clear();
  sessions.compactionResumePending.clear();
  sessions.compactionFailures.clear();
  // Nor one test's chat already stopped for a compaction that won no room.
  sessions.roomNeverWon.clear();
  sessions.compactionRoomSaid.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
  clearCompactionStops({});
  for (const id of chatsWithCompactionOffByChoice()) noteCompactionChoice(id, true);
  // Nor one test's reading of the part no compaction reads, held for a model: the
  // largest of that model's chats is what its pair is asked with, and one test's
  // chat is not another's.
  putSetting("fixed_part_model:p/m", "0");
  await writeCompactionSettings({ enabled: true });
}

/** The chat's lines of its own, in order: what the portal said in it. */
const noticesOf = (id) =>
  eventsSince(id)
    .filter((r) => r.type === "portal_notice")
    .map((r) => String(JSON.parse(r.payload).text ?? ""));

/** What the portal writes a number as in a line: thousands with separators. */
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The pair every chat inherits, named so the point the next turn is measured against is a number the test can read. */
async function inheritRoom() {
  await writeCompactionSettings({ enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 });
}

/**
 * A compaction that worked, left the chat above the point it is asked above again, and
 * reports the whole of what it left: a chat's context after a compaction is its part no
 * compaction reads, plus what these numbers keep word for word, plus the document they
 * left beside them (`fixedPartOf` reads the first out of the other two). So a test names
 * the part it means to stand for, and the report it emits says that part — a fixture that
 * adds up is a fixture the chat could really have made. The cut it reports is a real one,
 * and the chat is above the point it is asked because its part sits beside the keep.
 */
function left(part, carried, modelKey = "p/m") {
  const own = effectiveCompactionTokens(readCompactionSettings(), modelKey);
  const after = part + own.keepRecentTokens + carried;
  return {
    summary: "x".repeat(carried * 4),
    usage: { input: 1, output: carried },
    tokensBefore: after + 6_540,
    estimatedTokensAfter: after,
  };
}

const WINDOW = 131_072;
const ANSWER = 16_384;

test("a compaction that left the chat where it was asked again, above a part its pair can still answer, is answered with the pair asked with that part", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a);

    // What the numbers in pi's file actually leave this chat doing: the pair this module
    // wrote at the chat's start for this model's window, and the point it asks above —
    // the chat's own reading, not a plan's.
    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    assert.ok(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }), "a model this module has numbers for");

    // The chat that asked for this fix: its compaction took 6,788 out of 105,285 and left
    // it at 98,497, 425 above the point. Nothing about a summary went wrong.
    const at = {
      type: "compaction_end",
      reason: "threshold",
      willRetry: false,
      result: { summary: "x".repeat(23_108), usage: { input: 69_037, output: 5_777 }, tokensBefore: 105_285, estimatedTokensAfter: 98_497 },
    };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.ok(
      !compactionRoomWonFor(landedRoomOf(at), askedAbove),
      "the chat was left above the point these numbers ask above again: the room was not won",
    );
    assert.equal(
      fixedPartOf(landedRoomOf(at), own.keepRecentTokens, carriedSummaryOf(at)),
      62_260,
      "and what the chat's own landing says no compaction reads is 62,260 of the window — 48% of it",
    );
    assert.equal(chatFixedPart(a), 62_260, "kept for this chat, and for its model's later readings");
    assert.equal(modelFixedPart("p/m"), 62_260, "kept at the largest reading of any chat on this model, which is what a pair under its name is asked with");

    // The answer to that state: a pair asked with the part has a cut above it, so the
    // portal writes that pair, silently, as it writes one at a chat's start. The chat is
    // not stopped, says nothing, and pays nothing for a room it can win.
    const answers = planRoom(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 62_260));
    assert.ok(answers, "a pair answers this chat's part: the part is not at the point these numbers ask");
    assert.deepEqual(
      effectiveCompactionTokens(readCompactionSettings(), "p/m"),
      answers,
      "the pair asked with the part, under the model's name",
    );
    assert.equal(pi.autoCompaction, true, "and this chat's attempts are left running on it");
    assert.deepEqual(pi.compacts, [], "nothing was asked of this chat's pi for a room no second summarization could win anyway");
    assert.equal(noticesOf(a).length, said.length, "and said nothing: this chat's compaction has a head to take out now");

    // The next compaction of the same chat, on the numbers it is on now: the part beside
    // a smaller keep leaves the chat well below the point, so this one wins its room, and
    // the only thing left for the portal is the question of length. This is the promise the
    // line was asked for — the state is not met again at the next turn.
    canCompact.add(a);
    const grew = {
      type: "compaction_end",
      reason: "threshold",
      willRetry: false,
      result: { summary: "y".repeat(23_108), usage: { input: 50_000, output: 5_777 }, tokensBefore: 79_304, estimatedTokensAfter: 69_037 },
    };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", grew);
    await flush();
    assert.ok(
      compactionRoomWonFor(landedRoomOf(grew), askedAbove),
      "the chat was left below the point: this compaction won its room",
    );
    assert.equal(
      fixedPartOf(landedRoomOf(grew), answers.keepRecentTokens, carriedSummaryOf(grew)),
      62_260,
      "and the same part is read from this landing, against the keep these numbers now hold",
    );
    assert.equal(pi.autoCompaction, true, "the chat's attempts are still its own to make");
    assert.equal(noticesOf(a).length, said.length, "said nothing at any of it");
  } finally {
    await reset();
  }
});

// The other half of the same reading: a compaction that won its room is left on the
// question of length, which was already answered there. Where a chat lands well below the
// point it is asked above, its next compaction has a whole head of new conversation to
// take out of, and the only thing that keeps it out of trouble is the document it carries
// — which the bounded ask keeps there.

test("a compaction that won its room is asked about its length and not stopped", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    canCompact.add(a);
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    const plan = planForModel({ contextWindow: WINDOW, maxTokens: ANSWER });
    const measured = { summary: "x".repeat(20_948), usage: { input: 22_396, output: 11_993 } };
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: { ...measured, tokensBefore: askedAbove + 2_000, estimatedTokensAfter: 31_238 } };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.ok(
      compactionRoomWonFor(landedRoomOf(at), askedAbove),
      "the chat was left far below the point it is asked above: this compaction won its room",
    );
    assert.equal(
      nextDocumentFitsFor(carriedSummaryOf({ result: measured }), plan.headTokens, ANSWER),
      false,
      "and the document it left is one merge from the model's answer: the merge after it does not fit",
    );
    assert.deepEqual(pi.compacts, [COMPACT_SHORT_SUMMARY], "so the bounded ask is worked there, as it was before");
    assert.equal(pi.autoCompaction, true, "nothing is stopped, and no line is said about a compaction that worked");
    assert.deepEqual(noticesOf(a), [], "said nothing");
  } finally {
    await reset();
  }
});

// The state a pair does not answer, which is the one the stop and the line are for: the
// chat's part is at the point these numbers ask above, so no pair of keeps has a cut above
// it and the room the chat has is its own. Said once, with the part named — a line that
// says only "these numbers are wrong" is a line a person cannot act on, and this chat's
// person was asked what the heck it meant.

test("a chat whose part leaves no pair is stopped there, and told what its part is", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a);

    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    // A chat of 75,000 tokens of instructions and tools, on the same pair: its compaction
    // took a real cut and left the chat above the point, and no pair of keeps — this
    // model's or another — has a head to ask for above that part.
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(75_000, 4_000) };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.ok(
      !compactionRoomWonFor(landedRoomOf(at), askedAbove),
      "the chat was left above the point these numbers ask above again: the room was not won",
    );
    assert.equal(
      fixedPartOf(landedRoomOf(at), own.keepRecentTokens, 4_000),
      75_000,
      "the part its landing says no compaction reads",
    );
    assert.equal(
      planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 75_000),
      null,
      "no pair these numbers can be made to answer this with: at this part the head is out of reach",
    );

    assert.equal(pi.autoCompaction, false, "this chat's attempts are stopped, and its switch is the chat's pi's alone");
    const line = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(line.length, 1, "said once, as this chat's stop, and not as a summary that went wrong");
    assert.ok(!line[0].includes("failing twice in a row"), "nothing about a summary failed here — the line says what did");
    assert.ok(
      line[0].includes(fmt(at.result.tokensBefore - at.result.estimatedTokensAfter)) &&
        line[0].includes(fmt(at.result.estimatedTokensAfter)) &&
        line[0].includes(fmt(askedAbove)),
      "the line carries the chat's own numbers: what it was left at, the point it was asked above, and what was taken out",
    );
    assert.ok(
      line[0].includes(fmt(75_000)) && line[0].includes("its instructions and the tools it is offered"),
      "and names the part above the reach of the pair: this is what its part is, in tokens and in share of the window",
    );
    assert.ok(
      line[0].includes("Nothing a pair of keep-recent and keep-free numbers does answers this"),
      "and says which kind this is: no numbers answer it, so it is not answered by a room typed for a summary",
    );
    assert.ok(!line[0].includes("Max output tokens"), "and offers no remedy a different kind of stop would answer");
    assert.deepEqual(pi.compacts, [], "no second summarization is paid for a room no second summarization can win");
    assert.equal(noticesOf(a).length, said.length + 1, "and only that line");

    // The same chat, asked by hand again: the stop is one act, and a person's own compaction
    // does not buy a second line about it.
    canCompact.add(a);
    pi.emit("event", { type: "compaction_start", reason: "manual" });
    pi.emit("event", { ...at, reason: "manual" });
    await flush();
    assert.equal(noticesOf(a).length, said.length + 1, "said once per chat, whatever comes after it");
    assert.equal(pi.autoCompaction, false, "the chat's switch stays where this chat's stop left it");
  } finally {
    await reset();
  }
});

// And the stop's kind is on the books beside its model: a portal that restarted leaves
// pi's file saying off, and the chat's line about it must say what its own last
// compaction reported, not what a summary did — a chat read as the wrong kind is a chat
// whose person goes looking for a longer answer in a model that was answering in full.

test("a chat stopped for no room is recorded as that kind, and said as it after a restart", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);

    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(75_000, 4_000) };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.equal(pi.autoCompaction, false, "the attempts are stopped");
    assert.deepEqual(
      compactionStops().filter((s) => s.sessionId === a),
      [{ sessionId: a, modelKey: "p/m" }],
      "the stop is on the books, with the model whose room is asked for",
    );
    assert.equal(compactionStopShape(a), COMPACT_STOP_NO_ROOM, "and as that kind, not as a summary that stopped");

    // The restart leaves pi's file saying off and nothing of the chat says so: reopened,
    // the chat is told its stop, and the line must name what its own compaction reported.
    assert.equal(sessions.explainCompactionStops(), 1, "one chat the portal stopped is explained");
    const restart = noticesOf(a).at(-1);
    assert.match(restart, /Auto-compaction is off for this chat: the portal stopped it here/);
    assert.match(restart, /\(p\/m\)/, "the line names the model whose room answers it");
    assert.match(
      restart,
      /after a compaction there left the chat at the point its own numbers ask above again/,
      "the line says the kind this chat was stopped for, which is not a summary that went wrong",
    );
    assert.ok(!restart.includes("failed twice in a row"), "and not as a summary that stopped twice");
    assert.ok(
      restart.includes(fmt(75_000)) && restart.includes("its own instructions and the tools it is offered"),
      "and names the part this chat's own compaction reported: after a restart the chat's person has no other way to find what is not conversation",
    );
  } finally {
    await reset();
  }
});

// The one-per-chat rule is one per stop the portal has not answered: the notice's own
// remedy is a room, and a room that arrived makes the numbers the stop stood on gone.
// A chat left on new numbers, after its switch was turned back on, is a new act, and the
// person needs to hear it — a silent second stop is a chat quietly running on a switch
// nobody turned off.

test("a chat whose stop was answered by room is stopped again, and says it again", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(75_000, 4_000) };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.equal(pi.autoCompaction, false, "stopped on these numbers");
    assert.equal(noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE)).length, 1, "said once for this stop");

    // The remedy the notice offered: this model is given room, which answers this chat's
    // stop and switches its attempts back on.
    const cleared = clearCompactionStops({ modelKey: "p/m" });
    assert.deepEqual(cleared, [a], "this model's room answers this chat's stop");
    assert.equal(await sessions.resumeStoppedCompaction(cleared, "p/m"), 1, "its pi was reached, and its switch turned back on");
    assert.equal(pi.autoCompaction, true, "its attempts are back on");

    // The chat goes on, grows, and is left above the point again: the room that made the
    // first stop harmless is gone, so this is a new act, and it is said as one — with the
    // numbers of this compaction, not of the one that was answered.
    const grew = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(80_000, 4_500) };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", grew);
    await flush();
    assert.equal(pi.autoCompaction, false, "stopped again, on the numbers it is on now");
    const lines = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(lines.length, 2, "said again: the new stop is not the old one being repeated");
    assert.ok(
      lines[1].includes(fmt(grew.result.estimatedTokensAfter)) && !lines[1].includes(fmt(at.result.estimatedTokensAfter)),
      "and with the numbers of this compaction, not of the one that was answered",
    );
    assert.ok(lines[1].includes(fmt(80_000)), "and with this chat's part as this compaction reads it, which is larger than the one that was answered");
  } finally {
    await reset();
  }
});

// A pair of a person's own is not the portal's to write over: the chat is still stopped
// where its part leaves the pair it is on out of reach of a cut, but the line may not say
// nothing answers it — a pair does, and the person has to be told where they would type it.

test("a chat on numbers of a person's own is told the pair that answers it is theirs to type", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    // The person's own numbers, on a model of this test's: a number for a model is not
    // the portal's to write over, and one test's model is not another's room.
    modelOf.set(a, { id: "card", provider: "p", name: "Card" });
    await writeCompactionModelRoom("p/card", { keepRecentTokens: 90_000, reserveTokens: 16_384 });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a);

    const own = effectiveCompactionTokens(readCompactionSettings(), "p/card");
    const askedAbove = WINDOW - own.reserveTokens;
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(25_000, 4_000, "p/card") };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.deepEqual(
      effectiveCompactionTokens(readCompactionSettings(), "p/card"),
      own,
      "the portal wrote nothing over a number of its own",
    );
    assert.equal(pi.autoCompaction, false, "and the chat is still stopped where a cut is out of reach");
    const line = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(line.length, 1, "said once");
    const answers = planRoom(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 25_000));
    assert.ok(answers, "a pair does answer this chat's part");
    assert.ok(
      line[0].includes(`keep-recent ${fmt(answers.keepRecentTokens)}, keep-free ${fmt(answers.reserveTokens)}`) &&
        line[0].includes("it is yours to type"),
      "so the line names that pair and says where a person types it, rather than saying nothing answers this",
    );
    assert.ok(
      line[0].includes("the portal does not write over numbers of your own"),
      "and says why it was not written for them",
    );
  } finally {
    await reset();
  }
});

// A pi that reports no landing: an older one, or one whose compaction wrote no such field.
// Unknown is not unwon — the length question is the one this chat already answers, and
// stopping it on an unknown landing would take a working chat's switch on no evidence.

test("a compaction that reports no landing is left as it was", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    canCompact.add(a);
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const noLanding = { summary: "x".repeat(20_948), usage: { input: 22_396, output: 11_993 } };
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: noLanding };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.equal(landedRoomOf(at), null, "there is no landing to be read");
    assert.deepEqual(pi.compacts, [COMPACT_SHORT_SUMMARY], "the length question is still the one asked, as it was");
    assert.equal(pi.autoCompaction, true, "and no chat's switch is taken on an unknown landing");
    assert.deepEqual(noticesOf(a), [], "said nothing");
  } finally {
    await reset();
  }
});
