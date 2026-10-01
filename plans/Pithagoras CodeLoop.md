# Pithagoras Projects + Autonomous Tasks

Implement the first version of a Project/Task workflow in Pithagoras.

The existing Pithagoras architecture has already been investigated. Use the source code as authoritative, particularly:

* `server/src/projects.ts`
* `server/src/workspaces.ts`
* `server/src/db.ts`
* `server/src/session-manager.ts`
* `server/src/server.ts`
* `server/src/executors/index.ts`
* `server/src/pi/*`
* `server/src/background.ts`
* `web/src/App.tsx`
* `web/src/components/Sidebar.tsx`
* `web/src/components/ProjectsPage.tsx`
* `web/src/components/FolderTree.tsx`
* `web/src/api.ts`
* routine-related server/web code

Do not replace the existing filesystem/workspace model.

Do not create a second unrelated Project concept.

The existing Pithagoras Project is already a filesystem folder under the workspace root with an `AGENTS.md`. Extend that concept so that a Project can additionally own Tasks and project-specific settings.

---

# CodeLoop as the Behavioral Reference

The CodeLoop repository is available to the agent and should be treated as the authoritative reference implementation for the autonomous task/project behavior being added to Pithagoras.
Before implementing each major subsystem, inspect the corresponding CodeLoop implementation in src/ to verify details rather than relying solely on the investigation summary. In particular, use CodeLoop to verify:
task state transitions and retry semantics
task/project persistence
task queue ordering and selection
process/attempt lifecycle
completion-promise detection
stop vs. failure behavior
stale-task recovery after restart
fresh-session behavior for retries
project instructions and prompt construction
task/session history
plan/progress handling
UI behavior where applicable
Do not port CodeLoop's implementation architecture directly. Reimplement the behavior using Pithagoras primitives. For example, CodeLoop's Pi process management should map onto Pithagoras's SessionManager and executor abstraction, CodeLoop's JSON persistence should map onto Pithagoras's SQLite persistence, and CodeLoop's session/activity handling should map onto Pithagoras's existing durable event/session infrastructure.
When the CodeLoop behavior and the existing Pithagoras architecture appear to conflict, first inspect both implementations and preserve the intended CodeLoop behavior while following Pithagoras's architectural conventions. Document any intentional behavioral difference in the implementation notes/tests.

codeloop source can be found here if needed:
G:\work\git\pi-ralph-one

# 1. Target conceptual model

The resulting application should conceptually look like:

```text
Home
│
├── Projects
│   ├── Project A
│   │   ├── Chats
│   │   ├── Tasks
│   │   ├── Settings
│   │   └── Files
│   │
│   └── Project B
│       ├── Chats
│       ├── Tasks
│       ├── Settings
│       └── Files
│
└── existing filesystem/workspace experience
```

The filesystem remains the actual workspace.

A Project references the existing folder/path rather than copying or replacing it.

Existing chats continue to work as chats.

Tasks are a separate persistent concept.

---

# 2. Preserve existing behavior first

Do not break or redesign:

* Home
* filesystem/workspace navigation
* existing folder/project discovery
* existing chats
* chat session persistence
* Pi execution
* host/container executors
* SSE event streaming
* session history
* session resume
* existing routines

The new functionality should sit on top of these systems wherever practical.

Before making changes, understand the current Project UI and API sufficiently to preserve compatibility.

---

# 3. Project model

Extend the existing folder-based Project concept rather than creating a parallel Project entity.

A Project should continue to be identified by its existing filesystem folder/path.

It should additionally provide:

* project metadata required for Tasks
* Tasks belonging to that project
* project-specific Task instructions/settings

Do not move project files or create a duplicate workspace.

Existing `AGENTS.md` behavior should remain unchanged.

### Important distinction

There are three related but distinct concepts:

```text
Filesystem folder
      │
      └── Project
            ├── Chats
            ├── Tasks
            └── Settings
```

The folder is the actual working directory.

The Project is application-level metadata associated with that folder.

A Chat remains a Pithagoras chat/session.

A Task is a persistent unit of autonomous work.

---

# 4. Task model

Introduce a persistent Task entity associated with exactly one Project.

At minimum a Task needs:

* unique ID
* project association
* title
* description
* status
* attempt count
* created timestamp
* started timestamp
* completed timestamp

Use statuses conceptually equivalent to:

```text
pending
running
completed
failed
stopped
```

These are the user-visible lifecycle states.

Do not over-engineer the state machine in the first implementation.

