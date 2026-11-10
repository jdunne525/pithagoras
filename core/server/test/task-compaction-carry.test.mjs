import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a Task does when a compaction, and not the work, ends its run.
//
// Two shapes of that end were read on a machine over a night of Tasks. The one
// seen most (`xvi8qfPulGYB`, 8 November, at 21:21): the chat's own auto-compaction
// caught the run mid-turn and cut the turn short, pi started its next turn, and
// that turn was refused before it wrote anything — its answer came back as an
// errored message, "This operation was aborted". Nine different Tasks lost an
// attempt this way, over their own attempt numbers 1 to 6: the session read idle,
// the watcher settled the attempt as failed seconds after such a compaction, and
// the queue launched a brand-new session that started the Task again from nothing
// while its work was still in hand. The other shape is a run ending beside a
// compaction that answered it had nothing at all to take out of the chat —
// `Nothing to compact (session too small)` — which the ladder now reports honestly
// at no cost to the chat's switch, and which says nothing about the Task either.
//
// Neither end is the Task's. A compaction says the chat cannot be cut further, not
// that the work finished, so the handler hands the run back to the same session —
// where its context, and with it the part of the Task already done, still lives —
// with the same line the SessionManager uses for a compaction's turn, a bounded
// number of times, counted the way the model's own cut-off carries are counted.
// A run that ends on its own terms still settles as it always did, and a Task
// whose chat cannot be cut after the carries it was given settles like any ended
// run: the attempt is never left hanging, and never read as one that worked.
//
// A carry the room will not take (the single-active setting) is a third thing:
// the line waits in the queue, and the attempt and the queue's own gate wait
// with it — see the last test.

const home = inProcessHome("pithagoras-task-compaction-carry-");
mkdirSync(path.join(home, "work"), { recursive: true });

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const execution = await import("../dist/task-execution.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
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
   * anything else is the run reaching its own end.
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
  /** pi's own auto-compaction, and the next turn it started that was refused. */
  async cutShort() {
    this.emit("event", { type: "compaction_start", reason: "threshold" });
    this.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "the chat's summary" } });
    this.emit("event", { type: "turn_start" });
    await this.end("error", ABORTED);
  }
  /** The same run ending beside a compaction that found no cut to make. */
  async noCut() {
    this.emit("event", { type: "compaction_start", reason: "manual" });
    this.emit("event", { type: "compaction_end", reason: "manual", willRetry: false, errorMessage: NO_CUT });
    // pi started its own next turn, which is what lets the SessionManager's
    // marker of the turn go: the run then reaches its end with nothing holding
    // it, which is the state the watcher was reading this as a failure in.
    this.emit("event", { type: "turn_start" });
    await this.end("error", ABORTED);
  }
  /** A compaction aside, with the work going on past it. */
  async compactAside() {
    this.emit("event", { type: "compaction_start", reason: "threshold" });
    this.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "the chat's summary" } });
  }
  /**
   * A compaction that caught the turn and left it unfinished: pi stopped the run
   * for it, so the SessionManager holds the gap until its own resume lands.
   * `why` is pi's own sentence for the attempt, which the chat hears as its.
   */
  async compactFailed(why) {
    this.emit("event", { type: "compaction_start", reason: "threshold" });
    this.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, errorMessage: why });
    await this.end("error", ABORTED);
  }
  /** A run of its own that is left going: the room stays held. */
  async start(message) {
    await this.prompt(message);
  }
  /** The room the portal asked the chat for, which the chat refused: no cut. */
  async refusedRoom() {
    this.emit("event", { type: "compaction_start", reason: "manual" });
    this.emit(
      "event",
      { type: "compaction_end", reason: "manual", willRetry: false, errorMessage: NO_CUT },
    );
  }
}

/** The words pi writes for a request it stopped mid-run, and for no cut to make. */
const ABORTED = "This operation was aborted";
const NO_CUT = "Compaction failed: Nothing to compact (session too small)";
/** A summary longer than one of the model's answers: pi's own first sentence. */
const OUT_OF_ROOM = "Auto-compaction failed: Summarization failed: generation hit the token cap.";
/** The line the portal sends for a compaction's turn — SessionManager's own words. */
const PICK_UP = "Compaction detected, resume where you left off if needed.";
/** Carries the handler is allowed before the attempt is concluded as an end. */
const COMPACT_CARRY_BUDGET = 3;

/** Every pi started, in order, and the fake behind each session. */
const started = [];
const pis = new Map();
SdkPiClient.create = async (opts) => {
  started.push(opts.sessionId);
  const pi = new FakePi(opts);
  pis.set(opts.sessionId, pi);
  return pi;
};

