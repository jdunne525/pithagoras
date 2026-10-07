import { spawn, type ChildProcess } from "node:child_process";

/**
 * Running a Script: one fresh OS process per run, started so it never blocks
 * the server, and streamed back to whoever asked for it.
 *
 * A route handler starts a run and returns at once with an id; the command
 * keeps going on its own, writing to this module's buffers. The page streams
 * those buffers over SSE, so the server was never blocked and the output comes
 * back live. Each run owns exactly one process here; stopping kills it (and, on
 * Unix, the whole process group it leads).
 */

export interface RunOptions {
  /** Absolute path the command runs in — the project folder. */
  cwd: string;
  /** What the page shows while running: the script's name. */
  description: string;
  /** The full command line, run through the platform shell. */
  command: string;
}

interface Listener {
  /** Called with each stretch of output, and once more with `ended` set. */
  (chunk: string, ended: boolean, exitCode: number | null): void;
}

interface Run {
  id: string;
  description: string;
  child?: ChildProcess;
  /** Kept so a run can be stopped after the handler has returned. */
  status: "running" | "exited";
  exitCode: number | null;
  buffer: Buffer;
  listeners: Set<Listener>;
}

const MAX_BUFFER = 2_000_000; // Keep at most ~2 MB of output per run.

const runs = new Map<string, Run>();
let counter = 0;

const shellFor = (): { exe: string; args: string[] } => {
  if (process.platform === "win32") return { exe: "cmd.exe", args: ["/c"] };
  return { exe: "/bin/sh", args: ["-c"] };
};

/** Start a run without waiting for it: returns the id immediately. */
export function startRun(options: RunOptions): string {
  const id = `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const run: Run = { id, description: options.description, status: "running", exitCode: null, buffer: Buffer.alloc(0), listeners: new Set() };
  runs.set(id, run);

  const shell = shellFor();
  let child: ChildProcess;
  try {
    // Detached makes the child lead its own process group, so stopping it
    // reaches everything it started. Its stdin goes nowhere — a Script never
    // needs input — which is what detaching costs.
    child = spawn(shell.exe, [...shell.args, options.command], {
      cwd: options.cwd,
      env: process.env,
      detached: true,
      windowsVerbatimArguments: false,
    });
  } catch (e) {
    // Spawn can fail before any process exists (e.g. the shell itself is
    // missing). Report it as finished, then rethrow so the route can 500.
    run.status = "exited";
    run.exitCode = -1;
    emit(run, String(e), true, -1);
    throw e;
  }
  run.child = child;

  const onData = (buf: Buffer): void => {
    if (run.buffer.length + buf.length > MAX_BUFFER) {
      const keep = run.buffer.slice(Math.max(0, run.buffer.length - MAX_BUFFER + buf.length));
      run.buffer = Buffer.concat([keep, buf]);
    } else {
      run.buffer = Buffer.concat([run.buffer, buf]);
    }
    emit(run, buf.toString("utf8"), false, run.exitCode);
  };
  const onClose = (code: number | null): void => {
    if (run.status === "exited") return; // already reported
    run.status = "exited";
    run.exitCode = code;
    emit(run, "", true, code ?? 0);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", (buf: Buffer) =>
    run.status === "running" ? emit(run, buf.toString("utf8"), false, run.exitCode) : undefined,
  );
  child.on("close", onClose);
  child.on("error", (err) => {
    // The process could not start at all (e.g. no such command). Report it as
    // finished with the error as its output, rather than leaving the run hanging.
    if (run.status === "running") {
      run.status = "exited";
      run.exitCode = -1;
      emit(run, String(err), true, run.exitCode);
    }
  });

  return id;
}

/** Everything run `id` has produced so far, plus how it stands now. */
export function getRun(id: string): { description: string; status: "running" | "exited"; exitCode: number | null; text: string } | undefined {
  const run = runs.get(id);
  if (!run) return undefined;
  return { description: run.description, status: run.status, exitCode: run.exitCode, text: run.buffer.toString("utf8") };
}

/** Listen to a run's later output. Returns an unsubscribe. */
export function subscribeRun(id: string, listener: Listener): () => void {
  const run = runs.get(id);
  if (!run) return () => undefined;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

function emit(run: Run, data: string, ended: boolean, exitCode: number | null): void {
  for (const l of [...run.listeners]) l(data, ended, exitCode);
}

/** Stop a run: kill the process and, on Unix, whatever it started too. */
export function stopRun(id: string): boolean {
  const run = runs.get(id);
  const child = run?.child;
  if (!run || !child || run.status !== "running") return false;
  if (process.platform === "win32") {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  } else {
    // Negative pid targets the whole group the run leads.
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return true;
}

/** Every run that has finished keeps its output in memory so a late connect can
 *  still replay it. They are not unbounded: once a run has exited and its output
 *  is small (a Script's result), it is dropped. Long-running or very noisy runs
 *  stay until the server restarts, which is right for what a Scripts page needs.
 *  Called occasionally rather than on every finish, so finishing does no work. */
export function forgetFinished(): void {
  for (const [id, run] of runs) {
    if (run.status === "exited" && run.buffer.length < 4_000) runs.delete(id);
  }
}

// A quiet nudge so finished runs do not pile up forever.
setInterval(forgetFinished, 60_000).unref();