The Task should not simply be another Chat record.

A Task may use Pithagoras sessions internally to execute work, but the Task is the durable owner of the work.

---

# 5. Task execution architecture

Build Task execution around the existing Pithagoras agent infrastructure.

Do NOT create a second Pi launcher.

Reuse:

* `SessionManager`
* `PiClient`
* existing executors
* existing session creation
* existing Pi session files
* existing event persistence
* existing SSE streaming
* existing abort behavior

A Task execution should create/use an appropriate Pithagoras agent session for the attempt.

The important relationship should be:

```text
Task
  │
  └── Attempt
        │
        └── Pithagoras agent session
                 │
                 └── Pi execution
```

The Task owns the lifecycle.

The session owns the conversation/execution history.

This allows the existing Pithagoras session infrastructure to continue doing what it already does well.

---

# 6. Attempts and session history

A Task must be capable of being executed more than once.

Each attempt should have its own agent execution/session rather than simply continuing the previous failed attempt.

The exact persistence representation should follow the existing SQLite architecture rather than introducing JSON files or another persistence system.

Prefer a small relational model that allows:

```text
Task
 ├── Attempt 1 → Session
 ├── Attempt 2 → Session
 └── Attempt 3 → Session
```

The existing session/event infrastructure should remain responsible for the actual conversation history.

Do not duplicate Pi transcripts into the Task database.

The Task model should reference the execution/session records it owns.

The UI should eventually be able to show that a Task has multiple attempts and allow the user to inspect their execution history.

---

# 7. Task lifecycle

Implement the basic lifecycle:

```text
pending
   ↓
running
   ↓
completed

running → stopped
running → failed

failed  → pending   (rerun)
stopped → pending   (resume/rerun)
```

A Task should remain persistent when execution stops or fails.

Do not delete or replace the Task when it is rerun.

Increment its attempt count and create a new execution/session.

The exact retry/completion mechanism should be implemented separately from the Task persistence model so it can evolve.

---

# 8. Autonomous execution loop

The Task runner should be server-owned rather than browser-owned.

Starting a Task from the UI should cause the server to take responsibility for its execution.

The browser should only observe the Task and its associated session.

This is consistent with Pithagoras's existing architecture:

```text
Browser
   ↓
Task API
   ↓
Server-side Task runner
   ↓
SessionManager
   ↓
Pi
   ↓
durable events
   ↓
SSE
   ↓
Browser
```

Do not make the browser responsible for repeatedly submitting prompts.

---

# 9. Completion detection

Implement the first version of Task completion using an explicit completion protocol.

The agent should be instructed that when it believes the requested Task is fully complete, it must emit a specific completion marker.

Use a dedicated, unambiguous marker rather than attempting to infer completion from:

* process exit code
* the final natural-language response
* whether tools stopped being used
* whether the agent says "done"

The server should inspect the resulting agent execution/session for the marker.

Only a valid completion marker should transition the Task to `completed`.

If the agent finishes without the marker, treat that execution as incomplete.

The completion protocol should be isolated in its own implementation so the exact prompt/marker can be changed later without restructuring Task execution.

---

# 10. Retry behavior

Initially support a configurable maximum number of attempts.

Conceptually:

```text
Task starts
   ↓
Agent attempt
   ↓
completion marker?
   ├── yes → completed
   └── no
        ↓
   attempts remaining?
        ├── yes → new attempt
        └── no → failed
```

Every new attempt should use a fresh agent session/context.

Do not resume the previous failed conversation automatically.

The previous attempt remains available as history.

Do not implement complicated multi-stage workflows yet.

Start with a single Task execution workflow.

---

# 11. Stop behavior

A user must be able to stop a running Task.

Stopping a Task should:

1. request termination of the active agent execution using existing `SessionManager.abort()`/execution mechanisms;
2. distinguish intentional stopping from ordinary failure;
3. persist the Task as `stopped`;
4. retain the attempt/session history.

Do not destroy the Task or its session.

A stopped Task should be able to be run again.

Reuse existing Pithagoras process/session cleanup rather than creating another process-management mechanism.

---

# 12. Restart/recovery

Tasks must not be left permanently `running` if the server restarts or crashes.

Use the existing Pithagoras orphan/recovery architecture where possible.

At startup, inspect persisted Task state and reconcile Tasks whose execution was interrupted.

The first implementation should favor correctness and recoverability over attempting to magically continue an interrupted Pi process.

A reasonable initial behavior is:

