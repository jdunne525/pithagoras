import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The pointer to a Task's brief is said at system level, which is what carries a
 * Task's instructions over a compaction.
 *
 * A line in the conversation is exactly what a compaction summarizes away, and
 * that is how Tasks were lost: the run kept working, reached its end without the
 * marker it had been told to print, was written failed, and the queue started the
 * Task again from nothing. pi carries its prompt as prompt state — a compaction
 * replays it beside the summary rather than folding it in — so the one line naming
 * the file is there for the run whatever the conversation has been cut down to,
 * and the file it names holds the Completion Requirement itself.
 */

const home = inProcessHome("pithagoras-task-brief-prompt-");
const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { briefReminder } = await import("../dist/task-brief.js");

const systemOf = (request) =>
  request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

let n = 0;
/** The first request a new conversation sends, with whatever lines it was given. */
async function ask(more = {}) {
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")),
    sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake",
    modelId: "m",
    sessionId: `brief-${n++}`,
    ...more,
  });
  const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
  try {
    await client.prompt("Hello");
    await settled;
    return systemOf(model.requests[0]);
  } finally {
    client.dispose();
  }
}

test("a chat with no brief says nothing about one", async () => {
  const system = await ask();
  assert.ok(!system.includes("task-brief.md"), "an ordinary chat is not told about a file it has none of");
  assert.ok(!system.includes("Task brief:"), "and no task line at all");
});

test("a Task's brief is named in the prompt, with the marker it must finish on", async () => {
  const where = path.join(home, "sessions", "abc123", "task-brief.md");
  const system = await ask({ briefLines: () => [briefReminder(where)] });
  assert.ok(system.includes("Task brief:"), "the line is in the system prompt");
  assert.ok(system.includes(where), "named by the path this chat reads it at");
  assert.ok(system.includes("<PROMISE>THIS TASK IS DONE</PROMISE>"), "and with the marker said with it");
});

test("what the brief line holds is asked again when the chat's prompt is loaded again", async () => {
  // The line is asked for as the prompt is loaded, not fixed for the life of the
  // chat — the same shape the chat's mode's instructions have: a brief that
  // appeared since, or went with the session's folder, reaches the chat at the
  // next load of its prompt rather than only in the chats that start later.
  const where = path.join(home, "sessions", "moved", "task-brief.md");
  let said = [];
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")),
    sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake",
    modelId: "m",
    sessionId: "brief-live",
    briefLines: () => said,
  });
  const settle = () => new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
  try {
    let done = settle();
    await client.prompt("First");
    await done;
    assert.ok(!systemOf(model.requests[0]).includes(where), "nothing to point at yet");
    said = [briefReminder(where)];
    await client.reload();
    model.requests.length = 0;
    done = settle();
    await client.prompt("Second");
    await done;
    const system = systemOf(model.requests.at(-1));
    assert.ok(system.includes(where), "the brief named once it is there");
    assert.ok(system.includes("<PROMISE>THIS TASK IS DONE</PROMISE>"), "with the marker it carries");
  } finally {
    client.dispose();
  }
});
