import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./server-harness.mjs";

// The brief of an autonomous Task's run (task-brief.ts): where it is written,
// how it is read, and what the prompt keeps when the file holds the rest.

const root = scratch("pithagoras-brief-");
process.env.TASK_BRIEF_DIR = root;
const { briefDirOf, briefExists, briefFileOf, briefLines, briefReminder, briefRoot, briefSeenBy, removeBrief, writeBrief } = await import("../dist/task-brief.js");
const { buildTaskBrief, buildTaskPrompt } = await import("../dist/task-prompt.js");

const task = {
  id: "t1",
  title: "Add rate limiting",
  description: "Limit requests per user.",
  workspace: scratch("pithagoras-brief-project-"),
  status: "pending",
  max_attempts: 5,
};

/** A project's workflow file, of the length one of those really is. */
const workflow = "## Workflow\n\n" + Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the thing numbered ${i + 1}.`).join("\n");

test("a brief of one task, in a folder nothing else keeps", () => {
  assert.equal(briefRoot(), path.resolve(root));
  assert.equal(briefFileOf("abc"), path.join(root, "abc", "task-brief.md"));
  assert.equal(briefDirOf("abc"), path.join(root, "abc"));
});

test("the portal's own path for the agent working on the host, and the mounted one inside a container", () => {
  assert.equal(briefSeenBy("abc", "host"), path.resolve(path.join(root, "abc", "task-brief.md")));
  // A container's pi sees only what is mounted for it, under the name it is mounted at;
  // the portal's path names nothing it can open.
  assert.equal(briefSeenBy("abc", "container"), "/briefs/task-brief.md");
});

test("written atomically, and making its own folder first", () => {
  const file = briefFileOf("write-me");
  assert.equal(writeBrief(file, "First"), true);
  assert.equal(readFileSync(file, "utf8"), "First");
  assert.equal(writeBrief(file, "Second"), true, "an attempt of the same task rewrites it");
  assert.equal(readFileSync(file, "utf8"), "Second");
  // pi names a session file by `sessionId` alone; `findSessionFiles` only takes `.jsonl`.
  assert.ok(!file.endsWith(".jsonl"), "a brief is never mistaken for a session file");
  // What the agent's own user has to be able to do: open the file in a folder it can enter.
  assert.ok(statSync(briefDirOf("write-me")).mode & 0o044, "others may read the folder");
  assert.ok(statSync(file).mode & 0o044, "others may read the brief");
});

test("a brief that cannot be written says so, rather than throwing", () => {
  // A file where the folder should be: mkdirSync fails, and the run is told there is no brief.
  const blocked = path.join(root, "blocked", "task-brief.md");
  writeFileSync(path.join(root, "blocked"), "not a folder");
  assert.equal(writeBrief(blocked, "text"), false);
});

test("taken away with the attempt it was for", () => {
  const file = briefFileOf("ending");
  writeBrief(file, "text");
  assert.equal(briefExists("ending"), true);
  removeBrief("ending");
  assert.equal(briefExists("ending"), false);
  assert.equal(removeBrief("ending"), undefined, "removing what is already gone is nothing");
});

test("the brief holds the standing instructions, and names where it is read from", () => {
  const text = buildTaskBrief(task, {
    maxAttempts: 5,
    projectInstructions: "Run `npm test` before you commit anything.",
    attemptNumber: 2,
    briefPath: "/briefs/task-brief.md",
  });
  assert.match(text, /# Task brief — Add rate limiting/);
  assert.match(text, /`\/briefs\/task-brief\.md`/);
  assert.match(text, /compaction/i);
  assert.match(text, /## Specific Task/);
  assert.match(text, /Limit requests per user\./);
  assert.match(text, /## Working Alone/);
  assert.match(text, /no question is put to the person/);
  assert.match(text, /## Project Workflow/);
  assert.match(text, /Run `npm test` before you commit anything\./);
  assert.match(text, /## This Is Attempt 2/);
  assert.match(text, /An earlier attempt/);
  assert.match(text, /## Review & Commit/);
  assert.match(text, /## Completion Requirement/);
  assert.match(text, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
});

test("the first attempt's brief says nothing about an earlier one", () => {
  const text = buildTaskBrief(task, { maxAttempts: 5, attemptNumber: 1 });
  assert.doesNotMatch(text, /An earlier attempt/);
  assert.doesNotMatch(text, /## Project Workflow/, "a project with no workflow file adds no section");
});

test("with a brief, the prompt is the task, the pointer, and the marker", () => {
  const text = buildTaskPrompt(task, {
    maxAttempts: 5,
    projectInstructions: workflow,
    attemptNumber: 1,
    briefPath: "/briefs/task-brief.md",
  });
  // The task is what the attempt is about: it stays in the conversation, and so does
  // the line the judgment looks for — neither can be left to a file nobody opens.
  assert.match(text, /Add rate limiting/);
  assert.match(text, /Limit requests per user\./);
  assert.match(text, /`\/briefs\/task-brief\.md`/);
  assert.match(text, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
  assert.match(text, /no question is put to the person/, "working alone is still said, in one line");
  // What the file holds instead, at length, for every turn of the attempt.
  assert.doesNotMatch(text, /## Project Workflow/);
  assert.doesNotMatch(text, /Step 12: do the thing numbered 12\./);
  assert.doesNotMatch(text, /## Working Alone/);
  assert.doesNotMatch(text, /## Review & Commit/);
});

test("what the file holds is off the conversation, and stops deciding its size", () => {
  const short = buildTaskPrompt(task, { maxAttempts: 5, projectInstructions: "Run `npm test` before you commit.", attemptNumber: 1, briefPath: "/briefs/task-brief.md" });
  const long = workflow + "\n" + Array.from({ length: 120 }, (_, i) => `Rule ${i + 1}: the thing numbered ${i + 1}.`).join("\n");
  const longBrief = buildTaskPrompt(task, { maxAttempts: 5, projectInstructions: long, attemptNumber: 1, briefPath: "/briefs/task-brief.md" });
  assert.equal(longBrief.length, short.length, "the prompt of a brief is the same length whatever the project's workflow file holds");

  const longWhole = buildTaskPrompt(task, { maxAttempts: 5, projectInstructions: long, attemptNumber: 1 });
  assert.ok(longBrief.length < longWhole.length / 2, `${longBrief.length} against ${longWhole.length} for a workflow of ${long.length}`);

  const brief = buildTaskBrief(task, { maxAttempts: 5, projectInstructions: long, attemptNumber: 1, briefPath: "/briefs/task-brief.md" });
  assert.match(brief, /Step 12: do the thing numbered 12\./, "and all of it is in the file");
  assert.match(brief, /## Review & Commit/);
});

test("with no brief, the prompt says everything in itself, as it did", () => {
  const text = buildTaskPrompt(task, {
    maxAttempts: 5,
    projectInstructions: "Run `npm test` before you commit anything.",
    attemptNumber: 1,
    briefPath: undefined,
  });
  assert.match(text, /## Working Alone/);
  assert.match(text, /## Project Workflow/);
  assert.match(text, /## Review & Commit/);
  assert.match(text, /## Completion Requirement/);
  assert.match(text, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
  assert.doesNotMatch(text, /task-brief\.md/);
});

test("the second attempt is told an earlier one ran, in the prompt either way", () => {
  const brief = buildTaskPrompt(task, { maxAttempts: 5, attemptNumber: 2, briefPath: "/briefs/task-brief.md" });
  const whole = buildTaskPrompt(task, { maxAttempts: 5, attemptNumber: 2 });
  assert.match(brief, /attempt 2 of up to 5/);
  assert.match(brief, /earlier attempt/);
  assert.match(whole, /## This Is Attempt 2/);
  assert.match(whole, /An earlier attempt/);
});

test("the reminder is named by where the agent reads it, and carries the marker it is there to keep", () => {
  const line = briefReminder("/briefs/task-brief.md");
  assert.match(line, /Task brief/);
  assert.match(line, /`\/briefs\/task-brief\.md`/);
  assert.match(line, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
  assert.ok(line.length < 700, `one line, not a page (${line.length})`);
});

test("a chat is told of its brief only while the file is there, and by where it can open it", () => {
  assert.deepEqual(briefLines("no-brief", "host"), []);

  writeBrief(briefFileOf("briefed"), "text");
  assert.deepEqual(briefLines("briefed", "host"), [briefReminder(path.resolve(briefFileOf("briefed")))]);
  assert.deepEqual(briefLines("briefed", "container"), [briefReminder("/briefs/task-brief.md")]);

  // The attempt is over, the file went with it, and so does the line.
  removeBrief("briefed");
  assert.deepEqual(briefLines("briefed", "host"), []);
});