```text
running Task at server shutdown
        ↓
execution/session becomes interrupted
        ↓
Task becomes pending or stopped according to the chosen recovery semantics
        ↓
user/server can run it again
```

Do not leave a Task permanently marked `running` when no execution exists.

---

# 13. Project-specific Task instructions

Add a Project-level setting for additional instructions that apply specifically to Tasks.

For example:

```text
Always restart the development server using ./xyz.ps1 after completing a task.
```

Do not alter the semantics of `AGENTS.md`.

`AGENTS.md` remains the normal filesystem/project instruction mechanism.

The new setting is specifically additional instructions for autonomous Task execution.

The Task runner should incorporate the Project's Task instructions into the Task prompt.

Keep this mechanism separate from the existing `AGENTS.md` file.

---

# 14. Project UI

Extend the existing Project UI rather than replacing it.

A Project should provide access to:

```text
Project
├── Chats
├── Tasks
├── Settings
└── Files
```

The exact visual design should follow existing Pithagoras components and styling.

Do not build an entirely new application shell.

The existing filesystem/folder browsing experience must remain available.

A user should still be able to browse folders normally even if some folders are also Projects.

---

# 15. Task UI

Add a Task area to a Project.

The initial Task list should show:

* title
* status
* attempt count
* relevant timestamps

Provide actions for:

* create Task
* open Task
* start/run Task
* stop Task
* rerun failed/stopped Task

Keep Chats and Tasks visibly distinct.

Do not turn existing chat records into Tasks.

### 15.1. Reference behavior for Task UI controls (from CodeLoop)

Before designing Pithagoras's Task UI, inspect the CodeLoop UI implementation
(`G:\work\git\pi-ralph-one\src\ui\app.js`, `index.html`, `style.css`) and its spec
(`G:\work\git\pi-ralph-one\CodeLoop.md`, §7). The following captures the button
names and lifecycle semantics that Pithagoras should reproduce (mapped onto
Pithagoras primitives, not ported verbatim).

#### Project-level controls (one set per project)

* **Running / Stopped indicator** — a dot + text showing whether the project's
  autonomous loop is currently executing.
* **Start / Stop control button** — a single toggle labeled `Start` when idle
  and `Stop` while running. Pressing it starts/stops the server-owned task loop
  for the whole project queue (not a single task). While running it is shown as
  a styled `btn-stop`; otherwise `btn-start`.
* **Delete project (`🗑`)** — deletes the project and all its tasks (with
  confirmation).

#### Task list layout

Each task row shows, left to right:

* a drag handle (to reorder the active queue),
* a status icon,
* the description/title preview (clicking it opens the Edit Task modal),
* a metadata row containing: timestamp(s), status text rendered with a
  `status-<status>` class, a workflow badge (`full` / simple), and an attempt
  badge,
* a set of per-action buttons (see below),
* a delete button (`×`).

Status indicator (per status):

> **Functional indicator, not a prescribed visual style.** The icons below are
> only a compact way to convey a task's lifecycle state at a glance in the list.
> They document *what state information the UI must communicate*; Pithagoras is
> free to represent the same information any way that fits the existing Pithagoras
> styling (color, text label, icon, etc.). Do not treat the specific glyphs as a
> design requirement.

```text
running   →  conveys "currently executing"
completed →  conveys "finished successfully"
failed    →  conveys "gave up after exhausting retries"
stopped   →  conveys "halted by the user"
```

The attempt badge renders as `↻ n/max` (e.g. `↻ 2/5`) and gains a `warn`
class/approach as the retry budget is nearly exhausted.

The project view has sub-tabs:

* **Tasks** — the active queue (`status !== 'completed'`).
* **Completed** — finished tasks (`status === 'completed'`).
* **Workflow** — edit project-level Task prompts/workflow (see §13 and the
  simple/full workflow concept).

#### Per-task action buttons

These are the concrete controls a user can perform on an individual Task. The
exact labels/icons used by CodeLoop are noted; Pithagoras should provide
functionally equivalent actions (identical glyphs are not mandatory).

