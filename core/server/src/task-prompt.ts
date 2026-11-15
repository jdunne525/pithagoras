import type { TaskRow } from "./db.js";
import { COMPLETION_PROMISE } from "./task-completion.js";

/**
 * Prompt construction (Phase 4).
 *
 * Every attempt of a Task runs through the same CodeLoop framing: a role and
 * Specific Task header, the Review & Commit instruction, and the Completion
 * Requirement block that carries the exact promise string. This module builds
 * that prompt. Only the framing above ships in Phase 4; the §7 Project
 * Workflow instructions are threaded through as an argument so Phase 7 can
 * populate it here without changing this contract.
 */

/** Attempts the Completion Requirement warns about before failure defaults to.
    This is the one server-wide cap every Task is bounded by — there is no
    per-Task max (Phase 5) — so the execution layer imports it here rather than
    carrying its own copy. */
export const DEFAULT_MAX_ATTEMPTS = 5;

interface BuildPromptOptions {
  /** §7 Project Workflow instructions (deferred; empty until implemented). */
  projectInstructions?: string;
  /** Per-task addenda (deferred; empty until implemented). */
  additionalInstructions?: string;
  /** max_attempts, surfaced in the Completion Requirement warning. */
  maxAttempts?: number;
  /**
   * Which attempt of the Task this prompt is, 1 for the first. Above 1 the prompt
   * says so and points at the work an earlier attempt may have left behind.
   *
   * An attempt that ends on a model or engine error leaves its edits where they were
   * written — the workspace is the folder, not the session — and the next attempt has
   * historically begun by re-reading the repo from nothing. BlastRunHero's
   * `Brutes should shoot` Task (c67318ec, 15 November) spent 3 hours 18 minutes that
   * way across five sessions, and the fifth one's own report says the implementation
   * was already in the tree and uncommitted: what it had to do was find it.
   */
  attemptNumber?: number;
}

/** Assemble the CodeLoop prompt for a Task. */
export function buildTaskPrompt(
  task: Pick<TaskRow, "id" | "title" | "description">,
  opts: BuildPromptOptions = {}
): string {
  const {
    projectInstructions = "",
    additionalInstructions = "",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    attemptNumber = 1,
  } = opts;

  let prompt =
    `You are Pithagoras, an AI assistant helping execute task development.\n\n` +
    // The task's run has no ask_question (session-manager.ts canAsk): nobody is at its page to answer, and a model
    // that expects a question to be answered leaves the work half-done and asks in its answer instead.
    `## Working Alone\n\nYou work on your own: no question is put to the person while you run, and none is answered. ` +
    `Read the task as it is written, decide everything it leaves open yourself, and write down what you decided and why.\n\n` +
    `## Specific Task\n\nTask: ${task.title}\n\nDescription:\n${task.description ?? ""}`;

  // An attempt above the first is a second try at the same work in the same folder, and
  // the work of the first is sitting in that folder. Said plainly, because without it
  // every retry reads the repo from nothing and re-does what is already written.
  if (attemptNumber > 1) {
    prompt +=
      `\n\n## This Is Attempt ${attemptNumber}\n\nAn earlier attempt at this task ran in the same folder and ` +
      `may have left its work there, uncommitted and unfinished. Before you write anything, look at what is ` +
      `already in the folder: ` +
      '`git status` and `git diff`' +
      `, the files the task names, and any notes or plan an earlier attempt left. Carry on from what you find ` +
      `rather than starting it again, and do not redo work that is already done. What an earlier attempt wrote ` +
      `is not reviewed yet: treat it as yours to check, revise and commit.`;
  }

  if (projectInstructions.trim()) {
    prompt += `\n\n## Project Workflow\n\n${projectInstructions.trim()}`;
  }

  if (additionalInstructions.trim()) {
    prompt += `\n\n## Additional Instructions\n\n${additionalInstructions.trim()}`;
  }

  prompt +=
    `\n\n## Review & Commit\n\nWhen you believe this task is completely ` +
    `implemented, before finishing, review all code changes in detail and ensure ` +
    `they accomplish the stated goal and do not break any other functionality. ` +
    `Revise the code if needed.`;

  // NOTE: The completion marker is shown inside a fenced code block and is
  // explicitly called out as LITERAL text. Angle-bracket tokens like
  // <PROMISE>...</PROMISE> read as HTML/markup to most models, which then drop
  // the tags and emit only "THIS TASK IS DONE" — which fails the strict
  // standalone-line detection in task-completion.ts. Presenting it as verbatim
  // code (and telling the model the tags are literal) makes Pithagoras behave
  // like codeloop, where the marker reliably keeps its tags.
  prompt +=
    `\n\n## Completion Requirement\n\nWhen you believe all criteria for this ` +
    `task have been fully met, you MUST output the following string exactly as ` +
    `written, on its own line, inside a fenced code block:\n\n` +
    '```\n' +
    COMPLETION_PROMISE +
    '\n```\n\n' +
    `The \`<PROMISE>\` and \`</PROMISE>\` tags are LITERAL text — copy them exactly, ` +
    `do not treat them as formatting or HTML, and do not remove them. The task is ` +
    `only marked complete when that exact string, including the tags, appears in the ` +
    `assistant's output. If the string is not found after up to ${maxAttempts} ` +
    `attempts, the task will be marked as failed.`;

  return prompt;
}
