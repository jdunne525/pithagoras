import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const db = await import("../dist/db.js");
const tasks = await import("../dist/tasks.js");
const execution = await import("../dist/task-execution.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
const ladder = await import("../dist/compaction-ladder.js");
test.after(() => db.getDb().close());

// What the chat says when the portal asks it for room and the chat has none to give.
//
// The shape seen on a portal after the task-carry fixes (9 November, `Ba1JDWACWmrJ`
// and `B8MmTVqbhPEN`, sequences 236771-238044): a chat's own compaction at the
// turn boundary worked, pi's next turn reached its end on pi running away with it
// — the run ends on `aborted` and the last message it writes is an errored one,
// `This operation was aborted` — and beside that run the portal asked the chat for
// room, which pi answered `Nothing to compact (session too small)`. Three lines
// came out of that which are not the chat's: the model was called a failure for a
// request that was stopped (`Model error: This operation was aborted`), the refusal
// of room was called a failure of the chat's compaction (`Auto-compaction failed:`),
// and a line about picking the turn up came into the chat beside a run that had
// already reached its end — read as an order to work, which is a chat answering the
// same sentence about resuming every turn, never finishing, and a Task whose every
// attempt ends on that sentence.
//
// None of the three is the chat's. An aborted request is not a model's failure; a
// room the chat refused is not an attempt that failed and is none of the chat's
// count of its own attempts (the state is one the chat's own pair answers, see
// fact 4 of the ladder); and a room asked beside a run that had settled interrupts
// nothing, so nothing of the portal's picks a turn up after it. What a run ended on
// being run away with is a run pi interrupted, not the Task's end: the attempt stays
// open, and the queue's gate is not left to answer a Task that has work in hand.

const home = inProcessHome("pithagoras-task-compaction-room-refused-");
mkdirSync(path.join(home, "work"), { recursive: true });

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
   * Where the run ends. `stopReason` is how the model stopped — `stop` is its
   * own terms, `aborted` is pi ending the run on being run away with (a request
   * one of the portal's asks stopped), `error` is a model that refused. `error`
   * holds why, in the message.
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
  /** pi's own compaction at the turn boundary, and the next turn it started itself. */
  async compactAside() {
    this.emit("event", { type: "compaction_start", reason: "threshold" });
    this.emit("event", { type: "compaction_end", reason: "threshold", willRetry: false, result: { summary: "the chat's summary" } });
    this.emit("event", { type: "turn_start" });
  }
  /** The room the portal asked the chat for, which the chat refused: no cut to make. */
  async roomRefused() {
    this.emit("event", { type: "compaction_start", reason: "manual" });
    this.emit("event", { type: "compaction_end", reason: "manual", willRetry: false, errorMessage: NO_CUT });
  }
}

/** The words pi writes for a request it stopped mid-run, and for no cut to make. */
const ABORTED = "This operation was aborted";
const NO_CUT = "Compaction failed: Nothing to compact (session too small)";
/** The lines the portal sends for a compaction's turn — SessionManager's own words. */
const PICK_UP = "Compaction detected, resume where you left off if needed.";

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
const task = () => tasks.createTask({ title: `rr${++count}`, workspace: path.join(home, "work") });

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

test("a run pi ended on being run away with, beside a room the chat refused, is none of the chat's, the model's, or the Task's", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);
    assert.deepEqual([...started], [sessionId], "the Task reached the engine once");

    // The work happens, and the chat's own compaction at the turn boundary works:
    // pi started its next turn itself, so the turn is not left for a resume of
    // ours to pick up.
    await at().turn();
    await at().compactAside();
    await flush(200);

    // That next turn reaches its end on pi running away with it — the request was
    // stopped for an ask of the portal's — and beside that run the portal asks the
    // chat for room, which the chat answers with no cut to make.
    await at().end("aborted", ABORTED);
    await at().roomRefused();
    await flush(400);

    assert.ok(
      !notices(sessionId).some((n) => n.startsWith("Model error:")),
      "a request pi stopped is not called a model's failure",
    );
    assert.ok(
      !notices(sessionId).some((n) => n.startsWith("Auto-compaction failed:")),
      "a room the chat refused is not called a failure of the chat's compaction",
    );
    assert.ok(
      notices(sessionId).some((n) => n === ladder.COMPACT_ROOM_REFUSED),
      "the refusal of the room is said as what it is",
    );
    assert.ok(
      carries(sessionId).every((p) => p.resume === "compaction"),
      "any line about picking the turn up is one of the portal's carries into this same session",
    );
    assert.deepEqual([...new Set(started)], [sessionId], "the work is carried where it lives: no brand-new session started the Task again from nothing");
    assert.equal(db.getAttempt(attempt.id).status, "running", "a run pi interrupted is not the Task's end: the attempt stays open");
    assert.equal(db.getTask(t.id).status, "running", "and the Task is not settled back for another attempt beside a run pi cut short");
    // The portal's work beside the run's end (the room asked at the wall, the queue's
    // look at the room) is fire-and-forget: it is let go before the database closes.
    await flush(400);
  } finally {
    await reset();
  }
});

test("the same end in a message's words: the request stopped is not called a model's failure", async () => {
  try {
    const t = task();
    const { sessionId, attempt } = execution.startTask(t.id);
    await flush();
    const at = () => pis.get(sessionId);
    assert.deepEqual([...started], [sessionId], "the Task reached the engine once");

    // The other words for the same end (the shape on the machine before the fixes):
    // the run's last message is an errored one whose reason is a request that was
    // stopped — pi ending the run on being run away with an ask of the portal's.
    await at().turn();
    await at().compactAside();
    await flush(200);
    await at().end("error", ABORTED);
    await at().roomRefused();
    await flush(400);

    assert.ok(
      !notices(sessionId).some((n) => n.startsWith("Model error:")),
      "a request pi stopped is not called a model's failure, in the model's words or in the request's",
    );
    assert.ok(
      !notices(sessionId).some((n) => n.startsWith("Auto-compaction failed:")),
      "a room the chat refused is not called a failure of the chat's compaction",
    );
    assert.ok(
      carries(sessionId).every((p) => p.resume === "compaction"),
      "any line about picking the turn up is one of the portal's carries into this same session",
    );
    assert.deepEqual([...new Set(started)], [sessionId], "the work is carried where it lives: no brand-new session started the Task again from nothing");
    assert.equal(db.getAttempt(attempt.id).status, "running", "a run pi interrupted is not the Task's end: the attempt stays open");
    await flush(400);
  } finally {
    await reset();
  }
});