/** Lets the fire-and-forget run path reach pi and the watcher see what came. */
const flush = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for an attempt to be written as settled. The completion check reads the
 * transcript with its own bounded waits before it decides, so a settled attempt
 * comes some time after the end that decided it; the limit is past that.
 */
async function settled(attemptId, limitMs = 12_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const row = db.getAttempt(attemptId);
    if (row && row.status !== "running") return row;
    if (Date.now() >= deadline) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The portal's own lines that carry an unfinished turn on, in order. */
const carries = (id) =>
  db.eventsSince(id, 0)
    .filter((r) => r.type === "portal_prompt")
    .map((r) => JSON.parse(r.payload))
    .filter((p) => p.resume);

/** What the chat was told, in order: the compaction's failures are said there. */
const notices = (id) =>
  db.eventsSince(id, 0)
    .filter((r) => r.type === "portal_notice")
    .map((r) => String(JSON.parse(r.payload).text ?? ""));

/** A Task in a folder of its own: what the queue runs, and the watcher watches. */
let count = 0;
const task = () => tasks.createTask({ title: `tc${++count}`, workspace: path.join(home, "work") });

/** A session of its own, for the room to be held beside a Task's run. */
function chat() {
  const id = `tchat${++count}`;
  db.createSession({ id, title: id, workspace: path.join(home, "work"), executor: "host", kind: "task" });
  return id;
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

test("a run a compaction cut short is carried on in its own session, not settled", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    // The session's engine as it stands now: a carried-on turn is handed to the
    // same session again, which is what keeps its work, so the bus is taken
    // fresh each time rather than held on to.
    const at = () => pis.get(sessionId);
    assert.deepEqual([...started], [sessionId], "the Task reached the engine once");

    // The work happens, and the chat's own compaction catches the turn.
    await at().turn();
    await at().cutShort();
    await flush(400);

    assert.equal(db.getAttempt(attempt.id).status, "running", "a compaction's cut is not the Task's end");
    assert.deepEqual(carries(sessionId).map((p) => p.resume), ["compaction"], "the turn was handed back to the same session, and said as the portal carrying it on");
    assert.equal(db.getSession(sessionId).status, "running", "the same session is working again: no brand-new one started the Task from nothing");
    assert.deepEqual([...new Set(started)], [sessionId], "every engine visit was this same session");

    // The carried-on turn reaches its own end: only that settles the attempt.
    await at().end("stop");
    await settled(attempt.id);
    assert.equal(db.getAttempt(attempt.id).status, "failed", "the attempt settles at the carried-on run's own end, without the completion promise");
    assert.equal(db.getTask(t.id).status, "pending", "the Task goes back for its next attempt, not left working");
  } finally {
    await reset();
  }
});

test("a run that ends on its own terms still settles, after a compaction aside it", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);

    // The chat is compacted aside, and the run goes on and reaches its own end.
    await at().turn();
    await at().compactAside();
    await at().turn();
    await at().end("stop");
    await settled(attempt.id);

    assert.equal(db.getAttempt(attempt.id).status, "failed", "an end on its own terms settles, and without the completion promise it is not read as done");
    assert.equal(db.getTask(t.id).status, "pending", "the Task goes back for its next attempt, not left working");
    assert.deepEqual(carries(sessionId), [], "nothing was carried on beside an end that was the run's own");
  } finally {
    await reset();
  }
});

test("a chat that cannot be cut is carried a bounded number of times, then settled", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);

    // The shape that kept recurring: the run ends beside a compaction that found
    // no cut to make, again and again, because the part of the chat no
    // compaction reads is what is left over the point it asks at.
    for (let n = 0; n <= COMPACT_CARRY_BUDGET; n++) {
      await at().noCut();
      await flush(400);
    }

    assert.deepEqual(carries(sessionId).map((p) => p.resume).length, COMPACT_CARRY_BUDGET, "the carries are bounded");
    await settled(attempt.id);
    assert.equal(db.getAttempt(attempt.id).status, "failed", "a chat that cannot be cut after its carries is an ended run, and never left hanging");
    assert.equal(db.getTask(t.id).status, "pending", "and the Task is left for the queue to answer, not stuck working");
  } finally {
    await reset();
  }
});

