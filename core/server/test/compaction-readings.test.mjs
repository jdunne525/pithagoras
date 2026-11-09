import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";
// A model's largest reading is not every chat's reading, and a pair is asked with the
// largest that leaves one rather than the largest that exists (`compaction-ladder.ts`'s
// fact 8). The state measured on the Task queue of 9 November, on one model — sixteen
// chats in a row, a 131,072-token window, a 16,384-token answer — was fourteen chats
// stopped by the reading above, their runs dying at 97% of their windows, and fifteen
// chats compacting two to four times each first, taking 4,812-15,116 tokens out each time
// and left at 98,106-100,164 of the 98,072 they are asked above again. Their parts read
// from their own landings were 64,502 to 66,348 tokens; one other chat on the same model
// read 72,732, and the pair had been asked with that — which answers nothing at all, since
// at 72,732 the floor keep leaves a head of 11,340 with a document of 12,000 written about
// it, no cut. Asked at the readings the fourteen actually had, the same model is answered
// with a real cut. So the pair the next chat was given was the model's own pair, asked as
// though nothing sat above a chat's conversation: a pair that takes a few thousand out of a
// context it has only just been asked above. The tests below ask the two readings separately
// — a chat's own for that chat, a model's largest for a pair written under its name — and
// check that a chat whose pair leaves it no cut beside its own reading is sized on the pair
// asked at that reading, at either landing, before its next compaction is asked, and that a
// chat at a part no pair answers is told at its own numbers rather than the model's larger
// ones.

const home = inProcessHome("pithagoras-compaction-readings-");
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
  noteCompactionPlan,
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
  roomShapeFor,
  roomFaultFor,
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
  const id = `rd${++count}`;
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

// The first of the two questions: this chat's own reading, of the part no compaction reads.
// A compaction that worked is asked about at its own landing, not only at one that won none:
// on the measured model the pair in force left a chat no cut at all beside its reading, and
// the state reached its stop at a chat's third or fourth compaction, three compactions' worth
// of room spent before anything was said.

test("a compaction that won its room, on numbers that leave this chat no cut beside its own reading, is answered with the pair asked at that reading", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    // One chat on this model, at its own compaction's landing, read 72,732 tokens of
    // instructions and tools above its conversation: the largest reading on the books, and
    // one larger than any pair of these numbers fits above — at it the floor keep leaves a
    // head of 11,340 with a document of 12,000 written about it, no cut.
    putSetting("fixed_part_model:p/m", "72732");
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a).length;

    // The chat opened on this model while none of its own readings was on the books, so it
    // is on the model's own pair — 30,460 of a 131,072-token window kept word for word,
    // asked above at 98,072. That is the pair the measured chats ran, and the one that took
    // 4,812-15,116 tokens out of a context it had only just been asked above.
    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    assert.equal(own.reserveTokens, 33_000, "the model's own pair, asked with nothing above a chat's conversation");

    // The measured first compaction of one of those chats: 1,371 tokens written, a chat left
    // at 89,305 of its window, and its own reading 57,474 — 5,402 below the largest this
    // model's chats read, and a reading a pair of these numbers can be asked with.
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(57_474, 1_371) };
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();
    const landed = landedRoomOf(at);

    assert.ok(compactionRoomWonFor(landed, askedAbove), "this compaction won its room: the chat was left below the point");
    assert.equal(fixedPartOf(landed, own.keepRecentTokens, carriedSummaryOf(at)), 57_474, "and this chat reads 57,474 tokens above its conversation");

    // What the pair in force does to a chat of that reading: nothing-left-to-cut. Its keep,
    // counted twice, and the part beside it come to more than the point, so the next
    // compaction has only what the chat just added to take out of — and that is the state
    // the rounds above reached three times over before they reached their stop.
    const shape = roomShapeFor({ contextWindow: WINDOW, maxTokens: ANSWER }, own, 57_474);
    assert.equal(shape && roomFaultFor(shape), "nothing-left-to-cut", "the pair this chat runs on leaves it no cut beside its own reading");
    assert.equal(chatFixedPart(a), 57_474, "kept for this chat, where it can be asked again at it");
    assert.equal(modelFixedPart("p/m"), 72_732, "and the model still holds the larger reading, which is not what this chat is asked with");

    // The answer to that state is the pair asked at this chat's own reading, and it is written
    // without a word: the chat's next compaction has a whole head of real conversation to take
    // out of. Nothing is asked of this chat's pi, and the pair the model's largest reading would
    // be asked with — none — is not what this chat works on.
    const answers = planRoom(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 57_474));
    assert.ok(answers, "a pair answers this chat's reading: it is below the point where these numbers stop having a head");
    assert.deepEqual(effectiveCompactionTokens(readCompactionSettings(), "p/m"), answers, "written under the model's name, at this chat's reading");
    assert.equal(pi.autoCompaction, true, "and this chat's attempts are left running on it");
    assert.deepEqual(pi.compacts, [], "nothing was asked of this chat's pi: a pair answers, so no second summarization is paid");
    assert.equal(noticesOf(a).length, said, "and said nothing: this chat's compaction has a head to take out of now");
  } finally {
    await reset();
  }
});

