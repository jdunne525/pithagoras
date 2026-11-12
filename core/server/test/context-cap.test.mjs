import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The hold on one context file (src/pi/context-budget.ts).
 *
 * pi hands the whole of every AGENTS.md or CLAUDE.md it reads to the model on
 * every turn of a chat, and a project's knowledge base grows as the agent writes
 * what it learned into it, with nothing saying no: one reached 256,599
 * characters, and the chat opened onto it was a third of the way through a
 * 204,800-token window before anything had been asked of it. Compaction cannot
 * give that room back — the prompt is not part of what a compaction summarises —
 * so the portal holds each file to a cap and tells the chat what it did not get,
 * which is what it needs to go and read one section of it.
 */
const home = inProcessHome("pithagoras-context-cap-");
const agentDir = process.env.PI_CODING_AGENT_DIR;

/** Each request's system prompt, in the order they came. */
const sent = [];
const model = await fakeModel(async (request) => {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  sent.push(typeof system?.content === "string" ? system.content : (system?.content ?? []).map((c) => c.text).join(""));
  return "Sure.";
});
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(model.models()));

const {
  CONTEXT_CAP_DEFAULT,
  capContextFiles,
  cappedNotice,
  contextCapProblem,
  getContextCap,
  setContextCap,
  storedContextCap,
  tokensOf,
} = await import("../dist/pi/context-budget.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { contextBreakdownText, getBuiltinCommands, runBuiltin } = await import("../dist/pi/builtins.js");
const { createSession, getDb } = await import("../dist/db.js");

getDb();

const num = (n) => n.toLocaleString("en-US");
/** `count` sections of `filler` characters each, each headed by a name a cut can be seen to list. */
const sections = (count, filler) => Array.from({ length: count }, (_, i) => `## Section ${i + 1}\n${filler}\n`).join("\n");

let chats = 0;
const open = (cwd, sessionId) => {
  const dir = path.join(home, "chats", String(++chats));
  mkdirSync(dir, { recursive: true });
  return SdkPiClient.create({ cwd, sessionDir: dir, provider: "fake", modelId: "m", sessionId, role: "primary" });
};
/** The end of the run going now, or a failure after 10 s. */
const settled = (client) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("event", on);
      reject(new Error("the run did not settle within 10 s"));
    }, 10_000);
    const on = (e) => {
      if (e?.type === "agent_settled") {
        clearTimeout(timer);
        client.off("event", on);
        resolve();
      }
    };
    client.on("event", on);
  });

test("the portal's own number holds every chat until one is set, and 0 says read whole files", () => {
  setContextCap(null);
  assert.equal(getContextCap(), CONTEXT_CAP_DEFAULT);
  assert.equal(storedContextCap(), null, "nothing set is nothing stored");
  assert.equal(contextCapProblem(1_000), undefined, "at the floor");
  assert.equal(contextCapProblem(200_000), undefined, "at the ceiling");
  assert.ok(contextCapProblem(999), "under the floor is refused, not clamped");
  assert.ok(contextCapProblem(200_001));
  assert.ok(contextCapProblem(1_200.5), "not a whole number");

  setContextCap(30_000);
  assert.equal(getContextCap(), 30_000);
  assert.equal(storedContextCap(), 30_000);

  setContextCap(0);
  assert.equal(getContextCap(), 0, "0 is asked for outright: nothing is held");
  assert.equal(storedContextCap(), 0);

  setContextCap(99);
  assert.equal(getContextCap(), CONTEXT_CAP_DEFAULT, "a number the server would refuse reads as the default again");

  setContextCap(null);
  assert.equal(getContextCap(), CONTEXT_CAP_DEFAULT);
});

test("a file under the cap is handed on exactly as it was", () => {
  const file = { path: "a/AGENTS.md", content: "# Notes\n\nBuild with npm test.\n" };
  const held = capContextFiles([file], 1_000);
  assert.deepEqual(held.leftOut, []);
  assert.equal(held.files[0], file, "not copied, not rewritten");
});

test("the hold off touches nothing at all", () => {
  const big = { path: "a/AGENTS.md", content: sections(200, "x".repeat(400)) };
  const held = capContextFiles([big], 0);
  assert.equal(held.files[0], big);
  assert.deepEqual(held.leftOut, []);
});