test("a compaction that failed is still tried again, and the run keeps its attempt", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);

    // A compaction of the turn that failed for want of room in the summary. The
    // chat's own attempts continue after one failure — pi asks again at the next
    // turn boundary — and it is only the second failure in a row that stops them.
    await at().turn();
    await at().compactFailed(OUT_OF_ROOM);
    await flush(400);

    assert.ok(
      notices(sessionId).some((n) => n.startsWith("Auto-compaction failed:")),
      "the failed compaction is said in the chat",
    );
    assert.equal(db.getAttempt(attempt.id).status, "running", "and the attempt is not settled beside it");
    assert.deepEqual(carries(sessionId).map((p) => p.resume), ["compaction"], "the turn is carried on in the same session");
    assert.deepEqual([...new Set(started)], [sessionId], "the work keeps its session");
  } finally {
    await reset();
  }
});

test("a carry the room will not take leaves the attempt, and the queue's gate, waiting", async () => {
  try {
    // The Task's run is going, and a chat started beside it while the setting
    // was off — both hold their rooms. The setting is switched on, which is what
    // makes the next request wait its turn.
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);
    const b = chat();
    await sessions.prompt(b, "work beside the Task");
    await flush();
    assert.equal(sessions.isActive(b), true, "the chat holds a room of its own");
    db.setSingleActiveSession(true);

    // The Task's run reaches its end beside a compaction that found no cut to
    // make, and the room is taken: the carry cannot go now.
    await at().noCut();
    await flush(400);

    assert.deepEqual(
      [...sessions.singleActiveQueue].filter((w) => w.sessionId === sessionId).map((w) => w.message),
      [PICK_UP],
      "the carry waits its turn in the queue: nothing was lost",
    );
    assert.equal(db.getAttempt(attempt.id).status, "running", "the attempt is not settled while its carry has not gone");
    assert.equal(execution.hasLiveTaskRun(), true, "the gate every queue loop reads says work is in hand: no next Task is started");
    assert.deepEqual([...new Set(started)], [sessionId, b], "no brand-new session started the Task again from nothing");
  } finally {
    db.setSingleActiveSession(false);
    await reset();
  }
});

test("a carry the room refused waits with the queue through several looks at the room, and none of those looks is one of the run's carries", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);
    assert.deepEqual([...started], [sessionId], "the Task reached the engine once");

    // A chat started beside the run while the setting was off, and the setting
    // switched on: its room is held, so a carry of this run cannot go now.
    const b = chat();
    await sessions.prompt(b, "work beside the Task");
    await flush();
    db.setSingleActiveSession(true);

    // The shape read on the machine over a night of Tasks (`sQSaW8RT78AD` and
    // the six chats before it, 10 November): the chat's own compaction at the
    // turn boundary worked, pi's next turn reached its end on the request being
    // stopped (`This operation was aborted`), and beside that end the portal
    // asked the chat for room, which the chat refused (`Nothing to compact
    // (session too small)`). Nothing about the work said the Task was over.
    await at().turn();
    // The chat's auto-compaction at the turn boundary, pi's own next turn, and
    // that turn ending on the request being stopped — `cutShort` is the shape of
    // the machine's tail, where the run kept working past the compaction.
    await at().cutShort();
    // Beside that end the portal asked the chat for room, which it refused.
    await at().refusedRoom();

    // Past three of the watcher's looks at the room — its own interval is two
    // seconds — with the other chat still holding its: each look found the carry
    // still waiting, and on the machine each one spent one of the carries the
    // run was given, so the fourth look settled the attempt as failed over work
    // still in hand, seconds after the compaction. The count belongs to the
    // carries that reached the chat, not to the looks the room refused.
    await flush(9000);

    assert.deepEqual(
      [...sessions.singleActiveQueue]
        .filter((w) => w.sessionId === sessionId)
        .map((w) => w.message),
      [PICK_UP],
      "one line for this turn waits in the queue: a later look does not stack a second copy of it",
    );
    assert.equal(
      db.getAttempt(attempt.id).status,
      "running",
      "a carry the room refused is none of the run's carries: the attempt stays open, and the queue's gate waits with it",
    );
    assert.equal(execution.hasLiveTaskRun(), true, "and the queue's gate waits with it");

    // The other chat reaches its own end: the room passes, the waiting line is
    // released, and the work is carried on where its context still lives.
    await pis.get(b).end("stop");
    await flush(600);
    assert.deepEqual(
      [...sessions.singleActiveQueue].filter((w) => w.sessionId === sessionId),
      [],
      "the line that was waiting went: it is not left in the queue",
    );
    assert.deepEqual(carries(sessionId).map((p) => p.resume), ["compaction"], "the turn was handed back to the same session once, not a second time for every look at the room");
    assert.equal(db.getSession(sessionId).status, "running", "the same session is working again: no brand-new one started the Task from nothing");
    assert.equal(db.getAttempt(attempt.id).status, "running", "and the attempt is still open");
  } finally {
    db.setSingleActiveSession(false);
    await reset();
  }
});
