import type { TaskRow } from "./db.js";

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

/** Attempts the Completion Requirement warns about before failure defaults to. */
const DEFAULT_MAX_ATTEMPTS = 5;

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

  prompt +=
    `\n\n## Completion Requirement\n\nWhen you believe all criteria for this ` +
    `task have been fully met, you MUST output the following string exactly as ` +
    `written on its own line:\n\n<PROMISE>THIS TASK IS DONE</PROMISE>\n\n` +
    `The task will only be marked complete when that exact string appears in the ` +
    `assistant's output. If the string is not found after up to ${maxAttempts} ` +
    `attempts, the task will be marked as failed.`;

  return prompt;
}
