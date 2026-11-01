import { randomUUID } from "node:crypto";
import * as db from "./db.js";

/**
 * Scripts: a named command-line command owned by one Project, run on demand
 * from the Scripts page. Unlike Tasks they do not run autonomously — starting
 * one is always a click — so the only rules here are that a script has a name
 * and a command. Where it runs (the project folder) and how it runs (a fresh,
 * non-blocking process) live behind the routes, in script-runs.
 *
 * Like tasks.ts, this is the only place the rule about what a valid script is.
 * Route handlers stay thin: parse a request, call one function below.
 */

export class ScriptError extends Error {
  constructor(
    readonly code: "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

const validateName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) {
    throw new ScriptError("invalid", "a name is required");
  }
  return name.trim();
};

const validateCommand = (command: unknown): string => {
  if (typeof command !== "string" || !command.trim()) {
    throw new ScriptError("invalid", "a command is required");
  }
  return command.trim();
};

export const listScripts = (workspace: string): db.ScriptRow[] =>
  db.listScriptsByWorkspace(workspace);

export const getScript = (id: string): db.ScriptRow => {
  const script = db.getScript(id);
  if (!script) throw new ScriptError("missing", `There is no script "${id}"`);
  return script;
};

export const createScript = (input: { workspace: string; name: string; command: string }): db.ScriptRow => {
  if (typeof input.workspace !== "string" || !input.workspace.trim()) {
    throw new ScriptError("invalid", "workspace is required");
  }
  return db.createScript({
    id: randomUUID(),
    workspace: input.workspace,
    name: validateName(input.name),
    command: validateCommand(input.command),
  });
};

export const deleteScript = (id: string): void => {
  getScript(id); // exists? report missing rather than deleting nothing.
  db.deleteScript(id);
};