| Action | CodeLoop control | Endpoint / effect | When relevant |
|---|---|---|---|
| **Edit task / revise** | Click the task description or row | Opens *Edit Task* modal: edit description, choose workflow (`simple` / `full`) | Always |
| **Mark complete** | `✓` ("Mark as complete") | `PUT .../tasks/:id/complete` → marks `completed` (with confirm) | Any non-completed task |
| **Rerun** | `↻` ("Re-run task") | `POST .../tasks/:id/rerun` → resets task to `{pending, attempts:0, startedAt:null, completedAt:null}` then lets the natural queue pick it up | failed / stopped / pending |
| **Resume** | `▶` ("Resume session") | `POST .../tasks/:id/resume` → resets to `pending`, moves the task to the **front of the queue**, and immediately starts the loop | failed / stopped / pending |
| **Reply / follow-up** | `↩` ("Reply to this task") | Creates a new follow-up task seeded with the original prompt plus a note to consult git history | any worked task |
| **View session history** | *(built-in)* | Not a separate dialog — the task view's bottom pane shows the concatenated history of all attempts/sessions for the task (see "Attempt history" below) | any task with sessions |
| **Delete** | `×` | `DELETE .../tasks/:id` (with confirm) | any task |

##### Rerun vs. Resume (important distinction)

Two closely related but different "run this work again" actions exist and must
remain distinct in Pithagoras:

1. **Rerun (`↻`)** — starts the task over from scratch: fresh context, attempt
   counter reset to 0, queued normally (no priority). Use when the previous
   attempt was wrong and you want a clean re-execution.
2. **Resume (`▶`)** — (this description is different behavior from what is 
presently in codeloop.) Resume the last session starting feim the same context.
Inject a message to the agent with a simple message "resume". This is generally 
used when a session has done a lot of thinking work that would otherwise be lost 
by hitting the rerun button.

#### Creating and editing tasks (chat-style input, not a modal)

Rather than a dedicated modal dialog, Pithagoras should create and edit tasks
through an input area modeled on the existing Pithagoras **chat interface**,
styled so the user can immediately tell it is a task field and not a normal chat.
This is a direction/constraint rather than a full spec — the exact markup should
follow Pithagoras conventions.

Requirements for this control:

* **Looks like a chat input but reads as a task editor.** Reuse the familiar
  chat-style text entry (placeholder, send button, etc.) but apply visible
  styling that distinguishes it from ordinary chat — e.g. a distinct label/
  header such as *New task* / *Edit task*, a different accent color or border,
  and/or a subtle icon — so the intent is unambiguous.
* **Create mode:** a single prompt where typing a description and sending creates
  the task. Optionally allow choosing a workflow (`simple` / `full`) here; keep
  it minimal so it does not feel like a separate form.
* **Edit mode:** the same control pre-filled with the task's current
  description (and workflow), used to revise the task.
* **Workflow guard:** the workflow selector is **disabled while the task is
  running**; editing a running task's workflow is rejected (CodeLoop returns
  HTTP 409 with a message such as "Stop the running task before changing its
  workflow, then resume it to apply the new workflow"). Changes take effect on
  the next run/resume.
* Sending in create mode creates the task; sending in edit mode saves the
  revision. Both feed the same server endpoints as a modal submit would.

#### Live execution / activity view

* A project **Activity console** streams the currently executing task's session
  incrementally (agent messages + tool calls: Bash/Edit/Write/Read/etc.),
  preserving scroll position, via the existing SSE/session system.
* It shows a status line such as `▶ <taskTitle>` while executing, an idle-running
  state, or `Stopped`.

#### Attempt history (in the task view bottom pane)

Opening a task shows its execution in the task view's **bottom pane** (this is
the normal task view, not a separate modal/dialog).

* When a task is running, the bottom pane streams that attempt's session
  incrementally (agent messages + tool calls: Bash/Edit/Write/Read/etc.) via the
  existing SSE/session system, preserving scroll position.
* When a task is not running — or when inspecting past work — the bottom pane
  **concatenates the history of every session/attempt tied to the task**, in
  chronological order, so the user can see what each retry did without opening
  individual session files. There is no separate "Session Viewer" dialog and no
  dedicated Raw JSONL view; the concatenated, parsed activity is sufficient.
* Attempt count is surfaced via the `↻ n/max` badge. There is no per-attempt
  diff/summary UI beyond the concatenated session contents themselves.

#### Auto-retry (server-owned) vs. manual actions

* **Auto-retry** happens server-side without browser involvement: when an
  attempt exits without the completion marker and without an explicit stop, and
  retries remain, the server re-queues the task (simple workflow) or restarts
  the stage/workflow (full workflow) and spawns a fresh session each time.
* **Manual** retry/resume/reply are user-initiated actions on top of that.
* Every automated/manual attempt uses a **fresh session/context**; the previous
  attempt is preserved only as history. Never reuse a prior failed conversation.

---

# 16. Task execution view

Opening a running Task should show its current execution.