test("a file over the cap is cut at a line, and says what is missing and where to find it", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `Note ${i + 1} of the project, long enough to fill the file over several times the cap.`).join("\n");
  const PAST = "the rest of the book, which the chat is not handed";
  const content = `# Project notes\n\nBuild with npm test.\n\n${lines}\n## The far half\n${PAST}\n## Levels\nSome more notes.\n`;
  const file = { path: "proj/AGENTS.md", content };
  const held = capContextFiles([file], 1_500);

  assert.equal(held.leftOut.length, 1);
  const left = held.leftOut[0];
  assert.equal(left.path, "proj/AGENTS.md");
  assert.equal(left.wholeTokens, tokensOf(content.length), "the whole file, as pi would weigh it");
  assert.equal(left.cap, 1_500);
  assert.ok(left.keptLines > 0 && left.keptLines < left.totalLines);
  assert.equal(left.totalLines, content.split("\n").length);
  // The map of the part it did not get, which is what a chat needs to read one of them.
  assert.deepEqual(left.sections, ["The far half", "Levels"]);
  assert.equal(left.moreSections, 0);

  const kept = held.files[0].content;
  const cut = kept.indexOf("[... ");
  const keptHead = kept.slice(0, cut).replace(/\n+$/, "");
  assert.ok(content.startsWith(keptHead), "the top of the file, as it was");
  assert.ok(content.startsWith(`${keptHead}\n`), "and the cut falls on a line, never mid-line");
  assert.ok(!kept.includes(PAST), "what is past it stays in the file");

  const note = kept.slice(cut);
  assert.match(note, /\[\.\.\. and [\d,]+ more characters of this file were not loaded/);
  assert.match(note, new RegExp(`it holds ${num(content.length)} characters`));
  assert.match(note, new RegExp(`starts at line ${num(left.keptLines + 1)} of ${num(left.totalLines)}`));
  assert.match(note, /held to 1,500 tokens/);
  assert.match(note, /"The far half", "Levels"/);
  assert.match(note, /Read what you need with the read tool/);
  assert.ok(kept.length < content.length, "the chat is handed less than the file, the note included");
});

test("a file that is one enormous line is still given the room, not cut at its top", () => {
  // One long table or minified block: the last line break before the budget is at
  // the header, and cutting there would hand the chat a few hundred characters of
  // a file it could have read 8,000 tokens of.
  const content = `# Project notes\n\nBuild with npm test.\n\n${"n".repeat(60_000)}\n## The far half\nEnd.\n`;
  const held = capContextFiles([{ path: "one-line/AGENTS.md", content }], 8_000);
  const left = held.leftOut[0];
  assert.ok(left.keptTokens > 7_000, `the room the cap allows is kept (${left.keptTokens} tokens), not lost`);
  assert.ok(held.files[0].content.includes("Build with npm test."), "and the top of it is there");
  assert.match(held.files[0].content, /"The far half"/);
});

test("when the rest of the file is many sections, the note names some and says how many more", () => {
  const content = `## Kept\n${"a".repeat(5_000)}\n${sections(20, "b".repeat(200))}`;
  const held = capContextFiles([{ path: "many/AGENTS.md", content }], 1_000);
  const left = held.leftOut[0];
  assert.equal(left.sections.length, 16, "a dozen-odd is a map, not the whole table of contents");
  assert.equal(left.moreSections, 4);
  assert.match(held.files[0].content, /, and 4 more\./);
});

