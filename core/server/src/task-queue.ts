import { getSetting, putSetting, listTasksByWorkspace, settingValuesWithPrefix } from "./db.js";
import { startTask, hasLiveTaskRun } from "./task-execution.js";
import * as tasks from "./tasks.js";

/**
 * Project-level queue loop (Phase 4).
 *
 * A loop drives one project's Tasks through the durable queue: it polls for the
 * next work item, launches it through the shared execution module, and advances
 * when it settles. Across all projects only one agent runs at a time. The loop
 * processes Tasks strictly in queue order and cannot bypass a failed one — it
 * stalls on it until the user intervenes.
 *
 * Minimal per-project state (running flag + current task) is persisted so a
 * restart could later recover an interrupted loop. Recovery itself is Phase 8;
 * this only stores what it requires.
 */

const LOOP_KEY_PREFIX = "taskLoop:";
/** How often an idle loop checks for the next item to run. */
const POLL_INTERVAL_MS = 2000;

interface LoopState {
  running: boolean;
  currentTask: string | null;
}

/** A live loop's timer plus its running flag, kept in memory while running. */
interface LoopHolder {
  running: boolean;
  timer?: NodeJS.Timeout;
}

const loops = new Map<string, LoopHolder>();

// --- persistence -----------------------------------------------------------

function keyFor(workspace: string): string {
  return `${LOOP_KEY_PREFIX}${workspace}`;
}

/** Every Project whose loop was persisted as running, for restart recovery.
 *  A live loop keeps only a flag in memory (the `loops` map), so after a crash
 *  the only record is what `saveLoopState` wrote. Scanning those restores the
 *  list of Projects a loop could resume. */
export function activeLoopWorkspaces(): string[] {
  const values = settingValuesWithPrefix(LOOP_KEY_PREFIX);
  const out: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    try {
      if ((JSON.parse(raw) as LoopState).running) {
        out.push(key.slice(LOOP_KEY_PREFIX.length));
      }
    } catch {
      /* corrupt value — ignore */
    }
  }
  return out;
}

/** Clear a Project's persisted loop flag without touching any Task (recovery
 *  has no live loop to abort, unlike stopLoop). Used on restart so a stale
 *  "running" flag from a crashed loop does not linger in the settings table. */
export function clearPersistedLoop(workspace: string): void {
  saveLoopState(workspace, { running: false, currentTask: null });
}

function loadLoopState(workspace: string): LoopState {
  try {
    const raw = getSetting(keyFor(workspace));
    if (raw) return JSON.parse(raw) as LoopState;
  } catch {
    /* corrupt value — treat as not running */
  }
  return { running: false, currentTask: null };
}

function saveLoopState(workspace: string, state: LoopState): void {
  putSetting(keyFor(workspace), JSON.stringify(state));
}

// --- lifecycle -------------------------------------------------------------

/** Whether the loop for a project is currently running. */
export function isLoopRunning(workspace: string): boolean {
  return loops.get(workspace)?.running ?? false;
}

/** Start the queue loop for a project if it is not already running. */
export function startLoop(workspace: string): void {
  const existing = loops.get(workspace);
  if (existing?.running) return; // Already running.

  const state = loadLoopState(workspace);
  const holder: LoopHolder = { running: true };
  loops.set(workspace, holder);
  saveLoopState(workspace, { running: true, currentTask: state.currentTask });
  poll(workspace, holder);
}

/**
 * Stop the queue loop for a project: clear the timer and drop the in-memory
 * loop so no further items are queued. Unlike an individual task stop, this
 * leaves any attempt this loop already launched running to completion —
 * stopping the queue must not interrupt work that is already in flight.
 * Persisting not-running means a restart will not resume the loop on its own.
 */
export function stopLoop(workspace: string): void {
  const holder = loops.get(workspace);
  if (holder) {
    loops.delete(workspace);
    if (holder.timer) clearTimeout(holder.timer);
  }

  saveLoopState(workspace, { running: false, currentTask: null });
}

// --- polling ---------------------------------------------------------------

/**
 * The next item to run for a project, or undefined to stall.
 *
 * Returns the first pending Task in queue order. If a failed or stopped Task
 * comes before any pending one, returns undefined: a failed Task cannot be
 * bypassed, so the loop stalls on it rather than skipping ahead.
 */
function nextWorkItem(workspace: string): ReturnType<typeof listTasksByWorkspace>[number] | undefined {
  for (const t of listTasksByWorkspace(workspace)) {
    if (t.status === "pending") return t;
    if (t.status === "failed" || t.status === "stopped") return undefined;
  }
  return undefined;
}

function poll(workspace: string, holder: LoopHolder): void {
  holder.timer = setTimeout(() => {
    if (!loops.get(workspace)) return; // Stopped meanwhile.

    // One agent at a time across every project: wait while any attempt anywhere
    // is still live, so two loops never share the single agent slot.
    if (hasLiveTaskRun()) {
      poll(workspace, holder);
      return;
    }

    const next = nextWorkItem(workspace);
    if (!next) {
      poll(workspace, holder);
      return;
    }

    saveLoopState(workspace, { running: true, currentTask: next.id });
    // startTask settles a failed launch itself (the attempt ends as failed,
    // stalling the loop on it), so only a synchronous throw needs handling here.
    try {
      startTask(next.id);
    } catch (e: unknown) {
      console.error(`[portal] queue loop ${workspace} failed to start task ${next.id}:`, e);
    }
    poll(workspace, holder);
  }, POLL_INTERVAL_MS);
}
