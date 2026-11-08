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
//
// The other shape of a "length" stop is the opposite, and carrying it on is what
// broke chats: a model with the chat's context already full has no room left to
// answer at all, so it stops on "length" having written a few hundred tokens —
// often nothing but thinking. pi calls that shape recoverable length and gives it
// a compact and a retry, never a continuation. Measured in aCSvv1KGQ9yf, four
// carries in 3 seconds, each answer a single token of thinking, the chat's last
// lines a repeated sentence. So the carry-on is sent only for an answer that used
// the output it was given; the other stop is said, once, and the room goes.

const home = inProcessHome("pithagoras-cut-off-");
mkdirSync(path.join(home, "work"), { recursive: true });

const { createSession, eventsSince, getSession, getDb, setSingleActiveSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
test.after(() => getDb().close());

/** What one answer gets in the chats' model, as pi says it. */
const LIMIT = 16384;

/**
 * Chats whose pi cannot say what one answer gets — a container's pi, an older
 * one. The limit is dropped and the answer's own shape is the test: an answer
 * in hand is carried on, thinking only is not.
 */
const limitUnknown = new Set();

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
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
    return { model: { id: "m", name: "M", provider: "p", contextWindow: 131072, maxTokens: limitUnknown.has(this.sessionId) ? undefined : LIMIT, input: ["text"] }, thinkingLevel: "off" };
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
  /**
   * The last message of a run, and how the model stopped. `out` is what the
   * answer wrote, `parts` its content as the chat sees it: "text" is an answer,
   * "thinking" is only the model's reasoning, which the person cannot carry on
   * from.
   */
  end(stopReason = "stop", { out = 40, parts = ["text"], usage = true } = {}) {
    this.last(stopReason, { out, parts, usage });
    this.emit("event", { type: "agent_end", willRetry: false });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
  /** The last assistant message of a run, as the chat sees it. */
  last(stopReason = "stop", { out = 40, parts = ["text"], usage = true } = {}) {
    this.emit(
      "event",
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason,
          ...(usage ? { usage: { input: 100, output: out, totalTokens: 100 + out } } : {}),
          content: parts.map((kind) => (kind === "text" ? { type: "text", text: "mid-sentence" } : { type: "thinking", thinking: "mid-thought" })),
        },
      },
    );
  }
  /**
   * A compaction that caught the run mid-turn (a compact-by-hand of a running
   * chat: pi aborts the run first), settling on the answer it had reached. The
   * turn is left in hand, and the answer was cut off — both ends of it ask for
   * the same thing: one line carrying it on.
   */
  interrupt(stopReason = "length", over = {}) {
    this.emit("event", { type: "compaction_start" });
    this.last(stopReason, over);
    this.emit("event", { type: "agent_end", willRetry: false });
    this.emit("event", { type: "compaction_end", reason: "manual", willRetry: false, result: { summary: "s" } });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
  /** Carries of ours the chat was asked, in order. */
  carries() {
    return this.prompts.filter((p) => p === CARRY_ON).length;
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
  sessions.cutOffAnswer.clear();
  sessions.modelOutputLimit.clear();
  sessions.singleActiveClaiming.clear();
  sessions.singleActiveQueue = [];
}

/** The chat's lines of a kind, in order: the portal's notices, the carries it was asked to send. */
function notices(id) {
  return eventsSince(id, 0)
    .filter((e) => e.type === "portal_notice")
    .map((e) => String(JSON.parse(e.payload).text ?? ""));
}

function resumeLines(id) {
  return eventsSince(id, 0)
    .filter((e) => e.type === "portal_prompt")
    .map((e) => JSON.parse(e.payload))
    .filter((p) => p.resume);
}

/** An answer cut off at the model's output limit: all of it written, mid-sentence. */
const AT_LIMIT = { out: LIMIT, parts: ["text"] };
/** The other stop: the chat's context is full, so the model writes almost nothing. */
const NO_ROOM = { out: 1, parts: ["thinking"] };

const CARRY_ON = "Carry on where you left off. Your last answer was cut off at the model's output limit, mid-sentence, not at the end of the work.";
const PICK_UP = "Compaction detected, resume where you left off if needed.";

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
    aPi.end("length", AT_LIMIT);
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

    // The chat shows the carry-on as the portal's line, not as the person's
    // words repeated: the line that records it says whose it is.
    assert.deepEqual(resumeLines(a).map((p) => p.resume), ["cut-off"], "the carry-on is marked as the portal's");

    // Nothing was said about the run ending: it is not over.
    assert.deepEqual(notices(a), [], "the gap says nothing");

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
      aPi.end("length", AT_LIMIT);
      await flush();
      const carried = aPi.carries();
      assert.equal(carried, Math.min(cutOffs, 3), `carried on ${Math.min(cutOffs, 3)} time(s)`);
      if (cutOffs < 4) assert.deepEqual(started, [a], "B never started beside A");
    }
    assert.equal(sessions.cutOffResumePending.has(a), false, "the last idle let the room go");
    assert.equal(sessions.isActive(a), false, "A is done, out of carry-on budget");
    assert.deepEqual(started, [a, b], "B takes the room once A is truly done");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");

    // The chat's last line says why it stopped: four answers stopped at the same
    // limit, and what would give the chat room. Not a fourth carry-on, which is
    // what the person read as the chat answering itself.
    const said = notices(a);
    assert.equal(said.length, 1, "the end was said once");
    assert.match(said[0], /stopped at its output limit 4 times in a row/);
    assert.match(said[0], /Max output tokens/);
  } finally {
    reset();
  }
});

