import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a run that ended with nothing said does.
//
// A model can conclude a turn having written nothing anyone can read: the answer is
// its thinking alone, with no words and no tool call in it. Pi ends the run there —
// a message with no tool call is the end of a turn — and the session goes idle with
// the chat's last line unspoken. On the Tasks page that is read as a run that ended
// on its own terms: the watcher settles the attempt, finds no completion promise,
// writes it failed, and the queue launches a brand-new session that starts the Task
// again from nothing, over work that was still in hand.
//
// The `E2` Task of BlastRunHero is that, twice over on 12 November (`16717a00`): its
// first session (`yjckQTDUMmcu`) worked to 155,266 tokens, was compacted at 20:01:26,
// carried on with two turns of real work, and at 20:02:08 answered with 26 tokens of
// thinking alone (`stopReason: stop`, "Both are already done — the summary cut off
// mid-work"). Nothing carried that on; the attempt was written failed at 20:02:14 and
// a fresh session (`jUdRXLUPLc6J`) began the Task from nothing at 20:02:15 and had to
// find the whole of the work again. Eight other chats on this machine ended a run the
// same way, each on a `stop` with nothing but thinking in it.
//
// That end is neither of the two the portal already carries on. It is not a compaction
// that caught the turn — pi started its own next turn after the compaction and the
// work went on past it — and it is not a run out of output tokens. Nor is it the
// shape the cut-off test refuses to carry: an answer that stopped on `length` having
// written only thinking is the chat's context having no room left, and a carry-on of
// that is the same nothing written again (see cut-off-run.test.mjs). Here the model
// had room — 38,619 of a 131,072-token window — and concluded the turn anyway. What
// it wrote is nothing to carry on *from*, but what it left is work.
//
// So a `stop` whose answer wrote nothing carries on in the same session, on the same
// budget of carries the cut-off answer has, and the gap before it lands holds the room
// and keeps the Task's attempt open exactly as the other two gaps do. It is bounded:
// a model that answers nothing turn after turn is said once, at the end, and the room
// goes — the attempt then settles like any ended run, and the queue's next session is
// the honest answer for a model that cannot finish a turn.

