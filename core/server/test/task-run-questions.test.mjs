import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Who is given the agent's ask_question tool.
 *
 * A chat on the portal's pages answers the person, so it has the tool. An autonomous Task's run does not:
 * it works from what its prompt gives it and decides the rest for itself, with nobody at its page to answer —
 * which is how Tasks ran before the tool existed. A child chat follows the page its dialogs go to, so a child
 * made under a Task's run has none, and one made under an ordinary chat keeps it.
 *
 * Real pi against a fake model, with the portal's own session manager, reading what each pi was started with.
 */
inProcessHome("pithagoras-task-run-questions-");
const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { createSession, getSettings, rememberTools, setSettings } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");
const { createTask } = await import("../dist/tasks.js");
const { startTask, stopTask } = await import("../dist/task-execution.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });
// The page's list of an idle chat is built from what the portal has seen registered (session-manager.ts getTools).
rememberTools([{ name: "ask_question", source: "ask-question", package: null, inline: true }]);

/** What each pi was started with. */
const launches = [];
const create = SdkPiClient.create.bind(SdkPiClient);
SdkPiClient.create = async (opts) => {
  launches.push(opts);
  return create(opts);
};
// The Task's prompt is what is being looked at here, not sent to a model.
const prompts = [];
sessions.prompt = async (sessionId, message) => void (prompts.push({ sessionId, message }), true);

const chat = (id, extra = {}) => createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task", ...extra });

/** The chat's pi, started now, and what it was given. */
async function startedWith(id) {
  const before = launches.length;
  const client = await sessions.ensureClient(id);
  client.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(launches.length, before + 1, `one pi was started for ${id}`);
  return launches.at(-1);
}

const questions = async (id) => (await startedWith(id)).questions;

test("a chat the person talks to is given the tool", async () => {
  chat("plain");
  assert.equal(await questions("plain"), true);
});

test("a Task's run is started without it, and its prompt says the run decides on its own", async () => {
  const task = createTask({ workspace: process.env.WORKSPACE_ROOT, title: "Fix the login bug", description: "Users cannot sign in." });
  const { sessionId } = startTask(task.id);
  assert.deepEqual(prompts.map((p) => p.sessionId), [sessionId], "the run was handed its prompt");
  assert.match(prompts[0].message, /## Working Alone[\s\S]*no question is put to the person/);
  assert.equal((await startedWith(sessionId)).questions, false);
  stopTask(task.id);
});

test("a chat made under a Task's run has none either; one made under an ordinary chat keeps it", async () => {
  const task = createTask({ workspace: process.env.WORKSPACE_ROOT, title: "Tidy", description: "Tidy the folder." });
  const { sessionId } = startTask(task.id);
  const underTask = sessions.createChild({ parent: sessionId, title: "Part of the run" }, "pkg.test");
  assert.equal(await questions(underTask.id), false);

  chat("parented");
  const underChat = sessions.createChild({ parent: "parented", title: "Part of the chat" }, "pkg.test");
  assert.equal(await questions(underChat.id), true);
  stopTask(task.id);
});

test("the idle chat's tool list offers it to a chat and not to a Task's run", async () => {
  const task = createTask({ workspace: process.env.WORKSPACE_ROOT, title: "Quiet", description: "Nothing to ask." });
  const { sessionId } = startTask(task.id);
  chat("shown");
  const of = async (id) => (await sessions.getTools(id)).tools.filter((t) => t.name === "ask_question").length;
  assert.equal(await of("shown"), 1);
  assert.equal(await of(sessionId), 0);
  stopTask(task.id);
});

test("a Task's pi does not register the tool at all; an ordinary chat's does", async () => {
  chat("registered");
  const plain = await sessions.ensureClient("registered");
  const task = createTask({ workspace: process.env.WORKSPACE_ROOT, title: "Silent", description: "No questions." });
  const { sessionId } = startTask(task.id);
  const run = await sessions.ensureClient(sessionId);
  const names = async (client) => (await client.getTools()).map((tool) => tool.name);
  assert.ok((await names(plain)).includes("ask_question"), "the chat a person answers in has it");
  assert.ok(!(await names(run)).includes("ask_question"), "the Task's run has no tool to call");
  plain.dispose();
  run.dispose();
  stopTask(task.id);
});

test("a Task's own run keeps the dialogs a person at its page answers", async () => {
  const task = createTask({ workspace: process.env.WORKSPACE_ROOT, title: "Guarded", description: "One dialog." });
  const { sessionId } = startTask(task.id);
  assert.equal((await startedWith(sessionId)).dialogs, true);
  stopTask(task.id);
});
