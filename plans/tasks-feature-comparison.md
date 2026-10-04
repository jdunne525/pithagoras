# Tasks Feature Comparison: Pithagoras vs. Codeloop

**Purpose:** Compare how the *tasks* feature works in this project (**Pithagoras**, `G:\work\git\pithagoras`) against the reference **Codeloop** project (`G:\work\git\pi-ralph-one`). The focus is on *how the user experiences it* — the workflow, interactions, queue behaviour, and state handling — rather than the exact frontend markup.

Both projects share the same conceptual origin: a **Task** is a named unit of autonomous development work driven by the Pi coding agent. Every prompt carries an identical framing ("You are … helping execute task development", a "Review & Commit" instruction, and a completion-promise protocol). This report documents where the two implementations diverge in behaviour.

---

## 1. The core mental model (shared)

In both apps a Task is a durable unit of work owned by one project/folder. The user:

1. Adds tasks to a project's queue (title + description / intent).
2. Optionally orders them.
3. Runs one task (or the whole queue) autonomously.
4. Watches the agent work, live, in a chat-like transcript.
5. Sees the task settle into `completed`, `failed`, or `stopped`.
6. Re-runs, re-orders, edits, or deletes tasks.
7. Reviews history across multiple attempts.

Everything below is layered on top of that shared skeleton.

---

## 2. Persistence & data model

| Aspect | Codeloop | Pithagoras |
|---|---|---|
| Storage | Plain JSON files under `data/projects/<name>/` — `tasks.json`, `state.json`, `prompts.json`, `plan.md`, `progress.md`, `prompts.md` | A single **SQLite database** with `tasks` and `task_attempts` tables (plus sessions); timestamps as UTC strings |
| Attempt identity | One `.jsonl` session file per attempt under `sessions/<taskId>/` | One `task_attempts` row per run; each points at a normal **session** row (`session_id`) |
| Identity scheme | Integer `id` (max+1), monotonic per project | UUID `id`; `attempt_number` per task |
| Project instructions | `prompts.json` = `{ simple, full }` (two independent fields) + separate `project.json.workflow` | A single per-folder file **`PITHAGORAS_TASKS.md`** |

**User-facing consequence:** In Codeloop the queue order is a plain array in a file; completed tasks are preserved outside a reorder operation. In Pithagoras order is an explicit `position` column in SQL, and reordering is validated against real rows belonging to the project.

---

## 3. Workflow types — the biggest behavioural split

This is the most significant functional difference between the two products.

### Codeloop: two workflow modes
When creating a task the user chooses a workflow:
- **`simple`** — one Pi run that does the whole task, then emits the completion promise.
- **`full`** — a **multi-stage pipeline**. Each task runs through ordered stages:
  `requirements → plan → review-plan → implement → review → unittests → [integtests]`.
  Each stage is its own Pi run in its own isolated session directory (`sessions/<taskId>-<stage>/`), with a bespoke prompt. Stages must all pass (with internal retries) before the workflow commits work and marks the task complete. There is a final `git commit` step only at the very end of a full workflow.

### Pithagoras: single workflow
There is **no multi-stage / full-workflow mode**. Every autonomous task is a single Pi run executed through the ordinary **SessionManager** (the same path a normal chat uses). There is no planning stage, no `plan.md`/`progress.md` separation for tasks, and no staged commit. Project instructions (`PITHAGORAS_TASKS.md`) are appended as one block to every run's prompt instead.

**User-facing consequence:** Codeloop gives users a heavier, more deliberate "plan then build then test" automation for complex tasks, and shows results as a committed multi-stage effort. Pithagoras keeps everything lightweight and uniform — a task is simply "get it done until the completion marker appears."

---

## 4. How a task actually runs (execution engine)

| Aspect | Codeloop | Pithagoras |
|---|---|---|
| Spawns Pi via | `child_process.spawn('cmd', ['/c','pi','-p','@<promptFile>', ...])` directly | Through the existing **SessionManager** (`sessions.prompt(sessionId, ...)`) — a normal session |
| Session per attempt | Fresh `--session-id` + isolated per-task dir (`sessions/<taskId>/`) | Fresh Pithagoras **session** created via `db.createSession(...)` with a `nanoid` id, `kind:"task"` |
| Prompt delivery | Written to a temp file, passed with `@path` (avoids `cmd /c` shell issues) | Passed in-process to SessionManager |
| Model/provider pinning | Explicit `--provider`/`--model` CLI flags from settings | Threaded through SessionManager (not in the prompt builder) |
| Live monitoring | Polls the raw `.jsonl` session file every 15 s (`pollSession`), parsing messages/tool calls into an in-memory activity buffer | Uses **live SSE events** (`portal_status` transitions + `message_end`) via SessionManager, with a fallback that reads the persisted session status every 2 s |
| Stopping a run | Kills the process tree with `taskkill /PID <pid> /T /F` (+ orphan PID registry) | Calls `sessions.abort(sessionId)` through SessionManager |

