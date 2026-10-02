import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import { titleFrom } from "./projects.js";

/**
 * Autonomous Tasks: the durable unit of work from the CodeLoop plan (§4–§13).
 *
 * This module is the only place Task lifecycle rules live. Route handlers stay
 * thin here on purpose — they parse a request and call one function below — so
 * the behaviour can evolve without touching networking. See the plan's
 * architectural rule #10: orchestration stays separate from ordinary chat
 * execution.
 */

export type TaskStatus = db.TaskStatus;

const TERMINAL: TaskStatus[] = ["completed", "failed", "stopped"];

export class TaskError extends Error {
  constructor(
    readonly code: "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

interface CreateTaskInput {
  /** Resolved absolute path of the owning project folder. */
  workspace: string;
  /** Chosen title, when one was given. Otherwise derived from the prompt. */
  title?: string;
  description?: string;
  /** Highest allowed autonomous attempts, or null for unbounded. */
  maxAttempts?: number | null;
}

interface EditTaskInput {
  title?: string;
  description?: string;
  /** Not changed while a Task runs — a run may already be counting down to it. */
  maxAttempts?: number | null;
}

const utcNow = (): string =>
  new Date().toISOString().replace("T", " ").replace(/\.\d+$/, "");

/** The one thing every Task needs: a non-blank title. Everything else optional. */
const validateTitle = (title: unknown): string => {
  if (typeof title !== "string" || !title.trim()) {
    throw new TaskError("invalid", "title must be text");
  }
  return title.trim();
};

/** What every Task starts with: a short title. Given directly, or taken from
    the prompt the same way a chat is named (`titleFrom`). Neither present
    means there was nothing to name it with. */
const resolveTitle = (input: Pick<CreateTaskInput, "title" | "description">): string | undefined => {
  const chosen = input.title?.trim();
  if (chosen) return chosen;
  return titleFrom(input.description ?? "")?.trim();
};

/** A positive integer ceiling on attempts, or null meaning "no limit". */
const parseMaxAttempts = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TaskError("invalid", "max_attempts must be a whole number >= 1");
  }
  return value;
};

export const listTasks = (workspace: string): db.TaskRow[] =>
  db.listTasksByWorkspace(workspace);

export const getTask = (id: string): db.TaskRow => {
  const task = db.getTask(id);
  if (!task) throw new TaskError("missing", `There is no task "${id}"`);
  return task;
};

export const createTask = (input: CreateTaskInput): db.TaskRow => {
  if (typeof input.workspace !== "string" || !input.workspace.trim()) {
    throw new TaskError("invalid", "workspace is required");
  }
  const title = resolveTitle(input);
  if (!title) throw new TaskError("invalid", "a title or prompt is required");
  return db.createTask({
    id: randomUUID(),
    workspace: input.workspace,
    title,
    description: input.description ?? "",
    max_attempts: parseMaxAttempts(input.maxAttempts),
  });
};

export const editTask = (id: string, patch: EditTaskInput): db.TaskRow | undefined => {
  const task = getTask(id);
  const fields: db.UpdatableTaskFields = {};
  if (patch.title !== undefined) fields.title = validateTitle(patch.title);
  if (patch.description !== undefined) fields.description = patch.description;
  if (patch.maxAttempts !== undefined) {
    if (task.status === "running") {
      throw new TaskError(
        "invalid",
        "max_attempts cannot change while a task is running",
      );
    }
    fields.max_attempts = parseMaxAttempts(patch.maxAttempts);
  }
  return db.updateTaskFields(id, fields);
};

export const deleteTask = (id: string): void => {
  getTask(id); // exists? report missing rather than deleting nothing.
  db.deleteTask(id);
};

/** Reorder a project's Tasks into the given ids (first runs first). Every id
    must belong to that project, so the queue keeps only real Tasks. */
export const setTaskOrder = (workspace: string, ids: readonly string[]): void => {
  if (!ids.every((id) => typeof id === "string" && db.getTask(id)?.workspace === workspace)) {
    throw new TaskError("invalid", "unknown task id");
  }
  db.reorderTasks(workspace, [...ids]);
};

/**
 * A lifecycle transition shared by manual start/stop, rerun and recovery.
 *
 * Keeps timestamps honest in one place: a Task starts when it goes running
 * (once), and settles into completed_at when it reaches a terminal state.
 * Sending it back to pending clears that marker so it can finish again.
 */
export const setTaskStatus = (id: string, status: TaskStatus): db.TaskRow | undefined => {
  const task = getTask(id);
  if (!TERMINAL.includes(status) && status !== "pending" && status !== "running") {
    throw new TaskError("invalid", `unknown task status "${status}"`);
  }
  const fields: db.UpdatableTaskFields = { status };
  if (status === "running" && !task.started_at) fields.started_at = utcNow();
  else if (TERMINAL.includes(status)) fields.completed_at = utcNow();
  else fields.completed_at = null; // back to pending
  return db.updateTaskFields(id, fields);
};

/**
 * Begin a fresh attempt (§6, §7): bump the Task's attempt count, open a new
 * attempt row, and mark both it and the Task running. The previous attempt, if
 * any, is untouched — it stays as history. Pass the session only once the agent
 * session has actually been created for this attempt.
 */
export const startAttempt = (
  taskId: string,
  sessionId?: string | null,
): { task: db.TaskRow; attempt: db.TaskAttemptRow } => {
  const task = getTask(taskId);
  const next = db.lastAttemptNumber(taskId) + 1;
  const created = db.createAttempt({ id: randomUUID(), task_id: taskId, attempt_number: next });
  const attempt = db.updateAttemptFields(created.id, {
    session_id: sessionId ?? null,
    status: "running",
    started_at: utcNow(),
  })!;
  const updated = db.updateTaskFields(taskId, {
    status: "running",
    attempts: task.attempts + 1,
    started_at: task.started_at ?? utcNow(),
  });
  if (!updated) throw new TaskError("missing", `There is no task "${taskId}"`);
  return { task: updated, attempt };
};

/**
 * End an attempt (§9). The caller decides the outcome: a valid completion
 * marker yields "completed"; stopping yields "stopped"; anything else that was
 * meant to finish yields "failed". The Task's own status is left to the caller,
 * which keeps completion detection isolated from attempt bookkeeping.
 */
export const finishAttempt = (
  attemptId: string,
  status: Extract<TaskStatus, "completed" | "failed" | "stopped">,
): db.TaskAttemptRow => {
  const attempt = db.getAttempt(attemptId);
  if (!attempt) throw new TaskError("missing", `There is no attempt "${attemptId}"`);
  if (!TERMINAL.includes(status)) {
    throw new TaskError("invalid", `attempt cannot end in "${status}"`);
  }
  return db.updateAttemptFields(attemptId, { status, completed_at: utcNow() })!;
};