test("a model with no room left in its context is not carried on, and says why", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();

    // The chat sits at the end of its context: the model stops on "length"
    // having written one token of thinking. This is the shape that answered the
    // same carry-on sentence four times in 3 seconds.
    aPi.end("length", NO_ROOM);
    await flush();

    assert.equal(aPi.carries(), 0, "nothing was carried on: there was no answer cut off");
    assert.equal(sessions.cutOffResumePending.has(a), false, "no gap is held");
    assert.equal(sessions.isActive(a), false, "the room is not held for a resume that will not come");
    assert.equal(getSession(a).status, "idle", "the run ended");

    const said = notices(a);
    assert.equal(said.length, 1, "the stop was said once");
    assert.match(said[0], /stopped in the middle of its thinking, without writing an answer/);
    assert.match(said[0], /without writing an answer\. It wrote 1 token, where one answer gets 16,384/);
    assert.match(said[0], /context being full/);

    // The room is free, so the waiting Task starts: the queue is not stalled by
    // a run the portal refused to carry on.
    assert.deepEqual(started, [a, b], "B took the room");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");
  } finally {
    reset();
  }
});

test("an answer stopped short of its limit is left as an end, with its tokens named", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // A provider that truncates mid-answer, well short of the model's limit: an
    // answer in hand, and the same context-pressure remedy.
    aPi.end("length", { out: 987, parts: ["text"] });
    await flush();

    assert.equal(aPi.carries(), 0, "no carry-on: the answer did not run out of its output");
    const said = notices(a);
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /stopped in the middle of its answer\. It wrote 987 tokens/);
  } finally {
    reset();
  }
});

test("a run that ends on its own terms is carried on afresh next time", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // A cut-off carried on, the carried-on run ending properly, then a new
    // cut-off in the same chat: the budget of a finished turn is not spent.
    aPi.end("length", AT_LIMIT);
    await flush();
    assert.equal(aPi.carries(), 1, "carried on once");
    assert.equal(sessions.cutOffCarries.get(a), 1, "the carry counts in this turn");

    aPi.end("stop");
    await flush();
    assert.equal(sessions.cutOffCarries.has(a), false, "the budget was spent with the turn");

    aPi.end("length", AT_LIMIT);
    await flush();
    assert.equal(aPi.carries(), 2, "the next cut-off gets its own three carries");
    assert.equal(sessions.cutOffCarries.get(a), 1, "counted from the start again");
    aPi.end("stop");
    await flush();
  } finally {
    reset();
  }
});

// A compact-by-hand of a running chat aborts the run, and the answer it had
// reached can be the cut-off kind. Both ends of that settle ask for the turn to
// be carried on — and the two resumes pi was going to send land as one message
// queued into the run the other started, where the model reads it as an order to
// work. That is the shape a person sees as a repeated message, so one settle
// gives one line.
test("a compaction that caught a cut-off run carries it on once, not twice", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    aPi.interrupt("length", AT_LIMIT);
    await flush();

    assert.equal(aPi.carries(), 1, "carried on once");
    assert.equal(aPi.prompts.filter((p) => p === PICK_UP).length, 0, "the compaction's pick-up is not sent beside it");
    assert.deepEqual(resumeLines(a).map((p) => p.resume), ["cut-off"], "one line of the portal's, and it says which");
    assert.deepEqual(notices(a), [], "the gap says nothing: the turn is going on");

    // The carried-on run ends on its own terms and the room is handed over.
    aPi.end("stop");
    await flush();
    assert.equal(sessions.isActive(a), false, "A is done");
    assert.equal(sessions.compactionResumePending.has(a), false, "no pick-up is left waiting on a run that has ended");
  } finally {
    reset();
  }
});

