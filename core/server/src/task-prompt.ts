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
  } = opts;

  let prompt =
    `You are Pithagoras, an AI assistant helping execute task development.\n\n` +
    `## Specific Task\n\nTask: ${task.title}\n\nDescription:\n${task.description ?? ""}`;

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