Reuse the existing Pithagoras agent activity/session rendering wherever practical.

The user should be able to see:

* agent messages
* tool activity
* current execution state
* Task status

The Task view should not require a second implementation of Pi event rendering.

Use the existing session event/SSE system.

The Task should also expose previous attempts/history, using the underlying sessions rather than duplicating transcript data.

---

# 17. Backend/API

Add the minimum backend operations necessary for:

* listing Tasks for a Project
* creating a Task
* reading a Task
* editing a Task
* deleting a Task
* starting a Task
* stopping a Task
* rerunning a Task
* retrieving Task execution/history information

Follow the existing Express/API conventions.

Do not prematurely create a large REST abstraction.

Keep Task lifecycle logic in a dedicated server-side module/class rather than placing the orchestration directly inside route handlers.

---

# 18. Persistence

Use the existing SQLite database.

Add the minimum schema required for:

* Projects/Project metadata that cannot already be derived from the folder
* Tasks
* Task-to-session/attempt relationships
* Task execution state

Do not duplicate existing session event/history data.

Use existing database conventions and migration mechanisms.

Existing databases must continue to work after upgrading.

Preserve all existing chat/session data.

---

# 19. Concurrency

Do not initially assume Tasks must be globally serialized.

Pithagoras already supports multiple simultaneous chat sessions.

The Task runner should therefore use the existing session/executor model rather than introducing a global polling loop that unnecessarily prevents unrelated agent sessions from running.

If resource limits require restricting Task concurrency, isolate that policy from the Task model so it can be changed later.

---

# 20. Implementation phases

Implement incrementally.

### Phase 1 — Task persistence

Implement:

* Task database model
* Project association
* CRUD
* statuses
* attempt count
* migration
* backend Task service/module

No autonomous execution yet.

Verify existing Pithagoras functionality remains unaffected.

### Phase 2 — Project Task UI

Add:

* Project Task area
* Task list
* create/edit/delete
* status display

Still allow Tasks to exist without autonomous execution if necessary for testing.

### Phase 3 — Basic Task execution

Implement:

* start Task
* create fresh Pithagoras session for an attempt
* execute through existing `SessionManager`
* associate session with Task attempt
* update Task status
* stop Task

Use existing SSE/session infrastructure for activity display.

### Phase 4 — Completion protocol

Implement:

* Task completion marker
* completion detection
* completed state
* incomplete execution handling

Keep the completion detector isolated from the rest of Task orchestration.

### Phase 5 — Retry/attempt handling

Implement:

* maximum attempts
* fresh session per attempt
* failed state
* rerun
* attempt history

Do not reuse failed attempt conversation context automatically.

### Phase 6 — Project Task instructions

Implement:

* Project-level Task instructions
* persistence
* editing UI
* injection into Task execution prompts

Keep this separate from `AGENTS.md`.

### Phase 7 — Recovery and polish

Implement/test:

* server restart during Task execution
* stale running Tasks
* process/session cleanup
* reconnecting browser
* SSE replay
* Task history
* error handling
* concurrent Tasks
* deletion behavior

---

# 21. Important architectural rules

Throughout implementation:

1. **Do not create a second Project concept.**
   Extend the existing filesystem-based Project.

2. **Do not replace the filesystem UI.**
   Projects are an additional layer over existing folders.

3. **Do not turn Chats into Tasks.**
   They are separate user-facing concepts.

4. **Do not create another Pi execution engine.**
   Reuse `SessionManager`, `PiClient`, and the existing executors.

5. **Do not duplicate session transcripts.**
   Tasks should reference existing Pithagoras sessions/attempts.

6. **Do not make the browser responsible for autonomous execution.**
   The server owns Task execution.

7. **Do not make completion depend on process exit code alone.**
   Use an explicit completion protocol.

8. **Every retry should have a fresh execution/session.**
   Preserve the previous attempt as history.

9. **Keep Task orchestration separate from ordinary chat execution.**
   Shared infrastructure is desirable; conflating the concepts is not.

10. **Prefer small incremental changes.**
    Each phase should leave the existing application functional.

---

# 22. Before coding

Before beginning implementation, inspect the current source again specifically for:

* the existing Project API/UI
* SQLite migration conventions
* routine execution architecture
* SessionManager lifecycle methods
* session creation/resumption
* SSE event handling
* existing settings patterns

Then implement Phase 1 first.

Do not attempt to implement the entire system in one change.

After each phase, verify that existing Chats, Projects, filesystem navigation, and agent execution still work.