const home = inProcessHome("pithagoras-silent-answer-");
mkdirSync(path.join(home, "work"), { recursive: true });

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const execution = await import("../dist/task-execution.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
test.after(() => db.getDb().close());

/** What one answer gets in the chats' model, as pi says it. */
const LIMIT = 16384;

/** The line that carries a turn ending on its thinking alone back on. */
const PICK_UP = "Carry on where you left off. Your last turn ended with only its thinking, no answer and no work asked for, which is not the end of the work.";
/** The promise a Task's answer is judged on. */
const PROMISE = "<PROMISE>THIS TASK IS DONE</PROMISE>";

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionFile = path.join(opts.sessionDir ?? ".", "conversation.jsonl");
  }
  /** Whether a run is going; the manager asks before settling a prompt. */
  idle = true;
  /** The pi process is up: what the manager asks before starting one for a message. */
  running = true;
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
      model: { id: "m", name: "M", provider: "p", contextWindow: 131_072, maxTokens: LIMIT, input: ["text"] },
      thinkingLevel: "off",
    };
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
  /** One turn of work: an answer that went on asking for tools. */
  turn() {
    this.emit("event", { type: "turn_start" });
    this.last("toolUse", { parts: ["thinking", "toolCall"] });
    this.emit("event", { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} });
    this.emit("event", { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [] } });
    this.emit("event", { type: "message_end", message: { role: "toolResult", content: [] } });
    this.emit("event", { type: "turn_end" });
  }
  /** pi's own auto-compaction at a turn boundary, and the turn it starts after it. */
  compact() {
    this.emit("event", { type: "compaction_start", reason: "threshold" });
    this.emit("event", { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "the chat's summary" } });
    this.emit("event", { type: "turn_start" });
  }
  /** The last assistant message of a run. `parts` is what it wrote: "text" is an
   *  answer the person sees, "toolCall" work it asked for, "thinking" only the
   *  model's reasoning. */
  last(stopReason = "stop", { parts = ["text"], out = 40, text = "an answer" } = {}) {
    this.emit(
      "event",
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason,
          usage: { input: 100, output: out, totalTokens: 100 + out },
          content: parts.map((kind) =>
            kind === "text"
              ? { type: "text", text }
              : kind === "toolCall"
                ? { type: "toolCall", id: "call_1", name: "bash", arguments: {} }
                : { type: "thinking", thinking: "what the model thought, and nothing else" },
          ),
        },
      },
    );
  }
  /** Where the run ends: the last answer, and how the model stopped on it. */
  async end(stopReason = "stop", over = {}) {
    this.last(stopReason, over);
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_end", willRetry: false });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
  /** Carries of ours the chat was asked, in order. */
  carries(text) {
    return this.prompts.filter((p) => p === text).length;
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

/** Lets the fire-and-forget run path reach pi and the queue reach its next item. */
const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for an attempt to be written as settled: the completion check reads the
 * transcript with its own bounded waits before it decides.
 */
async function settled(attemptId, limitMs = 12_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const row = db.getAttempt(attemptId);
    if (row && row.status !== "running") return row;
    if (Date.now() >= deadline) return row;
    await flush(200);
  }
}

/** A Task's session: autonomous, in a folder of its own that exists. */
let count = 0;
function chat() {
  const id = `sa${++count}`;
  db.createSession({ id, title: id, workspace: path.join(home, "work"), executor: "host", kind: "task" });
  return id;
}
const task = () => tasks.createTask({ title: `sat${++count}`, workspace: path.join(home, "work") });

/** The chat's lines of a kind, in order: the portal's notices, the carries it was asked. */
function notices(id) {
  return db
    .eventsSince(id, 0)
    .filter((e) => e.type === "portal_notice")
    .map((e) => String(JSON.parse(e.payload).text ?? ""));
}

function resumeLines(id) {
  return db
    .eventsSince(id, 0)
    .filter((e) => e.type === "portal_prompt")
    .map((e) => JSON.parse(e.payload))
    .filter((p) => p.resume);
}

/** One test's sessions do not leave another's room held. */
function reset() {
  started.length = 0;
  pis.clear();
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

test("a run that ended with nothing said carries on in its own session", async () => {
  try {
    db.setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    assert.deepEqual(started, [a], "A reached the engine");

    await sessions.prompt(b, "work on B").then(
      () => assert.fail("B should wait its turn"),
      (e) => assert.equal(e.name, "PromptQueuedForSingleActive", "B is held behind A"),
    );
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "B waits its turn");

    // The turn pi concluded on its thinking alone: no words, no work asked for, and
    // the model stopping of its own accord — the end BlastRunHero's E2 chat reached at
    // 20:02:08 on 12 November.
    await aPi.end("stop", { parts: ["thinking"], out: 26 });

    assert.equal(db.getSession(a).status, "idle", "the session reads idle in the gap");
    assert.equal(sessions.cutOffResumePending.has(a), true, "the gap is marked");
    assert.equal(sessions.isActive(a), true, "the idle session still holds the room");
    assert.equal(sessions.isCompacting(a), true, "and is not read as ended");
    assert.deepEqual(
      sessions.cutOffAnswer.get(a),
      { output: 26, wrote: false, askedAsText: false, errorMessage: "" },
      "the answer's shape is the test",
    );

    await flush();
    assert.equal(aPi.carries(PICK_UP), 1, "the turn was carried on");
    assert.deepEqual(started, [a], "B did not take the room in the gap");
    assert.equal(sessions.singleActiveQueue.length, 1, "B is still waiting");
    assert.deepEqual(aPi.prompts, ["work on A", PICK_UP], "the carry-on went to A, where its work still lives");
    assert.equal(sessions.inRun.has(a), true, "the carried-on run holds the room");
    assert.equal(sessions.cutOffResumePending.has(a), false, "the gap is over");

    // The chat shows it as the portal's line, saying which turn it picks up.
    assert.deepEqual(resumeLines(a).map((p) => p.resume), ["silent"], "one line of the portal's, and it says which");
    assert.deepEqual(notices(a), [], "the gap says nothing: the turn is going on");

    // The carried-on turn answers in words, and only that end hands the room over.
    await aPi.end("stop", { parts: ["text"], text: "done" });
    await flush();
    assert.deepEqual(started, [a, b], "B takes the room once A has truly ended");
    assert.equal(sessions.singleActiveQueue.length, 0, "the queue drained");
    assert.deepEqual(notices(a), [], "an end with an answer in it says nothing");
  } finally {
    db.setSingleActiveSession(false);
    await reset();
  }
});

test("a model that keeps ending on its thinking is carried on a bounded number of times", async () => {
  try {
    db.setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    await sessions.prompt(b, "work on B").catch(() => {});
    await flush();

    // Four ends on nothing but thinking: three carries, and the fourth left as an
    // end, so a model that answers nothing forever cannot keep the room open.
    for (let n = 1; n <= 4; n++) {
      await aPi.end("stop", { parts: ["thinking"], out: 26 });
      await flush();
      assert.equal(aPi.carries(PICK_UP), Math.min(n, 3), `carried on ${Math.min(n, 3)} time(s)`);
    }

    assert.equal(sessions.cutOffResumePending.has(a), false, "the last idle let the room go");
    assert.equal(sessions.isActive(a), false, "A is done, out of carry-on budget");
    assert.deepEqual(started, [a, b], "B took the room once A was done");

    const said = notices(a);
    assert.equal(said.length, 1, "the end was said once, not with every carry");
    assert.match(said[0], /ended its turn 4 times in a row having written only its thinking/);
    assert.match(said[0], /so the run was left as it is/);
  } finally {
    db.setSingleActiveSession(false);
    await reset();
  }
});

test("an end with an answer in it is its own end, and leaves the carries fresh", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    await aPi.end("stop", { parts: ["thinking"], out: 26 });
    await flush();
    assert.equal(aPi.carries(PICK_UP), 1, "carried on once");
    assert.equal(sessions.cutOffCarries.get(a), 1, "the carry counts in this turn");

    // An end with words in it: the work concluded, and nothing is owed to the chat.
    await aPi.end("stop", { parts: ["text"], text: "the answer" });
    await flush();
    assert.equal(aPi.carries(PICK_UP), 1, "no second carry beside an answer");
    assert.equal(sessions.cutOffCarries.has(a), false, "the budget was spent with the turn");
    assert.equal(sessions.isActive(a), false, "the room went");
    assert.deepEqual(notices(a), [], "nothing was said about it");

    // A later turn ending on its thinking gets its own carries.
    await aPi.end("stop", { parts: ["thinking"], out: 26 });
    await flush();
    assert.equal(aPi.carries(PICK_UP), 2, "carried on again, from a fresh budget");
    assert.equal(sessions.cutOffCarries.get(a), 1, "counted from the start again");
    await aPi.end("stop", { parts: ["text"], text: "the answer" });
    await flush();
  } finally {
    await reset();
  }
});

