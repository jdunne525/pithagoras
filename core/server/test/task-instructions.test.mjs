import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-tasks-inst-"));
// A fresh throwaway project folder every call, so nothing leaks between tests.
const dir = () => path.join(home, randomUUID());

const projects = await import("../dist/projects.js");
const { buildTaskPrompt } = await import("../dist/task-prompt.js");

test("a project has no Task instructions until one is written", () => {
  assert.equal(projects.readTaskInstructions(dir()), "", "empty means there is none");
});

test("writing then reading a project's Task instructions round-trips", () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  projects.writeTaskInstructions(d, "Restart the dev server after each task.\n");
  assert.ok(existsSync(path.join(d, projects.TASK_INSTRUCTIONS_FILE)), "saved as its own file");
  assert.equal(projects.readTaskInstructions(d).trim(), "Restart the dev server after each task.");
});

test("blanking the instructions removes the file", () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  projects.writeTaskInstructions(d, "Some guidance");
  assert.ok(existsSync(path.join(d, projects.TASK_INSTRUCTIONS_FILE)));
  projects.writeTaskInstructions(d, "   \n ");
  assert.ok(!existsSync(path.join(d, projects.TASK_INSTRUCTIONS_FILE)), "blank removes it");
  assert.equal(projects.readTaskInstructions(d), "");
});

test("the instructions sit beside AGENTS.md but never become it", () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  projects.writeTaskInstructions(d, "Guidance for tasks only");
  // Two distinct files: the Task instructions one exists, AGENTS.md does not.
  assert.ok(existsSync(path.join(d, projects.TASK_INSTRUCTIONS_FILE)));
  assert.ok(!existsSync(path.join(d, projects.INSTRUCTIONS_FILE)));
});

test("the prompt carries the instructions as their own block, with the marker intact", () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  projects.writeTaskInstructions(d, "Always run the tests before finishing.");
  const prompt = buildTaskPrompt(
    { id: "t", title: "Fix auth", description: "the login is broken" },
    { projectInstructions: projects.readTaskInstructions(d) },
  );
  assert.match(prompt, /## Project Workflow\n\nAlways run the tests before finishing\./);
  // The framing still carries the completion marker untouched.
  assert.match(prompt, /<PROMISE>THIS TASK IS DONE<\/PROMISE>/);
});