**User-facing consequence:** Both give a live, streaming view of what the agent is doing. Codeloop reads the transcript off disk (so its "activity" buffer is an in-memory snapshot cleared on exit); Pithagoras streams events directly from the session, so the same session store the user reads as "working" is also what settles the run. The two implementations differ mainly in *how* they detect the run's end — file polling vs. event subscription with a persistence-backed fallback.

---

## 5. Queue processing — how work advances

Both apps serialize to **one agent running at a time across every project**, but they enforce and advance that differently, and — importantly — they behave very differently when a task fails.

### Codeloop
- A single global poll loop (`poll`, 2 s cadence).
- Next work item = **first task with `status === 'pending'`** (`getNextPendingTask`).
- It **does not care about failed/stopped tasks sitting earlier in the queue**: if a failed task sits ahead of a pending one, the loop skips past it and runs the pending task. Failures are effectively bypassable.

### Pithagoras
- **One queue loop per project** (`task-queue.ts`), each a small timer-based loop.
- Next work item = first pending task **in queue order — but the loop *stalls* if a failed or stopped task comes first** (`nextWorkItem`). A failed task **cannot be bypassed**; the queue waits on it until the user intervenes (Rerun / Mark complete / Run again).

**User-facing consequence (important):**
- In Codeloop the queue is "run whatever's next that isn't stuck-failed" — progress continues past failures automatically.
- In Pithagoras the queue is stricter and safer: it will **hold** on a failure rather than silently skip ahead. This means a single broken task blocks the rest of that project's queue until the user decides what to do. Other projects still make progress (their loops continue), but within one project you must resolve the blocker.

Both stop their loop when idle and keep a persisted `{ running, currentTask }` flag so state survives a restart.

---

## 6. State machine & lifecycle

Shared statuses: `pending → running → completed | failed | stopped`.

| Transition | Codeloop | Pithagoras |
|---|---|---|
| Enter `running` | `markRunning` when Pi launches | `startAttempt`: opens a new `task_attempts` row, bumps `attempts`, marks task + attempt running, creates the session |
| Manual "finished by hand" | `markCompleted` from any state | `completeTask` from any state (distinct endpoint `/complete`) |
| Rerun | `resetTask` → back to `pending` (also used to resume) | `rerunTask` → back to `pending` **without starting**; explicitly refuses if the task is currently `running` |
| Timestamps | set inline at each transition | centralized in `setTaskStatus` (`started_at` once, `completed_at` on terminal, cleared on return to pending) |

### Retries & the attempt budget
- **Codeloop:** Simple workflow re-enqueues the failed task (`status:'pending'`) and picks it up within 2 s; each retry spawns a fresh Pi/session. Full workflow retries a stage internally, then **restarts the entire workflow from stage 1**. `task.attempts` counts failed runs (simple) or workflow restarts (full). Default **maxIterations = 5**.
- **Pithagoras:** A natural end that didn't complete settles the *attempt* as `failed` and sets the *task* back to `pending`; the queue loop then starts a brand-new attempt with a fresh session. The budget is a **single server-wide default (`DEFAULT_MAX_ATTEMPTS = 5`)**, **not** a per-task value — every task reports the same `max_attempts` (e.g. `3/5`). No per-task cap exists.

**User-facing consequence:** Codeloop surfaces attempts as a per-task counter tied to that task's own iterations. Pithagoras surfaces attempts against a shared global ceiling shown identically on every task ("attempts N/max"). Near-exhaustion shows a "No attempts left" warning in both.

### Completion detection (shared protocol, slightly different framing)
Both require the agent to emit `<PROMISE>THIS TASK IS DONE</PROMISE>` standing alone on its own line, and both reject an inline mention (e.g. a model refusing to emit it). They wait for the transcript to flush before the definitive check (avoiding a flush race).

Divergence in *framing*: Codeloop asks for the string plainly; Pithagoras presents it **inside a fenced code block and tells the model the `<PROMISE>` tags are literal text**, because models tend to drop angle-bracket tags as HTML. Both do strict standalone-line matching.

---

## 7. Stopping, failure & recovery

| Aspect | Codeloop | Pithagoras |
|---|---|---|
| Stop mechanism | `stopLoop`: adds project to `stoppingProjects`, kills process tree, marks current task `stopped`, clears loop | `stopTask`: settles current attempt as `stopped`, aborts session via SessionManager, sets task `stopped` |
| Stop vs. completion ordering | A genuine completion **always wins over a stop** even if the stop kill raced in mid-finalize | A stop is recorded immediately (settles the run first); a natural end after stop is guarded by `run.ended` so it can't double-count |
| Notification on events | **ntfy push notifications** for started/completed/failed/stopped, with a ~4 KB snippet of the session's "white text" output | **None** — no push notifications for task events |
| Restart recovery | On boot: kill orphaned Pi processes, `recoverStaleTasks()` flips lingering `running` tasks back to `pending` | On boot: `reconcileInterruptedTasks()` flips `running` tasks to `pending` and records the aborted attempt as `failed`; **queue-loop auto-resume defaults OFF** (opt-in setting) |

