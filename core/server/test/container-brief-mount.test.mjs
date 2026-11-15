import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What a container's pi is mounted, for the brief of an autonomous Task's run
 * (task-brief.ts): the file its instructions are in, which its prompt only points
 * at, so the mount is the whole of whether the run can read them.
 *
 * A fake `docker` records the arguments of `docker run` and answers nothing. Where
 * the portal has no POSIX user identity — Windows — there is no container to run
 * and no argument to read, so the look is skipped rather than failed.
 */
const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pithagoras-brief-mount-"));
writeFileSync(
  path.join(dir, "docker"),
  `#!/bin/sh
case "$1" in
  run)
    echo "$*" >> "$FAKE_DOCKER_ARGS"
    echo '{"type":"extension_ui_request","id":"s1","method":"setStatus","statusKey":"k","statusText":"hi"}'
    cat ;;
esac
`,
);
chmodSync(path.join(dir, "docker"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { ContainerExecutor } = await import("../dist/executors/index.js");

const briefRoot = path.join(dir, "briefs");
const posix = typeof process.getuid === "function";

/** The `docker run` arguments of one launch, and the folders it left behind. */
async function argsOf(sessionId) {
  process.env.FAKE_DOCKER_ARGS = path.join(dir, `${sessionId}.args`);
  const executor = new ContainerExecutor("img", path.join(dir, "sessions"), { memoryMb: 64, cpus: 1, pidsLimit: 16 }, briefRoot);
  const client = await executor.launch({ sessionId, workspacePath: dir, dialogs: false });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return readFileSync(process.env.FAKE_DOCKER_ARGS, "utf8").trim();
  } finally {
    client.dispose();
  }
}

test("a chat with no brief of its own is mounted as it always was, and leaves no folder", { skip: posix ? false : "the container executor needs a POSIX user identity" }, async () => {
  const args = await argsOf("plain-chat");
  assert.ok(!args.includes("/briefs"), `nothing of a brief in: ${args}`);
  assert.equal(existsSync(path.join(briefRoot, "plain-chat")), false, "an ordinary chat makes no brief folder");
  assert.ok(args.includes(`${dir}:/workspace`), "the workspace mount is as it was");
  assert.ok(args.includes(path.join(dir, "sessions", "plain-chat") + ":/sessions"), "and the session's folder is too");
});

test("the run of a Task has its brief mounted read-only, beside its workspace", { skip: posix ? false : "the container executor needs a POSIX user identity" }, async () => {
  const sessionId = "task-run";
  const briefDir = path.join(briefRoot, sessionId);
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(path.join(briefDir, "task-brief.md"), "# Task brief\n");

  const args = await argsOf(sessionId);
  assert.ok(args.includes(`${briefDir}:/briefs:ro`), `the brief's folder, read-only, in: ${args}`);
  // Read-only on purpose: the run reads its instructions and cannot rewrite them.
  const where = args.indexOf("/briefs:ro");
  assert.ok(args.slice(0, where).includes("-v"), "it is a mount");
  assert.ok(args.indexOf(":/workspace") < where, "named beside the workspace");
});
