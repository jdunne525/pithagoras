import express, { type Router } from "express";
import { getProject, ProjectError } from "../projects.js";
import { workspaceRoot } from "../workspaces.js";
import * as scripts from "../scripts.js";
import { createScript, ScriptError } from "../scripts.js";
import { getRun, startRun, stopRun, subscribeRun } from "../script-runs.js";
import type { ScriptRow } from "../db.js";

/**
 * Scripts API. Like the Tasks routes, everything is under a project so a Script
 * is always scoped to the folder it owns. The one thing that differs is running:
 * starting a run never waits for the command — it hands back an id at once —
 * and the page follows the command over a stream of server-sent events, so the
 * server is blocked by nothing.
 */
export function scriptsRouter(): Router {
  const router = express.Router();
  const root = workspaceRoot();

  // Resolve the owning project folder, reporting a missing/invalid project as
  // 404 the way the rest of the project routes do.
  const projectPath = (name: string): string => getProject(root, name).path;

  const fail = (res: express.Response, e: unknown) => {
    if (e instanceof ProjectError) return res.status(e.code === "exists" ? 409 : 404).json({ error: e.message });
    if (e instanceof ScriptError) return res.status(e.code === "missing" ? 404 : 400).json({ error: e.message });
    return res.status(500).json({ error: String(e) });
  };

  const expose = (row: ScriptRow): ScriptRow => ({ ...row });

  // List a project's Scripts in creation order.
  router.get("/projects/:name/scripts", (req, res) => {
    try {
      res.json(scripts.listScripts(projectPath(req.params.name)));
    } catch (e) {
      fail(res, e);
    }
  });

  // Create a script in a project: just its name and its command.
  router.post("/projects/:name/scripts", (req, res) => {
    const body = req.body ?? {};
    try {
      res.status(201).json(expose(createScript({
        workspace: projectPath(req.params.name),
        name: typeof body.name === "string" ? body.name : "",
        command: typeof body.command === "string" ? body.command : "",
      })));
    } catch (e) {
      fail(res, e);
    }
  });

  // Delete a script. A run already started keeps going until it ends on its own.
  router.delete("/projects/:name/scripts/:id", (req, res) => {
    try {
      scripts.deleteScript(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Start a run of one script: spawn it, return at once with an id. The command
  // runs in the project folder, detached, unblocking this request immediately.
  router.post("/projects/:name/scripts/:id/run", (req, res) => {
    let script: ScriptRow;
    try {
      script = scripts.getScript(req.params.id);
    } catch (e) {
      return fail(res, e);
    }
    if (script.workspace !== projectPath(req.params.name)) {
      return res.status(404).json({ error: "no such script for this project" });
    }
    try {
      const runId = startRun({ cwd: script.workspace, description: script.name, command: script.command });
      res.json({ ok: true, runId });
    } catch (e) {
      fail(res, e);
    }
  });

  // Stop a running script: kill the process and whatever it started.
  router.post("/projects/:name/scripts/:id/run/:runId/stop", (req, res) => {
    const stopped = stopRun(req.params.runId);
    res.json({ ok: true, stopped });
  });

  // Stream one run's output. The buffered output so far is sent first so a late
  // connect still shows what happened before it attached, then live output as it
  // arrives, then an end event carrying the exit code.
  router.get("/projects/:name/scripts/:id/run/:runId/stream", (req, res) => {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "no such run" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (event: string, data: string): void => { res.write(`event: ${event}\ndata: ${data}\n\n`); };
    const send = (payload: unknown): void => { write("message", JSON.stringify(payload)); };

    // What has happened so far, replayed whole, then the live tail.
    send({ type: "buffer", data: run.text });
    if (run.status === "exited") {
      send({ type: "end", code: run.exitCode });
    }

    const unsubscribe = subscribeRun(req.params.runId, (data, ended, exitCode) => {
      if (data.length) send({ type: "chunk", data });
      if (ended) send({ type: "end", code: exitCode });
    });

    // A comment every so often: the connection stays open without anything to say.
    const keepalive = setInterval(() => res.write(": alive\n\n"), 15_000);
    keepalive.unref();

    const end = (): void => {
      clearInterval(keepalive);
      unsubscribe();
    };
    res.on("close", end);
  });

  return router;
}
