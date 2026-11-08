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
// token window against the 98,072 it was asked above at. That chat's document climbed to
// the model's answer there, and the merge after it stopped in the middle — the pair of
// notices its person read. So the stop and the line are worked at the compaction that
// won no room, once per chat, and a chat whose compaction did win room is left on the
// question of length, which was already answered there.

const home = inProcessHome("pithagoras-compaction-no-room-");
mkdirSync(path.join(home, "work"), { recursive: true });

const {
  createSession,
  appendEvent,
  chatsWithCompactionOffByChoice,
  clearCompactionStops,
  compactionStops,
  eventsSince,
  getSession,
  getDb,
  noteCompactionChoice,
  setSingleActiveSession,
} = await import("../dist/db.js");
const { readCompactionSettings, writeCompactionSettings, effectiveCompactionTokens } = await import("../dist/pi-settings.js");
const {
  carriedSummaryOf,
  COMPACT_NO_ROOM_NOTICE,
  COMPACT_SHORT_SUMMARY,
  planForModel,
  nextDocumentFitsFor,
  landedRoomOf,
  compactionRoomWonFor,
} = await import("../dist/compaction-ladder.js");
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
      model: { id: "m", name: "M", provider: "p", input: ["text"], ...(knownSizes.get(this.sessionId) ?? {}) },
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

const WINDOW = 131_072;
const ANSWER = 16_384;

test("a compaction that left the chat where it was asked again is stopped there", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a);

    // What the numbers in pi's file actually leave this chat doing: the pair every chat
    // inherits, read at this model's window — that is the point the next turn is measured
    // against, and not a plan's own.
    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    assert.ok(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }), "a model this module has numbers for");

    // A compaction that worked, took a real cut out of the chat, and left it above the
    // point it is asked above: nothing about a summary went wrong, and the cut it made is
    // not what gets the chat below that point.
    const left = { summary: "x".repeat(16_000), usage: { input: 40_000, output: 4_000 } };
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: { ...left, tokensBefore: askedAbove + 4_000, estimatedTokensAfter: askedAbove + 1_000 } };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.ok(
      !compactionRoomWonFor(landedRoomOf(at), askedAbove),
      "the chat was left above the point these numbers ask above again: the room was not won",
    );
    assert.equal(pi.autoCompaction, false, "this chat's attempts are stopped, and its switch is the chat's pi's alone");
    const line = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(line.length, 1, "said once, as this chat's stop, and not as a summary that went wrong");
    assert.ok(!line[0].includes("failing twice in a row"), "nothing about a summary failed here — the line says what did");
    assert.ok(
      line[0].includes(fmt(askedAbove + 1_000)) && line[0].includes(fmt(askedAbove)) && line[0].includes(fmt(3_000)),
      "the line carries the chat's own numbers: what it was left at, the point it was asked above, and what was taken out",
    );
    assert.deepEqual(pi.compacts, [], "no second summarization is paid for a room no second summarization can win");
    const notices = noticesOf(a);
    assert.equal(notices.length, said.length + 1, "and only that line");

    // The same chat, asked by hand again and left where it was asked again: the stop is
    // one act, and a person's own compaction does not buy a second line about it.
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
    const left = { summary: "x".repeat(16_000), usage: { input: 40_000, output: 4_000 } };
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: { ...left, tokensBefore: askedAbove + 4_000, estimatedTokensAfter: askedAbove + 1_000 } };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    assert.equal(pi.autoCompaction, false, "the attempts are stopped");
    assert.deepEqual(
      compactionStops().filter((s) => s.sessionId === a),
      [{ sessionId: a, modelKey: "p/m" }],
      "the stop is on the books, with the model whose room is asked for",
    );

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
    const left = { summary: "x".repeat(16_000), usage: { input: 40_000, output: 4_000 } };
    const said = noticesOf(a);
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { ...left, tokensBefore: askedAbove + 4_000, estimatedTokensAfter: askedAbove + 1_000 } });
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
    const grew = { summary: "y".repeat(18_000), usage: { input: 50_000, output: 4_500 } };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { ...grew, tokensBefore: askedAbove + 9_000, estimatedTokensAfter: askedAbove + 3_000 } });
    await flush();
    assert.equal(pi.autoCompaction, false, "stopped again, on the numbers it is on now");
    const lines = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(lines.length, 2, "said again: the new stop is not the old one being repeated");
    assert.ok(
      lines[1].includes(fmt(askedAbove + 3_000)) && !lines[1].includes(fmt(askedAbove + 1_000)),
      "and with the numbers of this compaction, not of the one that was answered",
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
