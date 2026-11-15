import type { TaskRow } from "./db.js";
import { COMPLETION_PROMISE } from "./task-completion.js";

/**
 * Prompt construction (Phase 4), and the task brief it points at.
 *
 * Every attempt of a Task runs through the same CodeLoop framing: a role and
 * Specific Task header, the Working Alone rule, the §7 Project Workflow
 * instructions, the Review & Commit instruction, and the Completion Requirement
 * block that carries the exact promise string.
 *
 * The framing is said in two places, and that is the whole point of this module:
 *
 *  - `buildTaskBrief` writes it into the attempt's brief file, in a folder of the
 *    portal's own data that the agent can read (task-brief.ts), where a
 *    compaction cannot reach it;
 *  - `buildTaskPrompt` opens the run with the task and a pointer to that file,
 *    keeping in the conversation only what must be readable without opening
 *    anything: the task itself and the completion marker.
 *
 * Why a file at all: a compaction summarizes the conversation, and the prompt
 * this run opened with goes into that summary. A Task left without the
 * Completion Requirement does not guess at it — it says so, in terms such as
 * "the required task-completion marker from the compacted context was a harness
 * instruction I can't recover" — then finishes without the marker, which is read
 * as a failed attempt and begun again from nothing in a fresh session. The file
 * is the same words on disk, unchanged by any compaction, and its path is said
 * at system level by `briefLines` (task-brief.ts) — prompt state, which pi
 * replays beside a compaction's summary rather than summarizing it with the
 * chat, so the pointer is there for the run to follow after one.
 *
 * Without a `briefPath` — where the file could not be written, and for callers
 * that hold no folder — the whole framing goes in the prompt as it always has,
 * every section in the conversation itself. The task and the marker are said in
 * both places either way, since those two are what a run must hold without having
 * to open anything to find them.
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
  /**
   * Where the brief file is, named as the agent reads it (task-brief.ts). With
   * it, the standing instructions go in that file and the prompt points at it;
   * without it, every section is said in the prompt itself.
   */
  briefPath?: string;
}

const roleLine = (): string => "You are Pithagoras, an AI assistant helping execute task development.";

const workingAlone = (): string =>
  `You work on your own: no question is put to the person while you run, and none is answered. ` +
  `Read the task as it is written, decide everything it leaves open yourself, and say what you decided ` +
  `and why in the answer you finish on.`;

/**
 * Said with the standing instructions of every Task, in the prompt that carries them
 * all — and in the brief. Where the prompt points at a brief instead, the file holds
 * this and the short line of `instructionRule` (task-brief.ts) is said at system level
 * beside a compaction's summary, so it is not said twice in the conversation.
 *
 * What pi loads as the folder's instructions is read again at the start of every
 * turn of every chat that works in that folder, so anything one Task appends is
 * paid by every chat after it. This repo has seen it twice over: one project's
 * `AGENTS.md` reached 254,261 characters, was cleared to 21,163 on 12 November,
 * and was back to 49,901 two days later, each byte of the second growth written
 * by a Task that ended on a "docs commit" appending what it had just learned.
 *
 * The demand to record decisions used to be here as "write down what you decided
 * and why", with no place named — and the standing file in the folder is the
 * nearest one, which is how the habit started. What a Task decided now goes in
 * its final answer, and only the record the project itself asks for is written.
 */
const instructionsStay = (): string =>
  `## The Folder's Instructions Stay As They Are\n\n` +
  `\`AGENTS.md\`, \`CLAUDE.md\` and every other file pi loads as instructions are read again at the ` +
  `start of every turn of every chat in this folder, so what this Task writes there is paid by every ` +
  `chat that comes after it. Finishing a Task is not a reason to edit them, and not a reason for a ` +
  `docs commit: commit the work the task asked for. Where the project's own instructions ask for a ` +
  `record — a plan or design file it names — write to that file. Change an instructions file only when ` +
  `the task is about that file.`;

const specificTask = (task: Pick<TaskRow, "id" | "title" | "description">): string =>
  `Task: ${task.title}\n\nDescription:\n${task.description ?? ""}`;

/** Said above the first attempt only: what a retry owes the work already in the folder. */
const attemptNote = (attemptNumber: number): string =>
  `An earlier attempt at this task ran in the same folder and ` +
  `may have left its work there, uncommitted and unfinished. Before you write anything, look at what is ` +
  `already in the folder: ` +
  '`git status` and `git diff`' +
  `, the files the task names, and any notes or plan an earlier attempt left. Carry on from what you find ` +
  `rather than starting it again, and do not redo work that is already done. What an earlier attempt wrote ` +
  `is not reviewed yet: treat it as yours to check, revise and commit.`;

const reviewAndCommit = (): string =>
  `When you believe this task is completely ` +
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
const completionRequirement = (maxAttempts: number): string =>
  `When you believe all criteria for this ` +
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

/** The same demand in the few lines the prompt keeps: the marker itself, and the
    two things a model gets wrong about it. The full block is in the brief. */
