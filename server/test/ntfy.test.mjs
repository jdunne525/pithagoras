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
    received.push({ topic: req.url, title: req.headers.title, priority: req.headers.priority, body });
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
  assert.equal(hit.title, "Chat finished");
  assert.match(hit.body, /The Finish Chat/);
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
