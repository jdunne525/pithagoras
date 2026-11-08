// Push-notifications regression tests for the ntfy poller. The poller compares
// each session's status tick to tick and announces a chat when it goes from
// running to idle. The announcement is suppressed if the reply arrived faster
// than `min_response_seconds`, an age measured from the session's created_at.
//
// created_at is written by SQLite's datetime('now') as UTC with no zone marker,
// which JS's Date.parse reads as LOCAL time — off by the whole offset, and on a
// machine west of Greenwich even in the future, giving a negative age that would
// suppress every alert. These pin that a finished chat is announced regardless
// of the machine's timezone, and that the fast-reply gate still works.
//
// An alert must also carry words, never a file: ntfy reads a body of 4,096 bytes
// or more — or one holding a character outside plain ASCII — as an attachment, so
// the whole source a chat wrote used to arrive as "You received a file:
// attachment.js" with the message gone. The test that posts a game's source pins
// the body stays plain text, trimmed and under that edge.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-ntfy-"));
process.env.DATA_DIR = home;

// Reroute the ntfy.sh POST to a local sink so the test never leaves the box,
// capturing what would have been sent.
const received = [];
const sink = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    // The whole header set is kept as well: an alert must never ask ntfy for a
    // file, and the headers that would do that are visible here.
    received.push({
      topic: req.url,
      headers: req.headers,
      title: req.headers.title,
      priority: req.headers.priority,
      body,
    });
    res.writeHead(200);
    res.end();
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const sinkPort = sink.address().port;
https.request = function hijack(url, opts, cb) {
  const u = new URL(url);
  u.host = "127.0.0.1";
  u.port = String(sinkPort);
  u.protocol = "http:";
  return http.request(u.toString(), opts, cb);
};

const { getDb } = await import("../dist/db.js");
const ntfy = await import("../dist/ntfy.js");
const { saveNtfyConfig } = ntfy;

const db = getDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a completed conversation is announced, whatever the machine timezone", async () => {
  saveNtfyConfig({ enabled: true, topic: "finishtopic", minResponseSeconds: 0 });
  ntfy.startNtfyNotifications(150);

  // A chat that just started (age ~0) and has now gone quiet. Fresh enough that
  // the wrong timezone parse would suppress it, which is what this pins.
  db.prepare(
    "INSERT INTO sessions (id, title, status, workspace, created_at) VALUES ('finish-me','The Finish Chat','running','/tmp', datetime('now')) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
  ).run();

  await sleep(400); // let the poller observe it running
  db.prepare("UPDATE sessions SET status='idle', updated_at=datetime('now') WHERE id='finish-me'").run();

  await sleep(800); // let it notice the transition to idle
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /finishtopic/.test(r.topic));
  assert.ok(hit, "a finished chat should trigger a push notification");
  // The header is now the project's own name, not a fixed "Chat finished".
  assert.equal(hit.title, "The Finish Chat");
  // The title leads the body in bold, followed by a plain status word.
  assert.match(hit.body, /\*\*The Finish Chat\*\*/);
  assert.match(hit.body, /finished\.?$/);
});

test("the agent's final answer replaces finished, with how long it took", async () => {
  received.length = 0;
  saveNtfyConfig({ enabled: true, topic: "answertopic", minResponseSeconds: 0 });
  ntfy.startNtfyNotifications(150);

  // Started five minutes ago, now quiet, with a real assistant answer on file
  // alongside some thinking that must not leak into the alert.
  db.prepare(
    "INSERT INTO sessions (id, title, status, workspace, created_at) VALUES ('answer-me','The Answer Chat','running','/tmp', datetime('now','-5 minutes')) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
  ).run();
  db.prepare(
    "INSERT INTO events (session_id, type, payload, created_at) VALUES ('answer-me','message_end', ?, datetime('now'))",
  ).run(JSON.stringify({ message: { role: "assistant", stopReason: "done", content: [
    { type: "thinking", thinking: "this is my private reasoning" },
    { type: "text", text: "All done — the report is saved." },
  ] } }));

  await sleep(400);
  db.prepare("UPDATE sessions SET status='idle', updated_at=datetime('now') WHERE id='answer-me'").run();
  await sleep(800);
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /answertopic/.test(r.topic));
  assert.ok(hit, "a finished chat should trigger a push notification");
  assert.equal(hit.title, "The Answer Chat");
  assert.match(hit.body, /\*\*The Answer Chat\*\*/);
  assert.match(hit.body, /Took .*min/i);
  assert.match(hit.body, /the report is saved/);
  assert.doesNotMatch(hit.body, /private reasoning/, "thinking must be left out of the alert");
});