test("the notice says the file, what it weighs, what the chat got, and where the number is set", () => {
  const held = capContextFiles([{ path: "x/AGENTS.md", content: sections(60, "q".repeat(1_000)) }], 3_000);
  const text = cappedNotice(held.leftOut);
  assert.match(text, /Context left out of this chat's opening prompt: x\/AGENTS\.md holds/);
  assert.match(text, /was read to [\d,]+, from line 1 to [\d,]+ of [\d,]+/);
  assert.match(text, /Its remaining sections are named in the prompt/);
  assert.match(text, /held to 3,000 tokens, which is yours to change in Settings → General/);
});

test("`/context` is offered as a command the portal answers itself", async () => {
  const commands = await getBuiltinCommands();
  const asked = commands.find((one) => one.name === "context");
  assert.ok(asked, "it is in the list the pages offer");
  assert.equal(asked.where, "server", "and answered here, not handed to pi to swallow");
  assert.ok(asked.description.length > 0, "with what it says");
  assert.ok((await runBuiltin("context", "", { getContextBreakdown: async () => undefined })).includes("container"), "a pi that cannot be asked inside itself says so");
});

test("a chat that has answered nothing still says what its prompt carries", async () => {
  // pi names the parts of a prompt when it writes the system message, which it does
  // at the first request. A chat opened and not yet asked is the case the question
  // was asked about — it opens full before anything is said — so it must not read
  // as an empty breakdown.
  const dir = path.join(process.env.WORKSPACE_ROOT, "quiet-chat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), `# Project notes\n\nBuild with npm test.\n\n${"n".repeat(60_000)}\n## The far half\nEnd.\n`);
  createSession({ id: "quiet", title: "quiet", workspace: dir, executor: "host" });

  setContextCap(2_000);
  const client = await open(dir, "quiet");
  try {
    const breakdown = await client.getContextBreakdown?.();
    assert.ok(breakdown);
    assert.ok(breakdown.promptTokens > 0, "its prompt is counted even before it is sent");
    assert.equal(breakdown.prompt.length, 1, "and it is one part, until pi names them at its first answer");
    assert.match(breakdown.prompt[0].name, /first answer/);
    assert.equal(breakdown.files.length, 1);
    assert.ok(breakdown.files[0].leftOut, "with the file inside it named, and held");
    assert.match(contextBreakdownText(breakdown), /AGENTS\.md — [\d,]+ tokens, of [\d,]+: read to the cap of 2,000/);
  } finally {
    client.dispose();
    setContextCap(null);
  }
});

test("a chat over the cap opens on the top of its project's file and the map of the rest, not the whole of it", async () => {
  const dir = path.join(process.env.WORKSPACE_ROOT, "capped-chat");
  mkdirSync(dir, { recursive: true });
  const PAST = "PAST_THE_CAP_not_for_the_model";
  const content = `# Project notes\n\nBuild with npm test.\n\n${"n".repeat(60_000)}\n## The far half\n${PAST}\n## Levels\nMore notes.\n`;
  writeFileSync(path.join(dir, "AGENTS.md"), content);
  createSession({ id: "capped", title: "capped", workspace: dir, executor: "host" });

  setContextCap(8_000);
  const client = await open(dir, "capped");
  try {
    const done = settled(client);
    await client.prompt("Hello");
    await done;

    const prompt = sent.at(-1);
    assert.match(prompt, /<project_instructions path=/, "the project's file is in the prompt at all");
    assert.ok(prompt.includes("Build with npm test."), "the top of it, which is what a chat needs");
    assert.ok(!prompt.includes(PAST), "what is past the cap stays in the file");
    assert.match(prompt, /more characters of this file were not loaded/);
    assert.match(prompt, /"The far half"/, "and the chat is told that section exists, so it can go and read it");
    assert.ok(prompt.length < content.length, `the prompt (${prompt.length}) is less than the file alone (${content.length})`);

    const caps = client.contextCaps?.() ?? [];
    assert.equal(caps.length, 1);
    assert.equal(caps[0].path, path.join(dir, "AGENTS.md"));
    assert.equal(caps[0].cap, 8_000);
    assert.ok(caps[0].keptTokens < caps[0].wholeTokens);
    assert.ok(caps[0].keptTokens > 7_000, "the chat is given the room the cap allows, even from one enormous line");

    const breakdown = await client.getContextBreakdown?.();
    assert.ok(breakdown, "the parts can be read back");
    assert.equal(breakdown.cap, 8_000);
    assert.ok(breakdown.contextWindow > 0);
    const project = breakdown.prompt.find((one) => one.name === "project_context");
    assert.ok(project, "the prompt's project context is one of its sections");
    assert.ok(project.tokens > 0 && project.tokens < breakdown.promptTokens, "a part of the prompt, not the whole of it");
    const file = breakdown.files.find((one) => one.path === path.join(dir, "AGENTS.md"));
    assert.ok(file, "and the file inside it is named");
    assert.equal(file.leftOut?.cap, 8_000);
    assert.ok(file.leftOut.wholeTokens > file.tokens, "with what was left out of it said");
    assert.ok(breakdown.toolTokens > 0, "the tools declared to the model are counted too");
    assert.ok(breakdown.historyTokens > 0, "and so is what was asked");

    const said = await runBuiltin("context", "", client);
    assert.match(said, /It opens with [\d,]+ tokens/);
    assert.match(said, /read to the cap of 8,000/);
    assert.match(said, /Tools declared to the model/);
    assert.match(said, /AGENTS\.md — [\d,]+ tokens, of [\d,]+: read to the cap of 8,000/);
    assert.match(said, /Each context file is held to 8,000 tokens/);
    assert.match(contextBreakdownText({ ...breakdown, cap: 0 }), /Context files are read whole/);
  } finally {
    client.dispose();
    setContextCap(null);
  }
});
