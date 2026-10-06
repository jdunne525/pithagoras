import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-single-"));
process.env.DATA_DIR = home;
process.env.SESSION_DIR = path.join(home, "sessions");
process.env.WORKSPACE_ROOT = path.join(home, "ws");
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { createSession, updateSession, setSingleActiveSession, getDb } = await import("../dist/db.js");
const { sessions, PromptQueuedForSingleActive } = await import("../dist/session-manager.js");
test.after(() => {
  getDb().close();
  rmSync(home, { recursive: true, force: true });
});

// A fake pi that answers everything the run path touches, so prompt() can start
// without launching a process. Records which session it was asked to start.
const started = [];
function fakeClient() {
  return {
    running: false,
    getCommands: async () => [],
    getState: async () => ({ model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off" }),
    getAllTools: () => [],
    getActiveToolNames: () => [],
    setActiveToolsByName() {},
    clearQueue() {},
    abort: async () => {},
    prompt: async () => {},
  };
}
function stubEnsure() {
  const real = sessions.ensureClient.bind(sessions);
  sessions.ensureClient = async (id) => {
    started.push(id);
    return fakeClient();
  };
  return real;
}
function restoreEnsure(real) {
  sessions.ensureClient = real;
}

function makeSession(id, kind, status) {
  createSession({ id, title: id, workspace: home, executor: "host" });
  updateSession(id, { kind, status });
  sessions.live.set(id, { client: {}, executor: {} });
}

/** Let the fire-and-forget run path reach our stubbed ensureClient. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A running interactive chat holding the room under single-active. */
function holdRoom(id) {
  makeSession(id, "agent", "running");
  sessions.inRun.add(id);
}

test("a second chat waits behind an active one and starts when it stops", async () => {
  setSingleActiveSession(true);
  const real = stubEnsure();
  try {
    holdRoom("A1");
    makeSession("B1", "agent", "idle");

    await assert.rejects(sessions.prompt("B1", "hello B"), PromptQueuedForSingleActive, "held back while A runs");
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "the request is queued");
    assert.deepEqual(started, [], "nothing sent while another chat is active");

    // A fully settles: out of its run, idle again — the manager then hands the
    // room to the next waiting request.
    sessions.inRun.delete("A1");
    sessions.mark("A1", "idle");
    await sessions.processQueue();
    await flush();

    assert.deepEqual(started, ["B1"], "B starts once A has stopped");
    assert.equal(sessions.singleActiveQueue.length, 0, "queue drained by one");
  } finally {
    restoreEnsure(real);
    started.length = 0;
    sessions.singleActiveQueue = [];
    sessions.inRun.clear();
    sessions.compacting.clear();
    sessions.compactionInterruptedRun.clear();
  }
});

test("compaction keeps the room held until the compaction unwinds", async () => {
  setSingleActiveSession(true);
  const real = stubEnsure();
  try {
    holdRoom("C1");
    sessions.inRun.delete("C1"); // settle the run...
    sessions.compacting.set("C1", {}); // ...but compaction is still going
    makeSession("D1", "agent", "idle");

    await assert.rejects(sessions.prompt("D1", "hi"), PromptQueuedForSingleActive);
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 1, "still held during compaction");

    sessions.compacting.delete("C1"); // compaction finished for good
    await sessions.processQueue();
    await flush();
    assert.deepEqual(started, ["D1"], "released only after compaction ends, not mid-way");
  } finally {
    restoreEnsure(real);
    started.length = 0;
    sessions.singleActiveQueue = [];
    sessions.inRun.clear();
    sessions.compacting.clear();
    sessions.compactionInterruptedRun.clear();
  }
});

test("an autonomous run neither blocks a chat nor waits itself", async () => {
  setSingleActiveSession(true);
  const real = stubEnsure();
  try {
    // A Task in flight: active, but not an interactive chat.
    makeSession("T", "task", "running");
    sessions.inRun.add("T");
    makeSession("U", "agent", "idle");

    await sessions.prompt("U", "go"); // not blocked by an autonomous run
    await flush();
    assert.equal(sessions.singleActiveQueue.length, 0, "a chat is not held behind a Task");
    assert.deepEqual(started, ["U"], "the chat goes on its own way");
  } finally {
    restoreEnsure(real);
    started.length = 0;
    sessions.singleActiveQueue = [];
    sessions.inRun.clear();
    sessions.compacting.clear();
    sessions.compactionInterruptedRun.clear();
  }
});

test("the gate is off when the setting is not set", async () => {
  setSingleActiveSession(false);
  const real = stubEnsure();
  try {
    holdRoom("X1");
    makeSession("Y1", "agent", "idle");
    await sessions.prompt("Y1", "go ahead");
    await flush();
    assert.deepEqual(started, ["Y1"], "no queuing without the setting");
    assert.equal(sessions.singleActiveQueue.length, 0);
  } finally {
    restoreEnsure(real);
    started.length = 0;
    sessions.singleActiveQueue = [];
    sessions.inRun.clear();
    sessions.compacting.clear();
    sessions.compactionInterruptedRun.clear();
  }
});

test("a message for the active session itself still goes in, not queued", async () => {
  setSingleActiveSession(true);
  const real = stubEnsure();
  try {
    holdRoom("P1");
    // Follow-up to the very chat that is running: pi queues it into that run,
    // this portal never holds it back.
    await sessions.prompt("P1", "and also this");
    await flush();
    assert.deepEqual(started, ["P1"], "the active chat is answered directly");
    assert.equal(sessions.singleActiveQueue.length, 0, "never queued");
  } finally {
    restoreEnsure(real);
    started.length = 0;
    sessions.singleActiveQueue = [];
    sessions.inRun.clear();
    sessions.compacting.clear();
    sessions.compactionInterruptedRun.clear();
  }
});