test("a long answer is sent as words, trimmed, never as a file", async () => {
  received.length = 0;
  saveNtfyConfig({ enabled: true, topic: "longanswer", minResponseSeconds: 0 });
  ntfy.startNtfyNotifications(150);

  // The whole file the chat wrote: well past ntfy's 4,096-byte message limit,
  // which is where the phone used to answer "You received a file: attachment.js"
  // with no message at all. The start of it is worth reading; the rest is in the
  // chat, so the alert keeps the start and says where it was cut.
  const source = "// game.js\n" + "const sprite = load('cat.png'); // drawn each frame\n".repeat(200);
  db.prepare(
    "INSERT INTO sessions (id, title, status, workspace, created_at) VALUES ('long-me','The Long Answer Chat','running','/tmp', datetime('now','-5 minutes')) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
  ).run();
  db.prepare(
    "INSERT INTO events (session_id, type, payload, created_at) VALUES ('long-me','message_end', ?, datetime('now'))",
  ).run(JSON.stringify({ message: { role: "assistant", stopReason: "done", content: [{ type: "text", text: source }] } }));

  await sleep(400);
  db.prepare("UPDATE sessions SET status='idle', updated_at=datetime('now') WHERE id='long-me'").run();
  await sleep(800);
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /longanswer/.test(r.topic));
  assert.ok(hit, "a finished chat should trigger a push notification");
  const bytes = Buffer.byteLength(hit.body, "utf8");
  assert.ok(bytes < 4096, "a body of 4,096 bytes or more arrives as a file, not as the message");
  assert.ok(hit.body.startsWith("**The Long Answer Chat**"), "the header still leads the alert");
  assert.match(hit.body, /game\.js/, "the start of the answer is the part that arrives");
  assert.match(hit.body, /\.\.\.$/, "the trimmed text says where it was cut");
  for (const name of ["x-filename", "filename", "file", "f", "x-attach", "attach", "a", "actions"]) {
    assert.equal(hit.headers[name], undefined, `no header may ask ntfy for a file: ${name}`);
  }
  assert.match(String(hit.headers["content-type"]), /^text\/plain/, "the body is posted as plain text");
});

test("a reply faster than the threshold is not announced", async () => {
  received.length = 0;
  saveNtfyConfig({ enabled: true, topic: "quicktopic", minResponseSeconds: 300 });
  ntfy.startNtfyNotifications(150);

  // Started just now; any quick answer must stay silent.
  db.prepare(
    "INSERT INTO sessions (id, title, status, workspace, created_at) VALUES ('quickie','The Quick Chat','running','/tmp', datetime('now')) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
  ).run();

  await sleep(400);
  db.prepare("UPDATE sessions SET status='idle', updated_at=datetime('now') WHERE id='quickie'").run();
  await sleep(800);
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /quicktopic/.test(r.topic));
  assert.equal(hit, undefined, "a reply faster than min_response_seconds must not announce");
});

test("an old unanswered question is announced, whatever the machine timezone", async () => {
  received.length = 0;
  saveNtfyConfig({ enabled: true, topic: "questiontopic", minResponseSeconds: 60 });
  ntfy.startNtfyNotifications(150);

  // Asked ten minutes ago, still unanswered.
  db.prepare(
    "INSERT INTO questions (id, session_id, person_key, person_name, channel_slug, channel_key, question, action_tool, action, asked_at) VALUES ('q-old','sess','', 'Ada', '', '', 'Ready?', NULL, NULL, datetime('now','-10 minutes'))",
  ).run();

  await sleep(900);
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /questiontopic/.test(r.topic));
  assert.ok(hit, "a long-waiting question should trigger a push notification");
  assert.equal(hit.title, "Answer needed");
  assert.match(hit.body, /Ada/);
});

test("a freshly asked question stays silent below the threshold", async () => {
  received.length = 0;
  saveNtfyConfig({ enabled: true, topic: "newquestiontopic", minResponseSeconds: 600 });
  ntfy.startNtfyNotifications(150);

  db.prepare(
    "INSERT INTO questions (id, session_id, person_key, person_name, channel_slug, channel_key, question, action_tool, action, asked_at) VALUES ('q-new','sess','', 'Ada', '', '', 'Ready?', NULL, NULL, datetime('now'))",
  ).run();

  await sleep(900);
  ntfy.stopNtfyNotifications();

  const hit = received.find((r) => /newquestiontopic/.test(r.topic));
  assert.equal(hit, undefined, "a question asked recently must not announce");
});

after(() => sink.close());
