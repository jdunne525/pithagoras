import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// What a Task does when a run ends for a reason that is not the work ending.
//
// BlastRunHero's `Brutes should shoot a green projectile` Task (c67318ec, 15
// November) took five sessions and 3 hours 18 minutes for a change the fifth one
// described as already sitting in the working tree. Four attempts were written
// failed and each was answered by a brand-new session reading the repo from
// nothing:
//
//   - three ended on the local engine dying — `the engine stopped unexpectedly
//     (exit code None); the next request restarts it` — the last two in the middle
//     of a `write`, at 153,812 and 110,098 tokens of context;
//   - one ended with the model writing `<tool_call><function=build>` as
//     text, which pi reads as prose: nothing ran, the turn stopped, the run ended.
//
// Neither is an end of the work, and both have an answer of their own in the same
// chat: ask it again, in the same context, after the wait the failure asks for.
// Machine-wide the errored ends are the commonest loss: of 417 attempts, 93 of the
// failed ones end on an errored answer (73 provider 429s, 7 engine deaths, the
// rest dropped connections and timeouts).
//
// What must NOT be carried on is an end that answers the same way when asked
// again — a stopped request, a quota spent, a key nobody has, a context with no
// room — and a chat that keeps failing is bounded, so nothing holds the room
// forever.

const home = inProcessHome("pithagoras-ended-short-");
mkdirSync(path.join(home, "work"), { recursive: true });

const { createSession, eventsSince, getSession, getDb, setSingleActiveSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
const { carryWaitForModelError, toolCallWrittenAsText } = await import("../dist/model-errors.js");
test.after(() => getDb().close());

/** The engine's own sentence, and the wait its "next request restarts it" asks for. */
const ENGINE_GONE = "the engine stopped unexpectedly (exit code None); the next request restarts it";
const ENGINE_WAIT = 10_000;

const TOOL_CALL_AS_TEXT =
  "<tool_call>\n<function=build>\n<parameter=parameter>\n\n</parameter>\n</function>\n</tool_call>";
const CARRY_ERROR =
  "Carry on where you left off. Your last answer failed with a model or engine error, not an end of the work; the work is still in hand. Pick up where you stopped.";
const CARRY_TEXT =
  "Carry on where you left off. Your last answer wrote the tool call it wanted as text, which asks for nothing — put the call in a call, and carry on where you stopped.";

/** Stands in for pi: an event bus the test drives, and a record of what it was asked. */
class FakePi extends EventEmitter {
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionFile = path.join(opts.sessionDir, "conversation.jsonl");
  }
  running = true;
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
    return { model: { id: "m", name: "M", provider: "p", contextWindow: 131072, maxTokens: 16384, input: ["text"] }, thinkingLevel: "off" };
  }
  async abort() {}
  async shutdown() {}
  dispose() {}
  async prompt(message) {
    this.prompts.push(message);
    this.idle = false;
    this.emit("event", { type: "agent_start" });
    return { outcome: "started" };
  }
  /**
   * The last message of a run, and how the model stopped. `parts` is its content
   * as the chat sees it; `error` is what an errored answer said.
   */
  last({ stopReason = "stop", parts = ["text"], out = 40, error, text = "mid-sentence" } = {}) {
    this.emit("event", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason,
        usage: { input: 100, output: out, totalTokens: 100 + out },
        ...(error !== undefined ? { errorMessage: error } : {}),
        content: parts.map((kind) =>
          kind === "text" ? { type: "text", text } : kind === "toolCall" ? { type: "toolCall", id: "c1", name: "bash", arguments: {} } : { type: "thinking", thinking: "mid-thought" },
        ),
      },
    });
  }
  /** The message, then the run's end: what `agent_settled` is decided on. */
  end(opts = {}) {
    this.last(opts);
    this.emit("event", { type: "agent_end", willRetry: false });
    this.idle = true;
    this.emit("event", { type: "agent_settled" });
  }
  carries(of) {
    return this.prompts.filter((p) => p === of).length;
  }
}

const started = [];
const pis = new Map();
SdkPiClient.create = async (opts) => {
  started.push(opts.sessionId);
  const pi = new FakePi(opts);
  pis.set(opts.sessionId, pi);
  return pi;
};

let count = 0;
function chat() {
  const id = `es${++count}`;
  createSession({ id, title: id, workspace: path.join(home, "work"), executor: "host", kind: "task" });
  return id;
}