const completionShort = (maxAttempts: number): string =>
  `## Completion Requirement\n\n` +
  `This Task is complete only when one of your answers carries the string below, exactly as written, ` +
  `on its own line, inside a fenced code block:\n\n` +
  '```\n' +
  COMPLETION_PROMISE +
  '\n```\n\n' +
  `The \`<PROMISE>\` and \`</PROMISE>\` tags are literal text — keep them; the words between them ` +
  `alone do not count. If the string is not found after up to ${maxAttempts} attempts, the Task is ` +
  `marked failed. The full requirement is in the brief file.`;

/** The pointer to the brief, and the two habits it has to install: read it first,
    and read it again after a compaction, when the prompt that named it may be gone. */
const briefPointer = (briefPath: string): string =>
  `## The Standing Instructions Are in a File\n\n` +
  `\`${briefPath}\` holds this run's standing instructions: working alone, what the folder's own ` +
  `instructions are for, the project's workflow, review & commit, and the full completion requirement. ` +
  `Read that file before you start.\n\n` +
  `A compaction summarizes this conversation — the prompt you are reading and your earlier answers ` +
  `can be gone from it later. The file cannot, and it does not change. Whenever you find you no longer ` +
  `hold those instructions, read the file again and carry on from where you left off; do not ask for ` +
  `the task again and do not start it over. The file is the portal's, not the repository's: leave it ` +
  `where it is and do not commit it.`;

/** Assemble the standing instructions of an attempt into the text of its brief file. */
export function buildTaskBrief(
  task: Pick<TaskRow, "id" | "title" | "description">,
  opts: BuildPromptOptions = {}
): string {
  const {
    projectInstructions = "",
    additionalInstructions = "",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    attemptNumber = 1,
    briefPath = "",
  } = opts;

  const where = briefPath || "the path your opening prompt names";
  let text =
    `# Task brief — ${task.title}\n\n` +
    `Attempt ${attemptNumber} of up to ${maxAttempts} at this task. This file holds the standing ` +
    `instructions for it; they belong to the portal, not to the repository you are working in, so ` +
    `leave this file as it is and do not commit it.\n\n` +
    `The conversation can be compacted, and a compaction summarizes what came before it — including ` +
    `the prompt that opened this run, and the answers you gave from it. Nothing here changes when that ` +
    `happens. If you no longer hold these instructions, read this file again at \`${where}\` and carry ` +
    `on from where you left off: do not ask for the task again, and do not begin it from nothing.\n\n` +
    // The task itself, copied in. What a Task has to do is the thing a summary is most
    // likely to keep and least likely to keep whole; the file has all of it either way.
    `## Specific Task\n\n${specificTask(task)}\n\n` +
    `## Working Alone\n\n${workingAlone()}`;

  if (projectInstructions.trim()) {
    text += `\n\n## Project Workflow\n\n${projectInstructions.trim()}`;
  }

  if (additionalInstructions.trim()) {
    text += `\n\n## Additional Instructions\n\n${additionalInstructions.trim()}`;
  }

  if (attemptNumber > 1) {
    text += `\n\n## This Is Attempt ${attemptNumber}\n\n${attemptNote(attemptNumber)}`;
  }

  text += `\n\n${instructionsStay()}`;
  text += `\n\n## Review & Commit\n\n${reviewAndCommit()}`;
  text += `\n\n## Completion Requirement\n\n${completionRequirement(maxAttempts)}`;

  return text + "\n";
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
    briefPath = "",
  } = opts;

  // With a brief, the conversation carries the task, the pointer, and the marker.
  // Everything else the run is told is in the file, which is what survives a
  // compaction — and saying it twice would spend a third of the window on it.
  if (briefPath) {
    let prompt = `${roleLine()}\n\n## Specific Task\n\n${specificTask(task)}\n\n${briefPointer(briefPath)}`;
    if (attemptNumber > 1) {
      prompt +=
        `\n\nThis is attempt ${attemptNumber} of up to ${maxAttempts}: an earlier attempt ran in this ` +
        `folder and may have left its work there uncommitted. The brief says what to do about that.`;
    } else {
      prompt += `\n\nThis is attempt 1 of up to ${maxAttempts}.`;
    }
    prompt += `\n\n${workingAlone()}\n\n## Completion Requirement\n\n${completionShort(maxAttempts)}`;
    return prompt;
  }

  let prompt = `${roleLine()}\n\n## Working Alone\n\n${workingAlone()}\n\n## Specific Task\n\n${specificTask(task)}`;

  // An attempt above the first is a second try at the same work in the same folder, and
  // the work of the first is sitting in that folder. Said plainly, because without it
  // every retry reads the repo from nothing and re-does what is already written.
  if (attemptNumber > 1) {
    prompt += `\n\n## This Is Attempt ${attemptNumber}\n\n${attemptNote(attemptNumber)}`;
  }

  if (projectInstructions.trim()) {
    prompt += `\n\n## Project Workflow\n\n${projectInstructions.trim()}`;
  }

  if (additionalInstructions.trim()) {
    prompt += `\n\n## Additional Instructions\n\n${additionalInstructions.trim()}`;
  }

  prompt += `\n\n${instructionsStay()}`;
  prompt += `\n\n## Review & Commit\n\n${reviewAndCommit()}`;
  prompt += `\n\n## Completion Requirement\n\n${completionRequirement(maxAttempts)}`;

  return prompt;
}
