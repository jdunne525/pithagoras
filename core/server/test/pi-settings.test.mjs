import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * pi's settings.json holds the packages, the default model and the switches of
 * the install, and pi reads it with a plain JSON.parse. A file the portal
 * cannot read is not one it may start over from: the portal's own key would
 * then be all that is left in it.
 */
const home = inProcessHome("pithagoras-pi-settings-");
const agent = path.join(home, "agent");
const file = path.join(agent, "settings.json");
const { updatePiSettings, writePiSettingsText, inTurnWithSettings, readPiSettings, readCompactionSettings, piAgentDir } = await import("../dist/pi-settings.js");
const db = await import("../dist/db.js");

/** What a hand edit leaves: a comma too many. It is not what pi reads, and not a file to write over. */
const BROKEN = '{\n  "packages": ["npm:pi-example"],\n  "defaultProvider": "local",\n}\n';
const GOOD = JSON.stringify({ packages: ["npm:pi-example"], defaultProvider: "local" }, null, 2) + "\n";
const bak = `${file}.bak`;
const reset = (text) => {
  rmSync(bak, { force: true });
  if (text === undefined) rmSync(file, { force: true });
  else writeFileSync(file, text);
};

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a file that does not parse is not changed, and says why", async () => {
  reset(BROKEN);
  await assert.rejects(updatePiSettings((all) => { all.compaction = { keepRecentTokens: 5000 }; }), /settings\.json could not be read .*so nothing was changed/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
  assert.equal(existsSync(bak), false);
});

test("what is JSON but not an object is not changed either", async () => {
  for (const text of ["[]", '"text"', "null", "42"]) {
    reset(text);
    await assert.rejects(updatePiSettings((all) => { all.x = 1; }), /does not hold what pi expects/, text);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("a refused change does not wedge the next one, which works once the file is put right", async () => {
  reset(BROKEN);
  await assert.rejects(updatePiSettings(() => {}));
  writeFileSync(file, GOOD);
  const all = await updatePiSettings((s) => { s.defaultModel = "m"; });
  assert.deepEqual(all, { packages: ["npm:pi-example"], defaultProvider: "local", defaultModel: "m" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), all);
});

test("no file yet, or an empty one, is where a change starts from nothing", async () => {
  reset(undefined);
  assert.deepEqual(await updatePiSettings((s) => { s.a = 1; }), { a: 1 });
  assert.equal(existsSync(bak), false, "there was nothing to keep");
  reset("  \n");
  assert.deepEqual(await updatePiSettings((s) => { s.b = 2; }), { b: 2 });
});

test("a change keeps the rest, and the file as it was is kept beside it", async () => {
  reset(GOOD);
  await updatePiSettings((s) => { s.compaction = { keepRecentTokens: 5000 }; });
  assert.equal(readFileSync(bak, "utf8"), GOOD);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: ["npm:pi-example"], defaultProvider: "local", compaction: { keepRecentTokens: 5000 } });
});

test("a save that changes nothing leaves the copy of the file before it alone", async () => {
  reset(GOOD);
  await updatePiSettings((s) => { s.n = 1; });
  const original = readFileSync(bak, "utf8");
  await updatePiSettings(() => {});
  await updatePiSettings((s) => { s.n = 1; });
  assert.equal(readFileSync(bak, "utf8"), original);
});

test("the raw editor writes what it is given, over a file that does not parse, and keeps that one", async () => {
  reset(BROKEN);
  const text = '{\n    "defaultProvider": "other"\n}\n';
  await writePiSettingsText(text);
  assert.equal(readFileSync(file, "utf8"), text, "as typed, not tidied");
  assert.equal(readFileSync(bak, "utf8"), BROKEN);
});

test("work kept alongside the file runs in turn with the writes, and does not need the file to parse", async () => {
  reset(BROKEN);
  const order = [];
  const refused = updatePiSettings(() => order.push("write"), () => order.push("written")).catch(() => order.push("refused"));
  await inTurnWithSettings(() => order.push("alongside"));
  await refused;
  assert.deepEqual([...order].sort(), ["alongside", "refused"], "the write was refused before it changed anything");
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

test("an uninstalled package is forgotten even when settings.json cannot be read", async () => {
  reset(BROKEN);
  db.setExtensionStash({ "npm:pi-gone": { source: "npm:pi-gone", skills: [] }, "npm:pi-kept": { source: "npm:pi-kept" } });
  await db.packageRemoved("npm:pi-gone");
  assert.deepEqual(Object.keys(db.extensionStash()), ["npm:pi-kept"]);
  assert.equal(readFileSync(file, "utf8"), BROKEN, "pi has taken it out of the file; the portal leaves the file as it is");
});

test("the extension settings form does not start over from a file that does not parse", async () => {
  reset(BROKEN);
  const res = await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "v" });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /settings\.json could not be read/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

test("the extension settings form writes one key, clears it when emptied, and keeps the rest", async () => {
  reset(GOOD);
  const set = await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "v" });
  assert.equal(set.status, 200);
  assert.deepEqual(readPiSettings(), { packages: ["npm:pi-example"], defaultProvider: "local", exampleKey: "v" });
  assert.equal(readFileSync(bak, "utf8"), GOOD);
  await send("/api/extensions/settings", "PUT", { key: "exampleKey", value: "" });
  assert.deepEqual(readPiSettings(), { packages: ["npm:pi-example"], defaultProvider: "local" });
});

test("the compaction slider does not start over from a file that does not parse", async () => {
  reset(BROKEN);
  const res = await send("/api/settings", "PUT", { keepRecentTokens: 8000 });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /settings\.json could not be read/);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
});