// A pi that cannot say what one answer gets — a container's pi, an older one —
// leaves the portal with the answer's own shape as the test. An answer in hand is
// a carry-on; one that wrote only thinking is the chat's context being full, and
// a carry-on of that is the same sentence answered the same way.
test("a chat whose model cannot name its limit is carried on by the answer in hand, and says the limit when the carries run out", async () => {
  try {
    const a = chat();
    limitUnknown.add(a);
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // Four cut-off ends, each an answer mid-sentence: three carries, and the
    // fourth is an end with its reason — the output-limit one, not the context
    // one, which is what the unknown limit must not claim.
    for (let cutOffs = 1; cutOffs <= 4; cutOffs++) {
      aPi.end("length", { out: 40, parts: ["text"] });
      await flush();
      assert.equal(aPi.carries(), Math.min(cutOffs, 3), `carried on ${Math.min(cutOffs, 3)} time(s)`);
    }

    const said = notices(a);
    assert.equal(said.length, 1, "the end was said once");
    assert.match(said[0], /stopped at its output limit 4 times in a row/);
    assert.ok(!/context being full/.test(said[0]), "it does not claim the context was full: the limit was never measured");
  } finally {
    reset();
  }
});

test("a chat whose limit is unknown and whose answer was only thinking is not carried on", async () => {
  try {
    const a = chat();
    limitUnknown.add(a);
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    aPi.end("length", { out: 1, parts: ["thinking"] });
    await flush();

    assert.equal(aPi.carries(), 0, "nothing carried on: there was no answer to carry on from");
    const said = notices(a);
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /in the middle of its thinking, without writing an answer/);
    assert.match(said[0], /context being full/);
    assert.ok(!said[0].includes("16,384"), "no limit is named: this chat's model never said one");
    assert.equal(sessions.isActive(a), false, "the room is not held for a resume that will not come");
  } finally {
    reset();
  }
});

// A provider that answers without token counts (usage.output is 0 for every message) is
// the other half of the missing measurement. The model's limit is known, so the numbers
// look complete: 0 is "far short of 16,384", which is the shape the portal refuses to
// carry on. It is not: 0 is a count that never happened, and a chat whose answer stopped
// mid-sentence at its limit loses the carry-on that keeps its work — the shape the Task
// watcher then settles as a finished attempt, and the queue starts the Task over in a
// brand-new session. The answer's own shape is the test for such a chat.
test("a provider that reports no token counts is carried on by the answer in hand", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // The model's limit is known (16,384), the message carries no usage at all.
    for (let cutOffs = 1; cutOffs <= 4; cutOffs++) {
      aPi.end("length", { out: 0, parts: ["text"], usage: false });
      await flush();
      assert.equal(aPi.carries(), Math.min(cutOffs, 3), `carried on ${Math.min(cutOffs, 3)} time(s)`);
    }

    const said = notices(a);
    assert.equal(said.length, 1, "the end was said once, when the carries ran out");
    assert.match(said[0], /stopped at its output limit 4 times in a row/);
    assert.ok(!/context being full/.test(said[0]), "it does not claim the context was full: nothing was measured");
    assert.ok(!/It wrote/.test(said[0]), "and it names no token count of an answer that reported none");
  } finally {
    reset();
  }
});

// Thinking only, with no count either: there is no answer to carry on from, and the chat's
// context being full is what the line says. Same chat as the four carries in aCSvv1KGQ9yf.
test("a provider that reports no token counts does not carry on an answer that was only thinking", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    aPi.end("length", { out: 0, parts: ["thinking"], usage: false });
    await flush();

    assert.equal(aPi.carries(), 0, "nothing carried on");
    const said = notices(a);
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /in the middle of its thinking, without writing an answer/);
    assert.match(said[0], /context being full/);
    assert.ok(!/It wrote/.test(said[0]), "no token count is named for a message that reported none");
  } finally {
    reset();
  }
});
