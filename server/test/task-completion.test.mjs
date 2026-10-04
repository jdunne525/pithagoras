import { test } from "node:test";
import assert from "node:assert/strict";

// Pure modules (marker detection + prompt building) need neither a database nor
// a live session, so they are tested directly against the compiled output.
const completion = await import("../dist/task-completion.js");
const prompt = await import("../dist/task-prompt.js");

test("the exact promise on its own line counts", () => {
  assert.equal(completion.emitsCompletionPromise("<PROMISE>THIS TASK IS DONE</PROMISE>"), true);
});

test("trailing punctuation still counts", () => {
  assert.equal(completion.emitsCompletionPromise("<PROMISE>THIS TASK IS DONE</PROMISE>."), true);
  assert.equal(completion.emitsCompletionPromise("<PROMISE>THIS TASK IS DONE</PROMISE>;"), true);
});

test("a single pair of backticks or a code fence wrapping still counts", () => {
  assert.equal(completion.emitsCompletionPromise("`<PROMISE>THIS TASK IS DONE</PROMISE>`"), true);
  assert.equal(
    completion.emitsCompletionPromise("```\n<PROMISE>THIS TASK IS DONE</PROMISE>\n```"),
    true
  );
});

test("appearing on its own line within larger text counts", () => {
  assert.equal(
    completion.emitsCompletionPromise("Here is the summary.\n\n<PROMISE>THIS TASK IS DONE</PROMISE>\n\nDone."),
    true
  );
});

test("a mere prose mention must NOT count", () => {
  // A model refusing to emit it, or describing it, must not be read as done.
  assert.equal(
    completion.emitsCompletionPromise("The instructions say to output <PROMISE>THIS TASK IS DONE</PROMISE> when finished."),
    false
  );
  assert.equal(
    completion.emitsCompletionPromise("Please remember to print <PROMISE>THIS TASK IS DONE</PROMISE> at the end."),
    false
  );
});

test("not-on-its-own-line variants do NOT count", () => {
  assert.equal(completion.emitsCompletionPromise("I am done, <PROMISE>THIS TASK IS DONE</PROMISE> now?"), false);
  assert.equal(completion.emitsCompletionPromise("<promise>this task is done</promise>"), false);
  assert.equal(completion.emitsCompletionPromise(""), false);
});

test("buildTaskPrompt wraps the task in the full CodeLoop framing", () => {
  const p = prompt.buildTaskPrompt({ id: "t1", title: "Fix the login bug", description: "Users cannot sign in." });
  assert.match(p, /You are Pithagoras, an AI assistant helping execute task development\./);
  assert.match(p, /## Specific Task\n\nTask: Fix the login bug\n\nDescription:\nUsers cannot sign in\./);
  assert.match(p, /## Review \& Commit/);
  assert.match(p, /review all code changes in detail/);
  assert.match(p, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
  assert.match(p, /## Completion Requirement/);
  // The marker is presented as verbatim code so models keep the tags instead of
  // treating <PROMISE>...</PROMISE> as HTML markup and dropping it.
  assert.match(p, /```[\s\S]*<PROMISE>THIS TASK IS DONE<\/PROMISE>[\s\S]*```/);
  assert.match(p, /LITERAL text/);
  // Default attempt warning is surfaced.
  assert.match(p, /up to 5 attempts/);
});

test("buildTaskPrompt threads project instructions and a custom attempt count", () => {
  const p = prompt.buildTaskPrompt(
    { id: "t2", title: "T", description: "D" },
    { projectInstructions: "Run lint first.", additionalInstructions: "Add a test.", maxAttempts: 7 }
  );
  assert.match(p, /## Project Workflow\n\nRun lint first\./);
  assert.match(p, /## Additional Instructions\n\nAdd a test\./);
  assert.match(p, /up to 7 attempts/);
});