// Compaction is two numbers, and pi has two shapes for each of them: the plain one every
// chat inherits, and one model's own (`compaction.modelOverrides["provider/model"]`), which
// is the only compaction number pi scopes to a single model. A chat whose summary cannot be
// written in one answer is given room through its model — the model's answer is what writes
// it — so the form has to write one number at a time, into the shape it was asked for,
// and refuse a value pi would choke on when it reads the file back.
test("the two compaction numbers are written as the plain setting, and only the one asked for", async () => {
  reset(GOOD);
  const both = await send("/api/settings", "PUT", { keepRecentTokens: 40000, reserveTokens: 24000 });
  assert.equal(both.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).compaction, { keepRecentTokens: 40000, reserveTokens: 24000 });
  const body = await both.json();
  assert.deepEqual(body.effective, { keepRecentTokens: 40000, reserveTokens: 24000 }, "what a chat on any model compacts at");

  // One number on its own: the slider released first must not write the other number as a
  // side effect — pi reads a written value as the model's own, overwriting what was there.
  const one = await send("/api/settings", "PUT", { reserveTokens: 30000 });
  assert.equal(one.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).compaction, { keepRecentTokens: 40000, reserveTokens: 30000 }, "keep-recent was left as it stood");

  // A value outside the range pi is given for it is refused, named by the field, before
  // anything is written: pi throws on a token setting it cannot read, and that takes the
  // whole settings file away from every chat.
  for (const bad of [0, 999, 500_001, "nonsense"]) {
    const res = await send("/api/settings", "PUT", { reserveTokens: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match((await res.json()).error, /Keep free must be between/);
  }
  for (const bad of [0, 999, 500_001]) {
    const res = await send("/api/settings", "PUT", { keepRecentTokens: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match((await res.json()).error, /Keep recent must be between/);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).compaction, { keepRecentTokens: 40000, reserveTokens: 30000 }, "the refused saves wrote nothing");
});

test("one model's own compaction room is written beside the plain numbers, and names the model it is for", async () => {
  reset(JSON.stringify({ packages: ["npm:pi-example"], compaction: { keepRecentTokens: 20000, reserveTokens: 16384 } }, null, 2) + "\n");
  const res = await send("/api/settings", "PUT", { keepRecentTokens: 60000, forModel: "strata/qwen3.8" });
  assert.equal(res.status, 200);
  const written = JSON.parse(readFileSync(file, "utf8")).compaction;
  assert.deepEqual(written.modelOverrides, { "strata/qwen3.8": { keepRecentTokens: 60000 } });
  assert.deepEqual(written, { keepRecentTokens: 20000, reserveTokens: 16384, modelOverrides: { "strata/qwen3.8": { keepRecentTokens: 60000 } } }, "the plain numbers, which every other model keeps, were left alone");
  const body = await res.json();
  assert.deepEqual(body.effective, { keepRecentTokens: 60000, reserveTokens: 16384 }, "the model's own keep-recent, the plain keep-free");
  assert.match(body.note, /Keep recent for strata\/qwen3\.8/);
  assert.match(body.note, /this model's own number/);

  // A second number for the same model merges into its entry; the model's other number is
  // left as it has it, as pi reads it.
  await send("/api/settings", "PUT", { reserveTokens: 24000, forModel: "strata/qwen3.8" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).compaction.modelOverrides, {
    "strata/qwen3.8": { keepRecentTokens: 60000, reserveTokens: 24000 },
  });

  // A model named the way pi does not name one is a number stored where nothing reads it.
  // A model ID carrying a slash is a key pi reads ("a/b/c": provider a, model b/c), so the
  // shape asked for is one provider, one slash, and a model that is not empty.
  for (const bad of ["strata", "", "/x", "a//b", "a/b\nc"]) {
    const r = await send("/api/settings", "PUT", { reserveTokens: 20000, forModel: bad });
    assert.equal(r.status, 400, bad);
    assert.match((await r.json()).error, /forModel names a model as pi names it/);
  }
  // A model ID carrying a slash is keyed as pi keys it, slashes inside the ID included.
  const sl = await send("/api/settings", "PUT", { keepRecentTokens: 30000, forModel: "a/b/c" });
  assert.equal(sl.status, 200);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).compaction.modelOverrides["a/b/c"].keepRecentTokens, 30000);

  // A model with no number asks for nothing: it would be read as a change, write nothing,
  // and be reported as applied.
  const none = await send("/api/settings", "PUT", { forModel: "strata/qwen3.8" });
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /forModel is only sent with the number it is for/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).compaction.modelOverrides, {
    "strata/qwen3.8": { keepRecentTokens: 60000, reserveTokens: 24000 },
    "a/b/c": { keepRecentTokens: 30000 },
  }, "nothing of the refused saves landed");

  // A model with no number of its own answers the plain numbers, as pi resolves them.
  const plain = await send("/api/settings", "PUT", { reserveTokens: 18000 });
  assert.deepEqual((await plain.json()).effective, { keepRecentTokens: 20000, reserveTokens: 18000 });
});