/** Lets the fire-and-forget run path reach pi and the queue reach its next item. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

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

test("an answer the engine was not there to write is asked for again in the same chat", async () => {
  try {
    setSingleActiveSession(true);
    const a = chat();
    const b = chat();

    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);
    await assert.rejects(sessions.prompt(b, "work on B"), PromptQueuedForSingleActive);
    await flush();
    assert.deepEqual(started, [a], "B waits behind A");

    // The engine dies mid-work: pi ends the turn with its sentence, the run with
    // nothing resumed. The gap is held — the room kept, the attempt left open —
    // for the wait that lets the next request start the engine back.
    aPi.end({ stopReason: "error", error: ENGINE_GONE, parts: ["thinking"], out: 12 });
    assert.equal(sessions.inRun.has(a), false, "the run settled");
    assert.equal(getSession(a).status, "idle", "the chat reads idle in the gap");
    assert.equal(sessions.cutOffResumePending.has(a), true, "the gap is marked");
    assert.equal(sessions.isActive(a), true, "the idle chat still holds the room");
    assert.equal(sessions.isCompacting(a), true, "and is not read as ended");
    await flush();
    assert.deepEqual(started, [a], "B did not take the room in the gap");
    assert.equal(aPi.carries(CARRY_ERROR), 0, "the ask waits for the engine, not for a turn of the loop");
    assert.deepEqual(notices(a), [], "the gap says nothing: the work is going on");

    // The ask lands in the same session, where the work's context is.
    await new Promise((resolve) => setTimeout(resolve, ENGINE_WAIT + 400));
    assert.equal(aPi.carries(CARRY_ERROR), 1, "the same chat was asked again");
    assert.equal(sessions.inRun.has(a), true, "the carried-on run holds the room");
    assert.equal(sessions.cutOffResumePending.has(a), false, "the gap is over");
    assert.deepEqual(started, [a], "still only A at the engine — no fresh session began the work");
    assert.deepEqual(resumeLines(a).map((p) => p.resume), ["model-error"], "the line says whose it is");
  } finally {
    reset();
  }
});

test("an answer that failed for what nobody but a person changes is left ended, and says so", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // A quota spent answers the same way when asked again, and pi does not retry
    // these either: carrying it on is three more asks and no answer.
    aPi.end({ stopReason: "error", error: 'Error: 429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}', parts: ["thinking"], out: 1 });
    await flush();

    assert.equal(aPi.prompts.length, 1, "nothing was asked again");
    assert.equal(sessions.cutOffResumePending.has(a), false, "no gap is held");
    assert.equal(sessions.isActive(a), false, "the room is not held for an ask that will not come");

    const said = notices(a);
    assert.equal(said.length, 0, "the failure itself is said by the chat's own error line, not twice");
  } finally {
    reset();
  }
});

test("a tool call written as text is carried on at once, and bounded after three", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // Attempt 4 of the Brutes Task: 53 tokens of markup after a `grep` that timed
    // out at 60 seconds, `stopReason: stop`, and no run left to continue it.
    aPi.end({ stopReason: "stop", parts: ["thinking", "text"], text: TOOL_CALL_AS_TEXT, out: 53 });
    await flush();
    assert.equal(aPi.carries(CARRY_TEXT), 1, "asked to put the call in a call, in the same chat");
    assert.deepEqual(resumeLines(a).map((p) => p.resume), ["tool-text"], "the line says whose it is");

    // Four of them in a row: three carries, the fourth said. A model that keeps
    // writing markup cannot hold the room open for ever.
    for (let ends = 2; ends <= 4; ends++) {
      aPi.end({ stopReason: "stop", parts: ["text"], text: TOOL_CALL_AS_TEXT, out: 53 });
      await flush();
      assert.equal(aPi.carries(CARRY_TEXT), Math.min(ends, 3), `carried on ${Math.min(ends, 3)} time(s)`);
    }
    assert.equal(sessions.isActive(a), false, "out of carry-on budget, the room goes");

    const said = notices(a);
    assert.equal(said.length, 1, "the end was said once");
    assert.match(said[0], /wrote the tool call it wanted as text 4 times in a row/);
    assert.match(said[0], /The work is unfinished where it stopped/);
  } finally {
    reset();
  }
});

test("an answer that wrote a call as well as its markup is an answer, not a markup end", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // The turn did ask for work, alongside the markup: that is a turn going on,
    // ending as any turn does, and carrying it on would start a run nobody wants.
    aPi.end({ stopReason: "stop", parts: ["toolCall", "text"], text: TOOL_CALL_AS_TEXT, out: 53 });
    await flush();
    assert.equal(aPi.prompts.length, 1, "nothing carried on");
    assert.deepEqual(notices(a), [], "nothing said");
  } finally {
    reset();
  }
});

test("an errored answer with nothing said is left ended", async () => {
  try {
    const a = chat();
    await sessions.prompt(a, "work on A");
    await flush();
    const aPi = pis.get(a);

    // With no sentence to read there is nothing to tell a gone engine from a dead
    // ask, and a carry-on of a failure the portal cannot name is a loop.
    aPi.end({ stopReason: "error", error: "", parts: ["thinking"], out: 0 });
    await flush();
    assert.equal(aPi.prompts.length, 1, "nothing asked again");
    assert.equal(sessions.isActive(a), false, "the room went");
  } finally {
    reset();
  }
});

test("what answers the same way when asked again is not asked again", () => {
  // The ends a chat has to be told about rather than asked again: pi refuses to
  // retry these, and a carry-on is the same answer one more time.
  for (const text of [
    // The shape this machine failed on 73 times: the free tier of
    // gemini-3.1-pro has no quota to wait for — every metric it names is
    // `limit: 0`. Ask again, same answer; the person changes the model or the key.
    '{"error":{"message":"{\n  \\"error\\": {\n    \\"code\\": 429,\n    \\"message\\": \\"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\\n\\",\n    \\"status\\": \\"RESOURCE_EXHAUSTED\\"\n  }\n}"}',
    "Error: 429 {\"error\":{\"code\":\"insufficient_quota\",\"message\":\"You exceeded your current quota, please check your plan and billing details.\"}}",
    "Error: 429 {\"error\":{\"type\":\"usage_limit_reached\",\"code\":\"insufficient_quota\",\"message\":\"Quota exceeded for metric\"}}",
    "Error 403: Failed to get API key. No API key is configured for provider.",
    "No models available for provider OpenAI Codex.",
    "400: {\"type\":\"invalid_request_error\",\"message\":\"request exceeds the context window: prompt (131303 tokens) leaves no room to answer in the context (131072)\"}",
    "404 \"Not Found\"",
    // The person's Stop, and the portal's own stopped compaction: not a model's
    // failure to carry on from.
    "This operation was aborted",
  ]) {
    assert.equal(carryWaitForModelError(text), null, `not carried on: ${text.slice(0, 60)}`);
  }
  assert.equal(carryWaitForModelError(""), null, "an error with no sentence is not carried on");
  assert.equal(carryWaitForModelError(undefined), null, "no error at all is not carried on");
});

test("a limit that resets, and an engine that is not there, are asked again after their wait", () => {
  // A rate limit's own window is seconds, and pi's three retries land inside it.
  assert.equal(carryWaitForModelError("Error: 429 Too many requests: Rate limit of 10 requests per minute exceeded. Please retry your request later."), 30_000, "a per-minute limit");
  assert.equal(carryWaitForModelError("503 Service Unavailable: the server is currently busy"), 30_000, "a busy server");
  // The engine is restarted by the next request, which is what the ask is.
  assert.equal(carryWaitForModelError(ENGINE_GONE), 10_000, "the engine gone, from its own sentence");
  assert.equal(carryWaitForModelError("Connection error."), 10_000, "a connection dropped");
  assert.equal(carryWaitForModelError("Request timed out."), 10_000, "a request timed out");
  assert.equal(carryWaitForModelError("502 Error: connect ECONNREFUSED 127.0.0.1:8888"), 10_000, "the local server refused");
  assert.equal(carryWaitForModelError("Something the portal has never read"), 10_000, "an unknown failure is asked once more, briefly");
  // A number in a sentence is not a status code: read as one, a gone connection
  // that happened to count 404 of something would be left as an end.
  assert.equal(carryWaitForModelError("Socket hang up after 404 tokens of the answer"), 10_000, "a count, not a 404");
  assert.equal(carryWaitForModelError("Stream ended after 400 tokens"), 10_000, "a count, not a 400");
});

test("markup asking for a tool call is read as markup, and an answer as an answer", () => {
  assert.equal(toolCallWrittenAsText(TOOL_CALL_AS_TEXT), true, "the shape from attempt 4");
  assert.equal(toolCallWrittenAsText("<invoke name=\"bash\">\n</invoke>"), true, "a call written in another model's markup");
  assert.equal(toolCallWrittenAsText("```\n<tool_call>\n</tool_call>\n```"), true, "markup inside a fence");
  // Prose about a call is an answer, and stays one.
  assert.equal(toolCallWrittenAsText("I would call `<tool_call>` here, then read the file."), false, "an answer talking about a call");
  assert.equal(toolCallWrittenAsText("The change is in projectile.dart."), false, "an ordinary answer");
  assert.equal(toolCallWrittenAsText(""), false, "nothing");
});