**User-facing consequence:** Codeloop proactively pphones you when a task starts/fin/fails/stops, including a short excerpt of what the agent produced. Pithagoras keeps all of this inside the app UI — you learn outcomes by opening the project. Both ensure nothing is left permanently "running" after a crash; Pithagoras additionally makes loop auto-resume an explicit operator choice rather than automatic.

---

## 8. User interactions & UI flow

### Codeloop
- One browser tab per project. Sub-tabs: **Tasks** (active queue, `status !== 'completed'`), **Completed** (`status === 'completed'`), plus Plan / Progress / Settings.
- Create task modal asks for description + a **simple/full workflow radio**.
- Per-task status icon (`▶/✓/✗/⏸`), a `↻ n/max` attempt badge, and per-row controls.
- **Session Viewer modal**: lists per-attempt `.jsonl` files newest-first, with **Activity** (parsed messages/tools) and **Raw JSONL** views, plus a ▶ **Resume** button that reopens the latest session interactively.
- Manual "interactive" sessions (`resume-session`) are a separate concern from task execution.
- Workflow change while running is rejected (HTTP 409).

### Pithagoras
- A dedicated **Tasks workspace** (`TaskWorkspace.tsx`) under a project, with two tabs: **Pending** (not completed) and **Completed**, each showing counts.
- Create via an inline "New task" composer (no modal, no workflow choice).
- Each task row is **drag-to-reorder** (mouse + touch grip), **rename** inline, delete (with confirm), with Run / Stop / Re-run / Mark-completed / View-session / Rename / Delete actions surfaced on hover.
- A project-level **Start/Stop queue** toggle (the autonomous loop) sits in the header alongside the New task button.
- Selecting a task opens its **live streamed transcript** in a bottom panel (`TaskTranscript`), rendered from the real session events.
- A **"Continue this session"** resume composer appears while a task runs, letting the user send follow-up messages into the live session without starting a new attempt.
- **"View session"** on a completed task replays its history (mocked locally pre-execution-phase, backed by the real session once available).
- Manual **Run** bypasses the queue and resets a failed/stopped/completed task to start a fresh attempt; **Re-run** only resets to pending (for later reordering); **Mark completed** finishes a task by hand from any state.

**User-facing consequence:** Codeloop's UI reads like an ops console (session viewer, raw JSONL, plan/progress files, push alerts), suited to its heavier full-workflow model. Pithagoras reads like a modern chat/task app — inline editing, drag reorder, a streaming conversation, and a resume composer — suited to its lighter single-run model. Both expose the same three manual outcomes (Run, Rerun, Mark complete) but wire them slightly differently (e.g. Codeloop's "rerun/resume" also re-launches; Pithagoras cleanly separates *reset-only* Rerun from *start-now* Run).

---

## 9. Summary of key differences

1. **Workflow depth.** Codeloop has `simple` and multi-stage `full` workflows; Pithagoras has one uniform single-run workflow.
2. **Queue failure handling.** Codeloop skips past failed tasks to the next pending one; Pithagoras **stalls** on a failed/stopped task until the user intervenes.
3. **Attempt budget scope.** Codeloop uses a per-config `maxIterations` applied to each task's own attempts; Pithagoras uses a **single server-wide `DEFAULT_MAX_ATTEMPTS`** shown identically on every task.
4. **Persistence.** Codeloop = JSON files + markdown (`plan.md`/`progress.md`); Pithagoras = SQLite with a proper `task_attempts` table and no per-task plan/progress files.
5. **Notifications.** Codeloop sends ntfy push alerts on task events with output snippets; Pithagoras sends none.
6. **Execution path.** Codeloop spawns Pi directly as a child process (killed on stop); Pithagoras runs tasks through the shared SessionManager and aborts via it.
7. **Live detection.** Codeloop polls raw session `.jsonl` files; Pithagoras streams SSE events with a persisted-status fallback.
8. **Instructions.** Codeloop splits per-project instructions into `{ simple, full }` plus a separate project workflow; Pithagoras uses a single `PITHAGORAS_TASKS.md`.
9. **Restart resume.** Codeloop recovers stale tasks and kills orphans at boot; Pithagoras does too but keeps **auto-resume of queued loops off by default** (opt-in).
10. **Completion framing.** Both use the same promise protocol; Pithagoras additionally wraps it in a fenced code block and marks the tags as literal text to keep models from stripping them.
11. **UI paradigm.** Codeloop = ops-console sub-tabs + session-viewer modal + raw JSONL; Pithagoras = inline-editable streaming task board with drag-reorder, a resume composer, and "mark complete from any state."

Despite these differences, the *user journey* is the same in spirit: queue tasks, drive them autonomously, watch them work, resolve failures, and review what happened — the two products simply trade heaviness/notifications/serialization-freedom (Codeloop) against uniformity/a clean chat-like board/stricter within-project queue discipline (Pithagoras).