// The other half of the same two questions: a model's largest reading, which a pair written
// under its name has to answer for, is asked only as far as it leaves a pair. Where it leaves
// none, the pair the portal last wrote — asked with one of these chats' own readings, and the
// only pair they have been seen to need — is what a chat opened on this model later reads,
// rather than being sized back to the model's own pair.

test("a chat opened after a chat's own reading sized the model is not sized back to a pair no reading of this model answers", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    // The pair one of these chats was sized on, and the plan that says it was asked with it.
    const held = planRoom(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 57_474));
    await writeCompactionModelRoom("p/m", held);
    noteCompactionPlan("p/m", held);
    putSetting("fixed_part_model:p/m", "72732");
    const c = chat();
    knownSizes.set(c, { contextWindow: WINDOW, maxTokens: ANSWER });
    await sessions.prompt(c, "work on C");
    await flush();

    assert.equal(chatFixedPart(c), 0, "this chat has read nothing of its own: the only reading on the books is larger than any pair fits");
    assert.equal(modelFixedPart("p/m"), 72_732, "that reading, held for this model, answers no pair at all");
    assert.deepEqual(effectiveCompactionTokens(readCompactionSettings(), "p/m"), held, "the pair asked with one of these chats' own readings stays in place, rather than the model's own pair, which is known not to answer the largest of them");
    for (const line of noticesOf(c)) {
      assert.ok(!line.includes(fmt(30_460)), "and no line of this chat's offers the pair no reading of this model can be asked with");
    }
  } finally {
    await reset();
  }
});

// And where the reading is a chat's own — a part no pair of these numbers answers — that chat
// is the one stopped, and told at its own numbers. A model's larger reading is not a reason to
// stop every chat on it, and a line about a part this chat never read is a line a person
// cannot act on.

test("a chat at a part no pair answers is stopped and told at its own reading, not at a larger one another chat read", async () => {
  try {
    setSingleActiveSession(false);
    await inheritRoom();
    const a = chat();
    knownSizes.set(a, { contextWindow: WINDOW, maxTokens: ANSWER });
    // The pair this model runs on, and the plan that says the portal wrote it: these are
    // nobody's own numbers, and a line about them is the portal's to make.
    const pair = planRoom(planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }));
    await writeCompactionModelRoom("p/m", pair);
    noteCompactionPlan("p/m", pair);
    // Another chat on this model, one whose run died at the wall without a landing, read a
    // part larger still: 80,000 of the 131,072. It is on the books for the model, and it is
    // not what this chat is asked with.
    putSetting("fixed_part_model:p/m", "80000");
    await sessions.prompt(a, "work on A");
    await flush();
    const pi = pis.get(a);
    const said = noticesOf(a).length;

    // This chat's own reading, at the point no pair of these numbers has a cut above: 72,732.
    // Its compaction took a real cut out, and left the chat above the point again.
    const at = { type: "compaction_end", reason: "threshold", willRetry: false, result: left(72_732, 3_000) };
    const own = effectiveCompactionTokens(readCompactionSettings(), "p/m");
    const askedAbove = WINDOW - own.reserveTokens;
    pi.emit("event", { type: "compaction_start", reason: "threshold" });
    pi.emit("event", at);
    await flush();

    assert.ok(!compactionRoomWonFor(landedRoomOf(at), askedAbove), "the chat was left above the point these numbers ask above: the room was not won");
    assert.equal(chatFixedPart(a), 72_732, "this chat's own part, kept for its own next landing");
    assert.equal(modelFixedPart("p/m"), 80_000, "the model's larger reading, kept for a pair asked under its name");
    assert.equal(
      planForModel({ contextWindow: WINDOW, maxTokens: ANSWER }, 72_732),
      null,
      "no pair of these numbers is answered at this chat's reading, so its room is its own",
    );

    assert.equal(pi.autoCompaction, false, "this chat's attempts are stopped, on its own reading");
    const line = noticesOf(a).filter((t) => t.startsWith(COMPACT_NO_ROOM_NOTICE));
    assert.equal(line.length, 1, "said once, as this chat's stop");
    assert.ok(line[0].includes(fmt(72_732)) && line[0].includes("its instructions and the tools it is offered"), "and names this chat's part above the reach of the pair");
    assert.ok(!line[0].includes(fmt(80_000)), "not the larger reading another chat of this model read, which this chat cannot act on");
    assert.equal(noticesOf(a).length, said + 1, "and only that line");
    assert.deepEqual(pi.compacts, [], "no second summarization is paid for a room no second summarization can win");
  } finally {
    await reset();
  }
});
