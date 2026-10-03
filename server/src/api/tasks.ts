import express, { type Router } from "express";
import { getProject, ProjectError } from "../projects.js";
import { workspaceRoot } from "../workspaces.js";
import * as tasks from "../tasks.js";
import { completeTask } from "../tasks.js";
import { startTask, stopTask } from "../task-execution.js";
import { startLoop, stopLoop, isLoopRunning } from "../task-queue.js";
import type { TaskRow, TaskStatus } from "../db.js";
import { DEFAULT_MAX_ATTEMPTS } from "../task-prompt.js";

/**
 * Minimal Tasks API for Phase 1: CRUD plus the two lifecycle hooks the service
 * exposes (start an attempt, set a status). Everything else — execution,
 * completion, retry, recovery — sits behind these same service functions and
 * is added in later phases without changing these routes.
 *
 * Every route is under a project so a Task is always scoped to the folder it
 * owns; the project name is resolved exactly like the other project routes.
 */
export function tasksRouter(): Router {
  const router = express.Router();
  const root = workspaceRoot();

  // Resolve the owning project folder, reporting a missing/invalid project as
  // 404 the way the rest of the project routes do.
  const projectPath = (name: string): string => getProject(root, name).path;

  const fail = (res: express.Response, e: unknown) => {
    if (e instanceof ProjectError) return res.status(e.code === "exists" ? 409 : 404).json({ error: e.message });
    if (e instanceof tasks.TaskError) return res.status(e.code === "missing" ? 404 : 400).json({ error: e.message });
    return res.status(500).json({ error: String(e) });
  };

  /** Every Task reports the same server-wide attempt budget (Phase 5), so the
    view can show "3/5" and gate run controls without a per-Task value. */
  const expose = (row: TaskRow): TaskRow => ({ ...row, max_attempts: DEFAULT_MAX_ATTEMPTS });

  /** A status the browser or a later phase can send, validated against the five states. */
  const parseStatus = (value: unknown): TaskStatus | undefined => {
    if (["pending", "running", "completed", "failed", "stopped"].includes(value as string)) {
      return value as TaskStatus;
    }
    return undefined;
  };

  // List a project's Tasks in queue order.
  router.get("/projects/:name/tasks", (req, res) => {
    try {
      res.json(tasks.listTasks(projectPath(req.params.name)).map(expose));
    } catch (e) {
      fail(res, e);
    }
  });

  // Create a task in a project. Either a chosen title or the prompt it was
  // made from; the service names it from the prompt when no title is given.
  router.post("/projects/:name/tasks", (req, res) => {
    const body = req.body ?? {};
    try {
      // No per-Task max attempts (Phase 5): only title/description are taken.
      res.status(201).json(
        tasks.createTask({
          workspace: projectPath(req.params.name),
          title: body.title || undefined,
          description: body.description || undefined,
        }),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  // Reorder a project's Tasks. Placed before the /:id routes so "order" is not
  // read as an id. Accepts an ordered array of task ids.
  router.put("/projects/:name/tasks/order", (req, res) => {
    const ids = req.body?.order;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return res.status(400).json({ error: "order must be an array of task ids" });
    }
    try {
      tasks.setTaskOrder(projectPath(req.params.name), ids);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Read one task. Left unexposed: single reads are rarely rendered with an
  // attempt count, and the list always exposes the server-wide budget.
  router.get("/projects/:name/tasks/:id", (req, res) => {
    try {
      res.json(tasks.getTask(req.params.id));
    } catch (e) {
      fail(res, e);
    }
  });

  // Edit a task's title/description.
  router.put("/projects/:name/tasks/:id", (req, res) => {
    const body = req.body ?? {};
    try {
      res.json(expose(tasks.editTask(req.params.id, {
        title: body.title,
        description: body.description,
      })!));
    } catch (e) {
      fail(res, e);
    }
  });

  // Rerun (Phase 5): reset a task to pending WITHOUT starting it, so it can be
  // reordered and Run later. Distinct verb from /start.
  router.post("/projects/:name/tasks/:id/rerun", (req, res) => {
    try {
      res.json(expose(tasks.rerunTask(req.params.id)));
    } catch (e) {
      fail(res, e);
    }
  });

  // Mark complete: settle a task to completed no matter what state it was in,
  // including while it is running. A distinct verb from /status so the intent
  // ("done by hand") is clear, and it bypasses any per-state guard.
  router.post("/projects/:name/tasks/:id/complete", (req, res) => {
    try {
      res.json(expose(completeTask(req.params.id)));
    } catch (e) {
      fail(res, e);
    }
  });

  // Delete a task (and its attempts).
  router.delete("/projects/:name/tasks/:id", (req, res) => {
    try {
      tasks.deleteTask(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Lifecycle: move a task between states (start/stop/rerun/recovery live here).
  // Stopping is special — it unwinds the running agent as well as the status,
  // so it goes through the execution module rather than a bare status change.
  router.patch("/projects/:name/tasks/:id/status", (req, res) => {
    const body = req.body ?? {};
    const status = parseStatus(body.status);
    if (!status) return res.status(400).json({ error: "status required: pending|running|completed|failed|stopped" });
    try {
      res.json(status === "stopped" ? stopTask(req.params.id) : tasks.setTaskStatus(req.params.id, status));
    } catch (e) {
      fail(res, e);
    }
  });

  // Begin a fresh autonomous run of a Task. This creates the session the
  // attempt works in and hands the Task to it, so the browser passes nothing
  // but the id and gets back the new attempt and its session.
  router.post("/projects/:name/tasks/:id/start", (req, res) => {
    try {
      res.status(201).json(startTask(req.params.id));
    } catch (e) {
      fail(res, e);
    }
  });

  // Queue loop: drive this project's Tasks through the durable queue. Starting
  // launches the loop (one agent at a time across all projects); stopping unwinds
  // the current attempt and clears the loop. A failed Task cannot be bypassed, so
  // the loop stalls on it until the user intervenes.
  router.post("/projects/:name/queue/start", (req, res) => {
    try {
      startLoop(projectPath(req.params.name));
      res.json({ ok: true, running: isLoopRunning(projectPath(req.params.name)) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post("/projects/:name/queue/stop", (req, res) => {
    try {
      stopLoop(projectPath(req.params.name));
      res.json({ ok: true, running: isLoopRunning(projectPath(req.params.name)) });
    } catch (e) {
      fail(res, e);
    }
  });

  // Current queue-loop state for this project, so the UI toggle reflects it on
  // first load rather than assuming stopped.
  router.get("/projects/:name/queue/status", (req, res) => {
    try {
      res.json({ running: isLoopRunning(projectPath(req.params.name)) });
    } catch (e) {
      fail(res, e);
    }
  });

  // The runs of one Task, oldest first: each carries the session it worked in,
  // so the view can render an attempt's history once it exists without another
  // round-trip. Previous attempts stay as history; a delete still drops them.
  router.get("/projects/:name/tasks/:id/attempts", (req, res) => {
    try {
      res.json(tasks.listAttemptsByTask(req.params.id));
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}
