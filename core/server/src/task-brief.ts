import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dataFolder } from "./data-dir.js";
import { writeFileAtomic } from "./atomic-write.js";
import { COMPLETION_PROMISE } from "./task-completion.js";

/**
 * The task brief: the standing instructions of an autonomous Task, kept in a
 * file the attempt reads, rather than only in the prompt that opens it.
 *
 * A compaction summarizes the conversation — and the prompt a run opened with
 * goes into that summary with it. A Task left without the Completion
 * Requirement does not invent one: it says so in plain words ("the required
 * task-completion marker from the compacted context was a harness instruction
 * I can't recover"), finishes without the marker, and the attempt is written
 * failed over work still in hand, the queue then starting the Task again in a
 * fresh session. Instructions on disk are not summarized, and the pointer to
 * them is said at system level (`briefLines` below), which pi replays beside a
 * compaction's summary instead of summarizing it with the chat.
 *
 * Where the file goes is decided by who has to be able to open it:
 *
 *   - the agent, when the sandbox is on — so not in the session folder, which
 *     the sandbox policy closes to it by default (`defaultRules`: every chat's
 *     transcript is `none`), and not in the repository, where it would turn up
 *     in `git status` and get committed with the work;
 *   - a container's pi, which sees only what is mounted for it — so the folder
 *     is mounted read-only beside `/workspace` and `/sessions`
 *     (`ContainerExecutor`);
 *   - the portal, which writes it before the attempt's first prompt and removes
 *     it when the attempt is over.
 *
 * A folder of the data directory answers all three: nothing closes it, it is on
 * the volume the image already mounts, and it is the portal's to write — the
 * agent reads it and cannot change what it says.
 */

/** pi's container sees the brief's folder under this name: see `ContainerExecutor`. */
export const CONTAINER_BRIEF_DIR = "/briefs";

/** The brief's name inside its folder. Not `.jsonl`, so pi's session listing never reads it. */
export const BRIEF_FILE = "task-brief.md";

/** Where briefs are kept, `TASK_BRIEF_DIR` putting it somewhere else. */
export const briefRoot = (): string => dataFolder("TASK_BRIEF_DIR", "task-briefs");

/** The folder of one attempt's brief: mounted into its container, written on the portal's side. */
export const briefDirOf = (sessionId: string): string => path.join(briefRoot(), sessionId);

/** Where an attempt's brief is written, on the portal's side of the mount. */
export const briefFileOf = (sessionId: string): string => path.join(briefDirOf(sessionId), BRIEF_FILE);

/**
 * Where the agent reads that same file: as it is reached from where it works.
 * A host chat works on the portal's paths; a container's pi has the attempt's
 * brief folder mounted at `CONTAINER_BRIEF_DIR`, so the portal's path would
 * name nothing it can open.
 */
export const briefSeenBy = (sessionId: string, executor: string): string =>
  executor === "host" ? path.resolve(briefFileOf(sessionId)) : `${CONTAINER_BRIEF_DIR}/${BRIEF_FILE}`;

/**
 * Put the brief where `file` says, making its folder first.
 *
 * The folder is left at the umask's default (0755) and the file at 0644: the
 * agent's own user has to be able to open it, which under the sandbox is a
 * different user from the portal's. Nothing secret is in it — it is the same
 * text the prompt has always carried.
 *
 * False when it cannot be written, a full disk or a folder that is not ours.
 * The run then says its instructions in its prompt as it always did: losing the
 * brief is not a reason to lose the attempt.
 */
export function writeBrief(file: string, text: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take an attempt's brief away with the attempt.
 *
 * The work is over — settled, stopped, or dropped — and what the file was for
 * is said in the transcript. Briefs are keyed by session, so nothing else
 * removes them: they are not in the session's folder, which deletion does take.
 */
export function removeBrief(sessionId: string): void {
  try {
    rmSync(briefDirOf(sessionId), { recursive: true, force: true });
  } catch {
    // Nothing there, or nothing ours to take: no work depends on this.
  }
}

/** Whether an attempt has a brief to be pointed at. */
export const briefExists = (sessionId: string): boolean => existsSync(briefFileOf(sessionId));

/** The one line that carries the brief back to the model, named by where it reads it. */
export function briefReminder(where: string): string {
  return (
    `Task brief: this autonomous Task's standing instructions — the task itself, working alone, the ` +
    `project's workflow, review & commit, and how the Task ends — are in \`${where}\`. Read that file ` +
    `before you start, and read it again whenever you no longer hold them: compacting the ` +
    `conversation does not touch this file, and nothing else holds them. The Task is complete only ` +
    `when one of your answers carries the marker below on its own line, tags included, exactly as ` +
    `written:\n` +
    "```\n" +
    COMPLETION_PROMISE +
    "\n```"
  );
}

/**
 * What a chat is told about its brief as its prompt is loaded, and nothing for a
 * chat with none.
 *
 * Asked at load rather than fixed for the life of the chat — the brief is written
 * when an attempt starts and taken away when it is over, and a chat reopened
 * after a restart reads what is there now.
 *
 * It is said at system level on purpose: a line in the conversation is exactly
 * what a compaction turns into a summary, while pi's prompt is prompt *state* —
 * replayed beside the summary rather than folded into it — so the pointer outlives
 * every cut of the chat, and what it points at is on disk either way.
 */
export function briefLines(sessionId: string, executor: string): string[] {
  if (!briefExists(sessionId)) return [];
  return [briefReminder(briefSeenBy(sessionId, executor))];
}
