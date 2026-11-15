import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskPrompt } from "../dist/task-prompt.js";

// A second attempt at a Task runs in the same folder as the first, and the first
// attempt's work is in that folder — an attempt that ends on a model or engine
// error leaves its edits written and uncommitted. BlastRunHero's
// `Brutes should shoot a green projectile` Task (c67318ec, 15 November) spent five
// sessions and 3 hours 18 minutes on this: attempts 2, 3 and 4 each read the repo
// from nothing, and the fifth's own report says the implementation was already in
// the tree, uncommitted — the work it had to do was to find what was there.

const task = { id: "t1", title: "Brutes shoot a green projectile", description: "Stuns the player for 3 seconds." };

test("the first attempt is told nothing about attempts", () => {
  const prompt = buildTaskPrompt(task);
  assert.ok(!prompt.includes("This Is Attempt"), "no attempt section on the first attempt");
  assert.ok(!prompt.includes("git status"), "no instruction to look for work that cannot exist yet");
  // The framing every attempt needs is unchanged.
  assert.ok(prompt.includes("## Specific Task"));
  assert.ok(prompt.includes("<PROMISE>THIS TASK IS DONE</PROMISE>"));
});

test("a later attempt is told to look at what the earlier one left", () => {
  const prompt = buildTaskPrompt(task, { attemptNumber: 2 });
  assert.ok(prompt.includes("## This Is Attempt 2"), "the attempt is named");
  assert.ok(prompt.includes("git status"), "it is pointed at the folder's own state");
  assert.ok(prompt.includes("git diff"), "and at what was changed in it");
  assert.ok(prompt.includes("rather than starting it again"), "and told not to redo the work");
  assert.ok(prompt.includes("not reviewed yet"), "what it finds is still its own to review");
  // The promise still comes last: an attempt section before it must not move it.
  assert.ok(prompt.indexOf("## This Is Attempt 2") < prompt.indexOf("## Completion Requirement"), "the completion requirement still follows");
});

test("the attempt section sits with the task, before the workflow and the completion block", () => {
  const prompt = buildTaskPrompt(task, { attemptNumber: 5, projectInstructions: "Run build-and-run-web.ps1." });
  const order = ["## Specific Task", "## This Is Attempt 5", "## Project Workflow", "## Review & Commit", "## Completion Requirement"].map((heading) => prompt.indexOf(heading));
  assert.ok(order.every((at) => at >= 0), "every section is there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
});
