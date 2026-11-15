import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskBrief, buildTaskPrompt } from "../dist/task-prompt.js";
import { instructionRule } from "../dist/task-brief.js";

// A Task's standing instructions used to end Working Alone with "write down what you
// decided and why", naming no place. In a folder whose AGENTS.md pi reads every turn,
// that file is the nearest standing thing to write to, and one project's AGENTS.md went
// 254,261 characters → cleared to 21,163 (12 November) → 49,901 by 14 November, each
// byte of the second growth added by a Task ending on a "docs commit".

const task = { id: "t1", title: "Zoom setting", description: "Adjust the zoom level of the view." };

test("no standing instruction asks the run to write something down", () => {
  for (const text of [buildTaskPrompt(task), buildTaskBrief(task)]) {
    assert.ok(!/write down/i.test(text), "the open-ended demand to write is gone");
    assert.ok(text.includes("say what you decided"), "what it decided is still said, in its answer");
  }
});

test("the prompt and the brief both hold the folder's instructions back", () => {
  for (const text of [buildTaskPrompt(task), buildTaskBrief(task)]) {
    assert.ok(text.includes("## The Folder's Instructions Stay As They Are"), "the section is there");
    assert.ok(text.includes("AGENTS.md"), "it names the file");
    assert.ok(text.includes("read again at the"), "and says why: every chat reads it again");
    assert.ok(text.includes("not a reason for a docs commit"), "and rules out the docs commit");
    // It must not forbid the record the project asks for itself.
    assert.ok(text.includes("a plan or design file it names"), "the project's own record is still written");
  }
});

test("the section sits before Review & Commit, so the commit habit is held to it", () => {
  const prompt = buildTaskPrompt(task, { projectInstructions: "Run build-and-run-web.ps1." });
  const order = ["## Specific Task", "## Project Workflow", "## The Folder's Instructions", "## Review & Commit", "## Completion Requirement"].map((h) => prompt.indexOf(h));
  assert.ok(order.every((at) => at >= 0), "every section is there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");

  const brief = buildTaskBrief(task, { projectInstructions: "Run build-and-run-web.ps1." });
  const briefOrder = ["## Project Workflow", "## The Folder's Instructions", "## Review & Commit", "## Completion Requirement"].map((h) => brief.indexOf(h));
  assert.ok(briefOrder.every((at) => at >= 0), "the brief holds them too");
  assert.deepEqual([...briefOrder].sort((a, b) => a - b), briefOrder, "in that order");
});

test("a run whose prompt points at the brief is told where the rule is", () => {
  const prompt = buildTaskPrompt(task, { briefPath: "/briefs/task-brief.md" });
  assert.ok(prompt.includes("what the folder's own"), "named among what the brief holds");
  // The prompt stays the task, the pointer and the marker: the rule is in the file,
  // and its short line is said at system level beside a compaction's summary.
  assert.ok(!prompt.includes("## The Folder's Instructions"), "not said at length in the conversation");
  assert.ok(prompt.includes("<PROMISE>THIS TASK IS DONE</PROMISE>"), "the marker is still there");
});

test("the line replayed beside a compaction says it as well, and stays short", () => {
  const line = instructionRule();
  assert.ok(line.includes("AGENTS.md"), "the file is named");
  assert.ok(line.includes("every turn of every chat"), "and why it is held back");
  assert.ok(line.includes("commit the work"), "and what to commit instead");
  assert.ok(line.length < 400, `one line, said at every turn (${line.length})`);
});