// The shape the cut-off test refuses to carry is a different one and stays refused: a
// run stopped on `length` having written only thinking is the chat's context having no
// room left, and a carry-on of it is the same nothing written again. The new branch
// sits beside that test, not across it.
test("a run stopped on its output limit with only thinking is still not carried on", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    await aPi.end("length", { parts: ["thinking"], out: 1 });
    await flush();

    assert.equal(aPi.carries(PICK_UP), 0, "nothing carried on: the context, not the turn, is out of room");
    const said = notices(a);
    assert.equal(said.length, 1, "said once");
    assert.match(said[0], /in the middle of its thinking, without writing an answer/);
    assert.match(said[0], /context being full/);
    assert.equal(sessions.isActive(a), false, "the room is not held for a resume that will not come");
  } finally {
    await reset();
  }
});

// The end BlastRunHero's E2 Task lost its first attempt on: the chat compacted at a
// turn boundary, pi's own next turn did real work, and the turn after that ended on its
// thinking alone. What the watcher read there was a run ending on its own terms — the
// attempt written failed at 20:02:14, and a fresh session at 20:02:15 began the Task
// again from nothing. The work is still in hand, so the attempt stays open and the
// carry goes to the session that has its context.
test("a Task whose run ended with nothing said is carried on in its own session, not settled", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);
    assert.deepEqual([...started], [sessionId], "the Task reached the engine once");

    // The work, the compaction pi ran itself, and the turn that ended on nothing.
    at().turn();
    at().compact();
    at().turn();
    await at().end("stop", { parts: ["thinking"], out: 26 });
    await flush(400);

    assert.equal(db.getAttempt(attempt.id).status, "running", "a turn that answered nothing is not the Task's end");
    assert.deepEqual(resumeLines(sessionId).map((p) => p.resume), ["silent"], "the turn was handed back to the same session, and said as the portal carrying it on");
    assert.equal(db.getSession(sessionId).status, "running", "the same session is working again");
    assert.deepEqual([...new Set(started)], [sessionId], "no brand-new session started the Task from nothing");
    assert.equal(execution.hasLiveTaskRun(), true, "the queue's gate says work is in hand");

    // The carried-on turn answers, with the promise on its own line: only that end
    // settles the attempt, and it settles as the work done.
    await at().end("stop", { parts: ["text"], text: `All of it is in.\n\n\`\`\`\n${PROMISE}\n\`\`\`` });
    await settled(attempt.id);
    assert.equal(db.getAttempt(attempt.id).status, "completed", "the attempt settles at the carried-on run's own end");
    assert.equal(db.getTask(t.id).status, "completed", "and the Task is done, not started over");
  } finally {
    await reset();
  }
});

test("a Task whose chat keeps answering nothing is carried a bounded number of times, then settled", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);

    for (let n = 0; n <= 3; n++) {
      await at().end("stop", { parts: ["thinking"], out: 26 });
      await flush(400);
    }

    assert.deepEqual(resumeLines(sessionId).map((p) => p.resume).length, 3, "the carries are bounded");
    await settled(attempt.id);
    assert.equal(db.getAttempt(attempt.id).status, "failed", "a chat that answers nothing after its carries is an ended run, and never left hanging");
    assert.equal(db.getTask(t.id).status, "pending", "and the Task is left for the queue to answer, not stuck working");
    assert.ok(
      notices(sessionId).some((n) => n.includes("ended its turn 4 times in a row")),
      "the chat's last line says why it stopped",
    );
  } finally {
    await reset();
  }
});