test("a compaction value pi could not read is not carried into what the portal says about it", () => {
  // The portal reads pi's file, and pi throws on a token setting that is not a positive
  // whole number — so what the portal reads is what pi can use, and a field mid-edit in pi's
  // file is left out rather than passed on as a size.
  writeFileSync(file, JSON.stringify({
    compaction: { keepRecentTokens: 0, reserveTokens: "16k", modelOverrides: { "a/b": { keepRecentTokens: 1.5, reserveTokens: 24000 }, "c/d": "nope", "e/f": { reserveTokens: -4 } } },
  }));
  const c = readCompactionSettings();
  assert.equal(c.keepRecentTokens, 20000, "pi's default for a value that is no number");
  assert.equal(c.reserveTokens, 16384);
  assert.deepEqual(c.modelOverrides, { "a/b": { reserveTokens: 24000 } }, "the model's valid number, and no entry shaped otherwise");
});

test("the raw editor puts a file that does not parse right, refuses what pi could not use, and keeps the old one", async () => {
  reset(BROKEN);
  for (const content of ["[1]", "null", '"text"']) {
    const res = await send("/api/pi-settings", "PUT", { content });
    assert.equal(res.status, 400, content);
    assert.match((await res.json()).error, /must be a JSON object/);
  }
  assert.equal((await send("/api/pi-settings", "PUT", { content: "{" })).status, 400);
  assert.equal(readFileSync(file, "utf8"), BROKEN, "nothing was written");

  const content = '{\n  "defaultProvider": "other"\n}\n';
  const ok = await send("/api/pi-settings", "PUT", { content });
  assert.equal(ok.status, 200);
  assert.equal(readFileSync(file, "utf8"), content);
  assert.equal(readFileSync(bak, "utf8"), BROKEN);
});

// One chat's switch is a write to this file, because pi has one auto-compaction
// switch for every chat. Left alone, one chat's own off would be every chat's off —
// the chats started after it included — and the room given to some other chat,
// which writes this same switch back on, would run compaction in the chat whose
// person turned it off. So the chat's move is recorded in the portal, the file is
// given its switch back, and the chat is put back off on its own pi.
test("a chat's own switch off is recorded, and the file keeps the switch for every chat nobody switched off", async () => {
  reset(JSON.stringify({ packages: ["npm:pi-example"], compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 } }, null, 2) + "\n");
  const chat = await (await send("/api/sessions", "POST", {})).json();

  const off = await send(`/api/sessions/${chat.id}/config`, "POST", { autoCompaction: false });
  assert.equal(off.status, 200);
  const said = await off.json();
  assert.equal(said.state.autoCompactionEnabled, false, "this chat's pi is off");
  assert.deepEqual(db.chatsWithCompactionOffByChoice(), [chat.id], "the chat's own off is on the books");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).compaction.enabled, true, "the file keeps the switch: a chat nobody switched off is not left without compaction");

  // Their own way back: the switch on leaves nothing recorded, and nothing to apply.
  const on = await send(`/api/sessions/${chat.id}/config`, "POST", { autoCompaction: true });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).state.autoCompactionEnabled, true, "the chat is on again");
  assert.deepEqual(db.chatsWithCompactionOffByChoice(), [], "and their move is off the books");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).compaction.enabled, true, "and the file says the same");
});

// The door to pi's file, and the way it went shut: pi builds its own directory from the
// home the OS reports, and the portal read it out of HOME in its own environment. On a
// Windows machine the two differ — the portal's HOME is a container's /data/home, pi's
// home is the user's profile — and every symptom of that is the one reported about a
// chat: compaction numbers written where no pi reads them, a slider reading back the
// default it never changed, and a compaction switch reported as pi's default while pi,
// reading its own file, ran with it off for every chat started after one chat was
// stopped. The same door is every one of the reads and writes above.
test("pi's settings are found by the home the OS reports, not by HOME in the portal's environment", () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR; // the tests run under the override; this asks about the fallback
  process.env.HOME = process.platform === "win32" ? "C:/not-the-user-home" : "/not-the-user-home";
  try {
    assert.equal(piAgentDir(), path.join(os.homedir(), ".pi", "agent"), "the directory pi itself builds");
    assert.notEqual(piAgentDir(), path.join(process.env.HOME, ".pi", "agent"), "and not the HOME the shell put in the portal's way");
    // An install that says where pi's home is is answered, trimmed: it wins over both.
    process.env.PI_CODING_AGENT_DIR = `  ${agent}  `;
    assert.equal(piAgentDir(), agent, "an install told where pi's home is, by its own variable");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
  }
});
