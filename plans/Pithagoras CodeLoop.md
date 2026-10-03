# Pithagoras Projects + Autonomous Tasks

Implement the first version of a Project/Task workflow in Pithagoras, incorporating the relevant autonomous-task behavior from CodeLoop while using Pithagoras's existing architecture and UI conventions.

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

# 1. Target conceptual model

The resulting application should conceptually look like:

```text
Home
│
+-- Projects
│   +-- Project A
│   │   +-- Chats
│   │   +-- Tasks
│   │   +-- Settings
│   │   +-- Files
│   │
│   +-- Project B
│       +-- Chats
│       +-- Tasks
│       +-- Settings
│       +-- Files
│
+-- existing filesystem/workspace experience
```

The filesystem remains the actual workspace.

A Project references the existing folder/path rather than copying or replacing it.

Existing chats continue to work as chats.

Tasks are a separate persistent concept.

The important conceptual distinction is:

```text
Filesystem folder
      │
      +-- Project
            │
            +-- Chats
            +-- Tasks
            +-- Settings
            +-- Files
```

The folder is the actual working directory.

The Project is application-level metadata associated with that folder.

A Chat remains a Pithagoras chat/session.

A Task is a persistent unit of autonomous work.

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

The existing sidebar/navigation should remain the primary navigation mechanism.

Tasks should be added as a new Project-level destination rather than adding individual Tasks to the sidebar.

Conceptually:

```text
Project A
  Chats
  Tasks

Project B
  Chats
  Tasks
```

Individual Tasks should not become navigation items.

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

---

# 4. Task model

Introduce a persistent Task entity associated with exactly one Project.

At minimum a Task needs:

* unique ID
* project association
* title/description
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

### Naming: Task vs. the existing `sessions.kind`

Pithagoras already stores ordinary user chats in `sessions` with `kind = 'task'`. That label
denotes an ordinary chat and is **not** the autonomous Task described here. To keep the two
apart:

* The autonomous work unit stays called a **Task** publicly (matching CodeLoop), persisted in its
  own `tasks` / `task_attempts` tables — never in `sessions`.
* Each autonomous **attempt** runs inside a Pithagoras agent session whose `kind` is a new value,
  `'autonomous'`, distinct from the existing `kind = 'task'` (ordinary chat) and from `'agent'`
  and `'routine'`. Never reuse `'task'` for an attempt session.

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
  +-- Attempt
        │
        +-- Pithagoras agent session
                 │
                 +-- Pi execution
```

The Task owns the lifecycle.

The session owns the conversation/execution history.

This allows the existing Pithagoras session infrastructure to continue doing what it already does well.

---

# 6. Attempts and session history

A Task must be capable of being executed more than once.

Each autonomous Task attempt should have its own agent execution/session rather than simply continuing a previous failed autonomous attempt.

The exact persistence representation should follow the existing SQLite architecture rather than introducing JSON files or another persistence system.

Prefer a small relational model that allows:

```text
Task
 +-- Attempt 1 → Session
 +-- Attempt 2 → Session
 +-- Attempt 3 → Session
```

The concrete shape of this model (the separate `task_attempts` table, the `workspace`-path project key, random-UUID Task ids, and the `kind = 'autonomous'` attempt-session label established in Phase 1) fixes these choices so later phases build on them consistently.

The existing session/event infrastructure should remain responsible for the actual conversation history.

Do not duplicate Pi transcripts into the Task database.

The Task model should reference the execution/session records it owns.

The UI should be able to show that a Task has multiple attempts and allow the user to inspect their execution history.

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
stopped → pending   (rerun)
```

A Task should remain persistent when execution stops or fails.

Do not delete or replace the Task when it is rerun.

Increment its attempt count and create a new autonomous execution/session.

The exact retry/completion mechanism should be implemented separately from the Task persistence model so it can evolve.

---

# 8. Autonomous execution loop

The Task runner should be server-owned rather than browser-owned.

Starting the Project Task loop from the UI should cause the server to take responsibility for processing eligible Tasks.

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

The Project-level Start/Stop control operates on the autonomous Task queue, not on the browser itself.

Individual Tasks may also be manually started where appropriate.

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

Initially support a configurable maximum number of autonomous attempts.

Conceptually:

```text
Task starts
   ↓
Agent attempt
   ↓
completion marker?
   +-- yes → completed
   +-- no
        ↓
   attempts remaining?
        +-- yes → new attempt
        +-- no → failed
```

Every new autonomous attempt should use a fresh agent session/context.

Do not automatically resume the previous failed conversation when performing an autonomous retry.

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

# 12. Rerun, Resume, and Continue Conversation

These operations should remain conceptually distinct.

### Rerun

Rerun means:

> Start the Task again from scratch using a fresh autonomous execution/session.

The previous attempt remains available as history.

Rerunning should not reuse the failed/stopped attempt's conversational context.

### Resume (resolved: not a separate operation)

There is **no separate "Resume" operation** in Pithagoras. Returning an existing pi
session to life from its same context — resuming a stopped/failed Task's conversation the
way an ordinary chat resumes — is exactly what **Continue conversation** does below.

Do not build a distinct Resume action, route, or button that duplicates it. The design
investigation confirmed that the existing Continue conversation mechanism already resumes a
pi session from the same context (it re-sends a prompt into the Task's existing session,
just like a normal chat follow-up). Any earlier plan text proposing a dedicated Resume was
superseded by this finding.

### Continue conversation

The Task execution view should also provide a way for the user to continue interacting with the Task's agent session in a chat-like manner.

This is a user conversation with the existing session, not an autonomous retry.

Conceptually:

```text
Task
 └-- Attempt
       └-- Session
            ├-- agent activity
            ├-- tools
            └-- user follow-up
```

A completed, stopped, or otherwise inspectable Task may therefore provide a chat-style input allowing the user to continue the associated conversation.

This should reuse Pithagoras's existing chat/session mechanisms wherever practical.

Continue conversation is a plain session follow-up: it sends a message into the Task's
existing pi session via the ordinary session-prompt path. It does **not** create a new
`task_attempts` row and does **not** increment the Task's attempt count, because it is not
a new autonomous run. If the view shows an attempt number, continuing leaves it unchanged
(runs through the same attempt rather than starting a new one).

Do not conflate "Continue conversation" with "Rerun Task."

---

# 13. Restart/recovery

Tasks must not be left permanently `running` if the server restarts or crashes.

Use the existing Pithagoras orphan/recovery architecture where possible. On startup the
orphan recovery (`recoverOrphans`) marks sessions left running by the previous server as
`interrupted`; Tasks must be reconciled alongside that so no Task is ever left marked
`running` when nothing is actually executing it.

The first implementation should favor correctness and recoverability over attempting to magically continue an interrupted Pi process.

Queue loop across restart (decided):

Whether the server-owned Project queue loop comes back automatically after a restart is a
**configuration setting**, not a fixed behavior. The default is **disabled**: the loop does
not re-enable itself on boot, so nothing starts running autonomously just because the
server came back up. Operators can opt in via the setting; when enabled, a restarted server
may resume its queued Projects.

Recovery semantics (decided):

```text
running Task at server shutdown
        ↓
execution/session becomes interrupted (marked by orphan recovery)
        ↓
Task is returned to `pending`
        ↓
user/server can run it again
```

---

# 14. Project-specific Task instructions

Add a Project-level setting for additional instructions that apply specifically to Tasks.

For example:

```text
Always restart the development server using ./xyz.ps1 after completing a task.
```

Do not alter the semantics of `AGENTS.md`.

`AGENTS.md` remains the normal filesystem/project instruction mechanism — this new setting
never reads, writes, or otherwise touches it.

The new setting is specifically additional instructions for autonomous Task execution, applied
only to the Tasks functionality (not to ordinary chats, routines, or channels).

Concrete shape (decided):

* Storage: a single free-text `instructions` column on the `projects` table (added with the
  usual SQLite migration, existing databases kept working). This is distinct from any
  `AGENTS.md` handling.
* Editing UI: edited on the existing Projects page, alongside the project's other settings,
  with copy that makes clear the text applies specifically to autonomous Tasks in that
  project.
* Injection: the stored text is appended as its own plain-text block inside the Task prompt
  built for every autonomous run (the queue loop and manual Start). It is a separate block
  from, and does not alter, `AGENTS.md`.
* Scope: injected only into autonomous Task runs. It is not sent into user "Continue
  conversation" follow-ups, which are plain session messages.

---

# 15. Project navigation and Task UI

Extend the existing Pithagoras Project navigation rather than replacing it.

The existing sidebar should continue to identify Projects/folders and provide their normal navigation.

Each Project should expose at least:

```text
Project
  +-- Chats
  +-- Tasks
```

Other existing Project/file navigation remains available.

Individual Tasks should NOT appear as individual sidebar entries.

The user selects the Project's Tasks destination to enter the Task workspace.

This avoids crowding the normal navigation with potentially large numbers of Tasks while keeping Tasks directly associated with their Project.

The exact visual treatment should follow existing Pithagoras components, styling, navigation patterns, and responsive behavior.

Do not build an entirely new application shell.

---

# 16. Task workspace

The Task destination should be a dedicated Pithagoras page/workspace for managing and observing Tasks.

The page should have two primary areas:

```text
+-------------------------------------------------------+
| Task queue / management                                |
|                                                       |
| pending / running / stopped / recently completed     |
|                                                       |
|-------------------------------------------------------|
| Selected Task execution / conversation                |
|                                                       |
| agent activity / history / follow-up                  |
+-------------------------------------------------------+
```

The exact layout should follow existing Pithagoras UI conventions, but the conceptual separation should remain clear:

* the upper area manages the Task queue;
* the lower area shows the selected Task and its execution.

The lower area should feel visually related to the existing Pithagoras chat/session experience rather than looking like a completely separate application.

---

# 17. Task queue

The upper portion of the Task workspace is the Task management area.

It should provide:

* Task list
* Task ordering/reordering
* Task status
* attempt information
* creation
* selection
* appropriate lifecycle actions

Tasks should be reorderable where queue ordering applies.

Queue order is not cosmetic: it fixes the order the Project loop runs Tasks in (§5,
§8), so the order the user sets here must be durable. It survives browser reloads and
server restarts and is stored per Project, not held only in the browser (see Phase 2).

The queue should provide a Project-level autonomous execution control:

```text
● Running    [Stop]
```

or:

```text
○ Stopped    [Start]
```

The control starts/stops the server-owned autonomous Task loop for the Project.

It does not itself represent the execution state of an individual Task.

Individual Task actions should be available where appropriate, such as:

* Run
* Stop
* Rerun
* Edit
* Delete
* Mark complete where appropriate

(There is no separate Resume action: resuming a Task's existing pi session from its same
context is the Continue conversation control in the Task execution view.)

Do not overload every Task row with unnecessary controls.

Less-common actions may be placed in an overflow/context menu if that fits existing Pithagoras conventions.

---

# 18. Recently completed Tasks and Completed history

The Task workspace should preserve the useful CodeLoop behavior where a newly completed Task does not immediately disappear from the user's active Task view.

The normal Task view should contain:

* pending Tasks
* running Tasks
* stopped Tasks
* failed Tasks
* recently completed Tasks that have not yet been acknowledged/cleared from the active view

This allows the user to clearly see that a Task has just finished.

Completed Tasks should also be available through a separate **Completed** view/tab containing completed Task history.

Conceptually:

```text
[Tasks] [Completed]
```

The Tasks view might temporarily show:

```text
✓ Fix authentication       Completed
● Add unit tests            Running
○ Update documentation      Pending
```

After the completion has been acknowledged, the completed Task can move out of the active
Tasks view and remain available through Completed.

This section deliberately **overrides** the earlier Phase 0 prototype resolution, which had
declared "no recently-completed-stays-visible distinction" (completed → Completed view
immediately). The explicit design decision below stands: a newly completed Task does stay in
the active view until it is acknowledged.

Acknowledgment (decided):

A completed Task is acknowledged — and therefore eligible to leave the active view — by
either of two actions:

* **Viewing it.** Clicking the completed Task to open/inspect it immediately marks it
  acknowledged. The active view's list itself is not rebuilt until the user leaves the task
  (so the running/pending/stopped rows are not disrupted mid-stream), but the clicked Task
  is now acknowledged and will not reappear in a fresh active-view pass.
* **Opening the Completed/History tab.** Navigating to the Completed tab automatically marks
  *every* completed Task acknowledged at once.

In both cases the Completed/History tab always lists all completed Tasks regardless of
whether any particular one has been acknowledged — acknowledgment only controls presence in
the active Tasks view, never presence in Completed.

No dedicated acknowledgment state needs to be persisted: acknowledgment is a client-side
view concern (what the active list shows), not a stored field. This keeps the persistence
model free of any extra "recently completed" column.

Before implementation, still inspect the actual CodeLoop implementation to mirror the precise
visual transition between "just completed" and "acknowledged" if CodeLoop offers anything
useful beyond what is described here. Do not invent a new definition without first checking
CodeLoop.

The exact visual indicator for completed Tasks is not prescribed. The UI only needs to make the lifecycle state obvious.

---

# 19. Task creation and editing

Creating and editing Tasks should use a control modeled on the existing Pithagoras chat interface rather than introducing a generic form-heavy task-management UI.

The control should:

* look familiar to a Pithagoras user;
* clearly communicate that it creates/edits a Task rather than sending a normal chat message;
* support a Task description/prompt;
* provide an obvious submit/send action;
* optionally expose workflow-related settings where required.

The exact markup, styling, icons, and placement should follow Pithagoras conventions.

The task editor should not require a large modal unless existing Pithagoras patterns make that appropriate.

A Task's title is generated automatically at creation from the prompt, exactly as an
ordinary chat title is: the first non-empty line of the prompt, whitespace-collapsed and
clipped to 47 code points with a trailing `…` (`server/src/projects.ts::titleFrom`, the
same helper chats use). No separate title field is required when creating a Task, and the
UI does not expose `max_attempts` for a Task (it stays server-controlled if used at all).
The Task can always be renamed from the Tasks view afterwards, mirroring how chats are
renamed. For editing a Task, the existing title and description should be loaded into the
same task-oriented input control.

If workflow selection is implemented in the first version, changing the workflow of a running Task must be prevented.

---

# 20. Task execution view

The lower portion of the Task workspace should show the selected Task's execution.

It should resemble the existing Pithagoras chat/session experience.

Conceptually:

```text
Task: Fix authentication

Status: Running
Attempt: 2/5

────────────────────────────────────────

Agent:
I've located the authentication problem...

Tool:
Read src/auth.ts

Tool:
Edit src/auth.ts

Agent:
I'll run the tests now.

Tool:
npm test

────────────────────────────────────────

[ Continue conversation... ]       [Send]
```

The exact visual presentation should reuse the existing Pithagoras session/activity rendering wherever practical.

The user should be able to see:

* Task title/description
* Task status
* current attempt information
* agent messages
* tool activity
* execution state
* previous execution history

Do not create a second implementation of Pi event rendering.

Use the existing session event/SSE system.

---

# 21. Task execution history

The Task execution view should expose the history of the Task's attempts without requiring a separate Session Viewer dialog.

A Task with multiple autonomous attempts should conceptually appear as:

```text
Task: Fix authentication

──────── Attempt 1 ────────

agent activity...
tool activity...
execution ended without completion


──────── Attempt 2 ────────

agent activity...
tool activity...
completion marker
```

When a Task is running, the current attempt should stream incrementally.

When inspecting a completed, stopped, or failed Task, the view should be able to show the historical sessions associated with that Task in chronological order.

The history should come from the existing Pithagoras sessions/events.

Do not duplicate transcripts into the Task database.

Do not create a dedicated Raw JSONL viewer for this feature.

---

# 22. Live execution/activity

A running Task should stream activity through the existing Pithagoras SSE/session infrastructure.

The browser should observe the server-owned execution rather than drive it.

The Task view should preserve the existing activity-view behavior where practical, including appropriate scroll behavior.

The project-level Task area may also indicate which Task is currently executing.

For example:

```text
● Running — Fix authentication
```

The exact wording and styling should follow Pithagoras conventions.

---

# 23. Backend/API

Add the minimum backend operations necessary for:

* listing Tasks for a Project
* creating a Task
* reading a Task
* editing a Task
* deleting a Task
* starting a Task
* stopping a Task
* rerunning a Task
* continuing an associated session/conversation (a plain follow-up into the Task's existing
  pi session via the ordinary session-prompt path — there is NO separate "Resume" endpoint,
  because resuming a session from its same context is exactly what Continue conversation does)
* retrieving Task execution/history information

Follow the existing Express/API conventions.

Acknowledging a recently completed Task is a client-side view concern (see §18) and needs no
API endpoint or persisted state.

Do not prematurely create a large REST abstraction.

Keep Task lifecycle logic in a dedicated server-side module/class rather than placing orchestration directly inside route handlers.

---

# 24. Persistence

Use the existing SQLite database.

Add the minimum schema required for:

* Project metadata that cannot already be derived from the folder
* Tasks
* Task-to-session/attempt relationships
* Task execution state

Acknowledgment of recently completed Tasks is a client-side view concern (§18), so no
acknowledgment state lives in the database.

Do not duplicate existing session event/history data.

Use existing database conventions and migration mechanisms.

Existing databases must continue to work after upgrading.

Preserve all existing chat/session data.

---

# 25. Concurrency

Autonomous Tasks must never run concurrently. At most one Task attempt is executing at any
time across the whole server; a second Task that would start while one is running is queued
rather than launched.

This applies both to the Project queue loop and to manual Start/Rerun of individual Tasks: the
single-agent rule wins over everything, so starting a Task while another is running enqueues
it (respecting queue order where a loop owns ordering) instead of opening a second session.

Ordinary Pithagoras chat sessions are not Tasks and are unaffected — they keep using the
existing session/executor model. Only autonomous Task execution is globally serialized.

If/when resource limits later require allowing more than one Task at a time, that policy is
isolated from the Task model so it can be relaxed later without restructuring Tasks.

---

# 26. CodeLoop as the behavioral reference

The CodeLoop repository is available to the agent and should be treated as the authoritative reference implementation for the autonomous task/project behaviors being added to Pithagoras.

Before implementing each major subsystem, inspect the corresponding CodeLoop implementation in `src/` to verify details rather than relying solely on the investigation summary.

CodeLoop source:

```text
G:\work\git\pi-ralph-one
```

In particular, use CodeLoop to verify:

* task state transitions
* retry semantics
* task/project persistence
* task queue ordering and selection
* process/attempt lifecycle
* completion-promise/marker detection
* stop vs. failure behavior
* stale-task recovery after restart
* fresh-session behavior for retries
* project instructions and prompt construction
* task/session history
* plan/progress handling
* Project-level queue controls
* recently-completed-task behavior
* Task editing behavior
* Task execution/activity presentation
* Resume vs. Rerun behavior
* UI behavior where applicable

Relevant CodeLoop UI/reference files include:

```text
G:\work\git\pi-ralph-one\src\ui\app.js
G:\work\git\pi-ralph-one\src\ui\index.html
G:\work\git\pi-ralph-one\src\ui\style.css
G:\work\git\pi-ralph-one\CodeLoop.md
```

Do not port CodeLoop's implementation architecture directly.

Reimplement the behavior using Pithagoras primitives.

For example:

* CodeLoop's Pi process management → Pithagoras `SessionManager` and executor abstraction
* CodeLoop's JSON persistence → Pithagoras SQLite persistence
* CodeLoop's session/activity handling → Pithagoras durable event/session infrastructure
* CodeLoop's UI → Pithagoras existing navigation, components, styling, and session/activity rendering

When CodeLoop behavior and the existing Pithagoras architecture appear to conflict, first inspect both implementations and preserve the intended CodeLoop behavior while following Pithagoras's architectural conventions.

Document any intentional behavioral difference in implementation notes/tests.

Do not treat CodeLoop's visual markup, CSS, component structure, or navigation architecture as something to copy.

CodeLoop is primarily the behavioral reference; Pithagoras remains the UI and architectural host.

---

# 27. Important architectural rules

Throughout implementation:

1. **Do not create a second Project concept.**
   Extend the existing filesystem-based Project.

2. **Do not replace the filesystem UI.**
   Projects are an additional application layer over existing folders.

3. **Do not put individual Tasks into the main sidebar.**
   A Project should expose a Tasks destination, and the Task workspace contains the individual Tasks.

4. **Do not turn Chats into Tasks.**
   They are separate user-facing concepts.

5. **Do not create another Pi execution engine.**
   Reuse `SessionManager`, `PiClient`, and the existing executors.

6. **Do not duplicate session transcripts.**
   Tasks should reference existing Pithagoras sessions/attempts.

7. **Do not make the browser responsible for autonomous execution.**
   The server owns Task execution.

8. **Do not make completion depend on process exit code alone.**
   Use an explicit completion protocol.

9. **Every autonomous retry should have a fresh execution/session.**
   Preserve previous attempts as history.

10. **Keep Task orchestration separate from ordinary chat execution.**
    Shared infrastructure is desirable; conflating the concepts is not.

11. **Keep "Rerun", "Resume", and "Continue conversation" conceptually distinct.**
    Rerun starts fresh autonomous execution; Resume continues an existing execution where supported; Continue conversation is direct user interaction with the Task's session.

12. **Keep the Task queue and Task execution view visually related but conceptually distinct.**
    The upper area manages work; the lower area shows what the selected Task is/was doing.

13. **Do not immediately hide newly completed Tasks.**
    Preserve the CodeLoop recently-completed behavior so completion is visible to the user before the Task moves into historical Completed state.

14. **Do not prescribe CodeLoop's visual design.**
    Preserve required behaviors while using Pithagoras's existing UI conventions.

15. **Prefer small incremental changes.**
    Each phase should leave the existing application functional.

---

# 28. Implementation phases

Implement incrementally.

## Phase 0 — UI Prototype / Design Validation

Before implementing Task persistence, execution, or database changes, create a functional UI prototype of the proposed Task experience inside the existing Pithagoras frontend.

The purpose of this phase is to validate the Task user experience and layout before committing to the implementation architecture. The prototype should use static/mock data only and should not require Task persistence, Task APIs, autonomous execution, or SQLite changes.

### Before implementing

Inspect the existing Pithagoras frontend to understand and reuse its established:

* Sidebar and project/folder navigation
* Page/layout structure
* Chat/session presentation
* Agent activity and tool-output rendering
* Inputs, buttons, menus, dialogs, and other controls
* Styling and visual conventions

Also inspect the CodeLoop UI and source implementation to understand the actual Task behaviors that the UI needs to represent, particularly:

* Task queue and ordering
* Task status presentation
* Running-task activity
* Completed-task handling and the distinction between recently completed and acknowledged/historical tasks
* Start, Stop, Rerun, and Resume behavior
* Task execution/history presentation
* Task editing/creation
* Any other interactions that materially affect the proposed Task workspace

CodeLoop is a behavioral reference, not a visual implementation reference. Do not copy its markup, CSS, navigation structure, or component architecture. Pithagoras remains the host application and its existing UI conventions should be preserved.

### Navigation entry (how one enters Tasks)

The Tasks workspace is reached from the existing **Projects** page. Each project card / project
header on `ProjectsPage` exposes a **Tasks** entry (a button/tab on that project).

Selecting it opens a dedicated **Tasks page** for that project.

Individual Tasks should **not** be added as separate entries in the main sidebar.

### Prototype structure

The prototype should introduce the proposed Project-level Tasks navigation:

```text
Project
  ├─ Chats
  └─ Tasks        ← opened from the Projects page
```

The Tasks entry is a per-project destination reached from `ProjectsPage`, not a global
sidebar destination and not an individual sidebar item.

Selecting `Tasks` should open a dedicated Task workspace containing two primary areas:

1. **Task queue / management area**

   * Displays the project's Tasks.
   * Shows relevant status and basic task information.
   * Allows selecting a Task.
   * Demonstrates queue ordering/reordering.
   * Provides the appropriate task lifecycle controls.
   * Provides access to completed Task history.

2. **Selected Task execution/conversation area**

   * Displays the selected Task's execution/activity.
   * Visually follows the existing Pithagoras chat/session experience where appropriate.
   * Demonstrates agent messages, tool activity, execution state, and attempt information.
   * Shows how previous attempts/history will be represented.
   * Provides a chat-like mechanism for continuing conversation with the Task's existing session.

The prototype should make the distinction between **autonomous Task execution** and **user conversation with a Task's agent session** clear.

### States to demonstrate

Use mock data to demonstrate at least:

* Empty Tasks view
* Pending Tasks
* Running Task with active agent/tool activity
* Stopped Task
* Failed Task
* Newly completed Task handled as in CodeLoop: it leaves the normal Tasks view at once and lives
  only in the Completed view (see Phase boundary below)
* Historical Completed Tasks
* A Task with multiple execution attempts
* Selected Task with execution history
* Continue-conversation interaction
* Task queue reordering
* Relevant lifecycle actions such as Start, Stop, Rerun, and Resume

The exact visual treatment and interaction details should be determined by examining the existing Pithagoras UI and the CodeLoop behavior rather than being prescribed by this plan.

### Recently-completed behavior (resolved from CodeLoop)

CodeLoop's actual `renderTasks` filters `status !== 'completed'`, so a completed task leaves the
active Tasks view **immediately** and appears only in the Completed tab. There is no
acknowledge/recently-completed step in the reference.

The prototype follows this: **no “recently completed stays visible” distinction.** A completed
Task goes straight to the Completed view.

### Page, not modal

The Tasks workspace is a **proper page component** (its own route through `App.tsx`, in the same
style as the existing Sessions/Projects pages), **not** a modal or overlay.

### Workflow settings

The optional workflow dropdown / workflow-related settings are **omitted** from Phase 0.
Task creation shows only title + description.

### Phase boundary

Do **not** implement the following during Phase 0:

* Task database schema or persistence
* Task API endpoints
* Autonomous Task execution
* Task scheduling/queue workers
* Completion-marker processing
* Retry execution
* Restart recovery
* New Task-specific backend services

Static/mock data and temporary frontend state are sufficient.

The prototype is intended to be disposable or substantially refactorable. Do not over-engineer its component architecture or create backend abstractions merely to support the prototype.

### How to verify (dev server)

Rather than relying on a build alone, launch the Vite dev server (`npm --prefix web run dev`)
and take screenshots of the Tasks workspace in several states to review the layout and styling
against Pithagoras conventions. If the dev server cannot run without a live backend, fall back
to a production build (`npm --prefix web run build`) succeeding and inspect the rendered markup.

### Phase completion criteria

Phase 0 is complete when the prototype allows the UI and interaction model to be reviewed and adjusted before backend implementation begins.

The approved prototype becomes the visual and interaction target for the subsequent implementation phases. Any UI decisions discovered during this phase should be incorporated into the implementation plan before proceeding to Phase 1.

## Phase 1 — Task persistence

Implement:

* Task database model
* Project association
* CRUD
* statuses
* attempt count
* migration
* backend Task service/module
* Task/session relationship model

No autonomous execution yet.

Verify existing Pithagoras functionality remains unaffected.

### Phase 1 design decisions (locked)

These resolve the ambiguities in the investigation phase and are the target schema/API for all
later persistence phases.

* **Project association key.** Follow the existing convention: store the project's resolved
  absolute folder path in a `workspace TEXT` column, exactly like `routines.workspace` and
  `sessions.workspace`. A Task is scoped to exactly one Project via this path. Projects themselves
  remain filesystem-derived (still not stored as rows).
* **Task ID.** A random UUID generated server-side at creation (`crypto.randomUUID()`), never a
  slug and never used in a URL. Matches how ordinary sessions are identified.
* **Attempt ↔ session model.** A dedicated `task_attempts` table (not a column on `sessions`):
  `id` (uuid), `task_id`, `session_id` (nullable until the attempt actually runs),
  `attempt_number` (integer, 1-based), per-attempt status and started/completed timestamps. It
  references the existing `sessions` row by id; it does not duplicate transcripts.
* **Autonomous-attempt session kind.** Attempt sessions use a new `kind = 'autonomous'`, distinct
  from the existing `kind = 'task'` (ordinary chat), and from `'agent'` / `'routine'`.
* **Status representation.** Plain `status TEXT NOT NULL DEFAULT 'pending'`, matching Pithagoras's
  existing plain-text columns (no CHECK constraint). Allowed values: `pending`, `running`,
  `completed`, `failed`, `stopped`.
* **Fields carried now.** In addition to the minimum in §4, include `max_attempts INTEGER` (NULL
  means unbounded; default NULL) even though retry logic is Phase 5, so the column exists before
  the logic that needs it. Project-level Task instructions (§7) are deliberately **excluded**.
  (From Phase 5 on this column is **not** used per-Task: there is no per-Task max attempts — a
  single server-wide default bounds every Task. The column is left in place but the execution layer
  ignores its value and applies the shared default.)
* **Backend module + minimal endpoints.** Orchestration lives in a dedicated server-side service
  module, not in route handlers. Add the minimum `/api/projects/:name/tasks*` endpoints needed to
  exercise CRUD so the layer is testable end-to-end, without building out the full API surface
  (routing/UI belong to later phases).
* **Migration.** Add the two new tables additively inside `migrate()` using presence checks, in
  the existing style, keeping every existing session/event/routine intact.

---

## Phase 2 — Project Task UI

Wire the Task workspace (the Phase 0 mock-only prototype in
`web/src/components/TaskWorkspace.tsx`) to the real Phase 1 backend, and add the queue-order
behaviour the mock could not perform. Execution stays for Phase 3; this phase is the UI plus
the persistence/order it needs.

### Resolved design decisions (locked)

These record the choices made before implementation so later phases build on them consistently.

* **Live data, not mocks.** The page fetches its Tasks from the Phase 1 API
  (`GET /api/projects/:name/tasks`) and performs create / edit / delete through the matching
  endpoints (`POST` / `PUT` / `DELETE`). No mock or seed data remains once wired: the browser
  drives the backend, never a local stand-in. New client methods live in `web/src/api.ts`
  alongside the existing session/project calls.
* **Queue order is durable and defines execution order.** Ordering is not cosmetic — it fixes
  the order the Project loop runs Tasks in (§5, §17) — so it must survive reloads and server
  restarts. Extend the `tasks` table additively with a `position INTEGER NOT NULL DEFAULT 0`
  column scoped per workspace (`ORDER BY position, id`). On create a Task takes
  `max(position)+1` within its Project. Add one reorder endpoint
  (`PUT /api/projects/:name/tasks/order`, an ordered array of Task ids) that rewrites positions
  in a single transaction. Drag-to-reorder in the UI must actually move items and persist the
  result — the mock showed the grip/drag graphics but the items would not move.
* **Auto-generated title; rename later.** Creating a Task from the prompt reuses the chat
  title rule (`titleFrom`): the title is the first non-empty line of the prompt, clipped as
  described above. No separate title field is needed at creation. A Task can be renamed from
  the Tasks view afterwards (edit → title), the way chats are renamed.
* **No per-task max attempts.** `max_attempts` is not user-configurable in the UI. It remains
  in the schema from Phase 1 but the Task editor does not expose it, and (from Phase 5) there is
  no per-Task max at all — a single server-wide default bounds every Task instead.
* **Bottom panel keeps the mock transcript.** Autonomous execution is Phase 3, so the selected
  Task's lower panel continues to show the seeded/mock attempt history for visual validation.
  Only the queue — list, order, create/edit/delete, status display, and tabs — is live here.
* **Run controls stay inert placeholders.** Run / Resume / Stop / Rerun and the Project-level
  Start/Stop queue control stay in the layout exactly as the mock shows them, but call no
  execution API yet (that is explicit Phase 3 work). They are kept so the final layout exists;
  wiring them is not part of Phase 2.
* **Recently completed vs. Completed** is unchanged from Phase 0: two tabs, *Actions* (everything
  except `completed`) and *Completed* (`completed`), and a Task leaves *Actions* the moment it
  completes — there is no lingering “recently completed” state.

### Still true

Tasks may exist without autonomous execution. The page establishes the basic top Task queue /
bottom selected Task structure, with the queue now backed by real persistence and durable order.

---

## Phase 3 — Basic Task execution

Implement:

* start Task
* create fresh Pithagoras session for an attempt
* execute through existing `SessionManager`
* associate session with Task attempt
* update Task status
* stop Task

Use existing SSE/session infrastructure for activity display.

Implement the lower Task execution view using the existing Pithagoras activity/session renderer.

> **Status: implemented.** Backend orchestration lives in `server/src/task-execution.ts`
> (`startTask` / `stopTask` / natural-end settle); routes added in `server/src/api/tasks.ts`
> (`POST /start`, `PATCH /status`, `GET /attempts`). Frontend: `web/src/use-session-events.ts`
> (SSE replay-then-stream per session), `web/src/components/TaskTranscript.tsx` (renders one
> attempt's transcript), the rewritten bottom panel in `TaskWorkspace.tsx`, and API helpers in
> `web/src/api.ts`. Server + web type-check and build clean; `server/test/tasks.test.mjs` passes.
> See the resolved decisions below.

### Prerequisites / baseline (resolved)

* **Phases 0–2 are complete.** The Phase 0 prototype, Phase 1 persistence (`tasks` / `task_attempts`, the DB helpers, and the `kind = 'autonomous'` label), and Phase 2 wired UI plus durable queue order are the authoritative baseline. Build directly on the committed Phase 1/2 code. Do not re-implement Task persistence, the backend Task service module, or the Tasks page here.
* **Attempt ↔ session model already exists.** Reuse the Phase 1 `task_attempts` row (populate its `session_id` when the attempt actually runs) and the `kind = 'autonomous'` session label established in Phase 1. A Task owns the lifecycle; each autonomous attempt gets its own fresh Pithagoras agent session created through `SessionManager`.

### Status transitions at natural end (resolved)

* **A naturally-finished attempt is `failed`.** Because completion detection is deferred to Phase 4, an autonomous attempt that reaches Pi's natural end *and was not intentionally stopped* is recorded as `failed` (incomplete) via the existing `db.updateAttemptFields(...)` / `recordAttemptEnd` path — it is **not** left hanging in `running`. This keeps every Task out of a permanent `running` state before the completion protocol lands.
* `stop Task` still records `stopped` (intentional), kept distinct from the natural-end `failed`. Both retain the attempt/session as history; neither deletes the Task or its session.

### Live execution view (resolved)

* **The bottom panel is fully wired, now (in Phase 3).** Every part of the selected Task's lower area is live in this phase — no mock, seeded, or stale transcript (the Phase 2 placeholder is replaced). It reuses the existing Pithagoras activity/session renderer rather than introducing a new one, and preserves existing behavior such as scroll handling. This includes:
  * **Live running-attempt activity** — the currently running attempt's agent messages and tool activity stream in real time through the existing SSE/session infrastructure.
  * **Multi-attempt historical viewing** — inspecting a completed, stopped, failed, or running Task shows its prior attempts' sessions/events in chronological order (from existing Pithagoras sessions/history, not duplicated into the Task DB), without a separate Raw-JSONL viewer.
  * **Continue conversation** — a chat-style input lets the user continue interacting with the Task's agent session as a normal (non-autonomous) conversation, reusing existing chat/session mechanisms. This stays conceptually distinct from Rerun/Resume.
* **Deferred from Phase 6:** only **Resume** (returning an existing Task to *autonomous* execution) remains in Phase 6; Rerun stays in Phase 5. Start / Stop wiring is inherent to this phase's execution work.

---

## Phase 4 — Completion protocol

Goal: give autonomous attempts a reliable way to reach a **terminal** state so a Task never sits
forever in `running`, and so genuinely finished work is marked `completed` rather than merely
`failed`. This phase also owns the **prompt messaging** the agent needs to complete correctly — the
server currently sends only `task.description || task.title` (see `task-execution.ts`), which is
missing everything that makes the code loop work.

Keep the completion detector isolated in its own module/prompt block so the exact marker and prompt
can change later without restructuring Task orchestration (§9). Reuse the existing session/event
infrastructure to read the transcript; do not invent a new one.

### Project-level queue loop / start-stop (resolved — moved here from the completed Phase 3)

The Project-level autonomous queue loop and its Start/Stop control were originally sketched under
Phase 3, but Phase 3 is complete. This loop resolves all three reported symptoms (no queue
processor, Tasks stuck in `running`, per-task play being required), so it lives here in Phase 4 and
builds on the finished Phase 3 execution + natural-end wiring. Build it around the same
`SessionManager`/attempt model already in place — do **not** spawn Pi directly as CodeLoop does.
The authoritative reference is `G:\work\git\pi-ralph-one\src\ralph.js` and `...\routes.js`.

* **Entry points.** Mirror CodeLoop's `startLoop()/stopLoop()`: expose a project queue-control
  endpoint pair (e.g. `POST /api/projects/:name/queue/start` and `.../stop`) backed by
  `SessionManager`, not a fresh Pi launcher. `startLoop` sets a running flag and begins a recursive
  poll timer (`setTimeout(poll, interval)`); `stopLoop` aborts any active attempt via the existing
  `SessionManager.abort()` and clears the flag.
* **Per-task Run stays.** The existing per-task Run/Stop buttons remain as a manual single-run
  shortcut. They are distinct from the project-level Start/Stop, which enables/disables the
  automatic queue processor.
* **One agent at a time.** Only a single Task may run at a time under the task processor: the loop
  must not launch a new attempt while any attempt of any Task is live. Ordinary chat sessions are
  unaffected (this is the concurrency policy for §25).
* **Ordered, non-bypassing execution.** `poll()` selects the next work item in durable queue order
  (the Phase 2 `position` column, `ORDER BY position, id`) — the first `pending` Task. Default
  behaviour is to process Tasks strictly in the order they appear. A failed Task **cannot be
  bypassed**: the loop is prevented from advancing past it even though the loop itself is not
  necessarily stopped — it simply stalls on the failed Task until the user intervenes (rerun/resume/
  mark-complete) or the configured retry budget recovers it. Order stays predictable and failed work
  is never silently skipped.
* **Configurable retry budget.** Attempts-per-Task is a configuration setting, not a fixed constant.
  When a Task exhausts its configured attempts it becomes `failed`; because a failed Task cannot be
  bypassed, this also stalls the loop as above.
* **Per-project.** Each Project has its own running flag and loop; starting one Project's loop does
  not start another's (mirroring CodeLoop's per-project `state.json`).
* **Restart recovery.** If the server restarts while a loop is running, persist whatever minimal
  state recovery needs (loop-running flag + current task) so recovery can restore it instead of
  leaving Tasks permanently `running`. Recovery *implementation* is Phase 8 (server restart during
  Task execution); Phase 4 only persists the state recovery requires.

**Verification.** Start a Project's loop with three+ ordered pending Tasks and confirm they execute
strictly in `position` order, one at a time, auto-advancing from one to the next; a failed Task
stalls the loop without being skipped; and the project-level Stop halts the active attempt,
leaving no Task stuck in `running`.

### The completion marker / promise (resolved from CodeLoop)

Use a dedicated, unambiguous marker the agent must emit when it believes the Task is fully done;
only that marker transitions a Task to `completed` (§9). Do **not** infer completion from process
exit code, final response text, tool-stop, or a bare "done".

CodeLoop's authoritative reference (`G:\work\git\pi-ralph-one\src\ralph.js`):

* **Marker string:** `<PROMISE>THIS TASK IS DONE</PROMISE>`, required to appear **on its own line**.
* **Detection is strict.** `emitsCompletionPromise()` only accepts the marker standing alone on a
  line (optionally wrapped in one pair of backticks or a code fence); an inline mention inside prose
  — e.g. a model *refusing* to output the string — must **not** count, otherwise a task instructed
  to fail gets falsely marked complete. `hasCompletedPromise(sessionPath, startOffset)` reads only
  assistant `text` content from the JSONL session and only from `startOffset` onward so pre-existing
  conversation is ignored.
* **Flush race.** `waitForPromise()` waits for the session file size to stabilise before the
  definitive check, because Pi can exit before its buffers flush the final entries to disk; a
  genuine end emitted at the very last moment would otherwise be missed and a correct task
  mislabelled. Reproduce this settle-then-check discipline in Pithagoras by reading the attempt's
  session events after the run ends, with a short stabilization wait.
* **Outcome table.** Promise found → `completed` (wins even if a stop raced in). Not found, not
  intentionally stopped, retries remaining → the run is incomplete. Not found, not stopped, no
  retries left → `failed`. Intentionally stopped (distinct from natural end) → `stopped`.

### Prompt construction (the missing messaging — resolved)

The agent must receive the full code-loop framing, not just the raw description. Model the prompt
after CodeLoop's `buildPrompt(projectName, task)`:

```
You are Pithagoras, an AI assistant helping execute task development.

## Specific Task
Task: <title>

Description:
<description>

## Project Workflow            <- project task instructions (§7 when implemented)
<instructions>

## Additional Instructions     <- any extra per-task addenda

## Review & Commit
When you believe this task is completely implemented, before finishing, review all code changes
in detail ... Revise the code if needed.

## Completion Requirement
When you believe all criteria for this task have been fully met, you MUST output the following
string exactly as written on its own line:

<PROMISE>THIS TASK IS DONE</PROMISE>

<portal> will only mark this task complete when it sees that exact string ... If the string is
not found after up to <maxIter> attempts, the task will be marked as failed.
```

Concretely, the Phase 4 prompt sent to an attempt must contain, at minimum:

1. The role/task header identifying the task by title + description.
2. The **Completion Requirement** block instructing the standalone `<PROMISE>THIS TASK IS DONE</PROMISE>`
   marker (this is the messaging currently absent).
3. A Review & Commit instruction before finishing.

The §7 Project Task instructions block is layered into this same prompt but remains a separate
concern (implemented in Phase 7). Do not ship the instructions block in Phase 4; ship the marker
and framing so completion works, then let Phase 7 add user-editable project instructions on top.

### Natural-end transition rules (resolves the "stuck in running" symptom)

A naturally-finished attempt (Pi/session ends without the user stopping it) must always move to a
terminal state — never hang in `running`:

* If the completion marker is present in the attempt's session → `completed`.
* Otherwise → `failed` (incomplete), exactly as the Phase 3 placeholder already does, until retry
  logic lands. The Phase 3 `trackEnd`/`finishSettled` path (natural end ⇒ `failed`) stays in place
  and is now correct because Phase 4 has filled in the `completed` branch.
* Intentional stop (via `stopTask`) ⇒ `stopped`, kept distinct from the natural-end `failed`, and
  both retain the attempt/session as history (§11).

Once these rules hold, the Phase 4 queue loop's auto-advance is safe: `poll()` always finds a clear
next action for every Task and no Task is left permanently `running`.

### Verify the CodeLoop semantics first

Before finalizing, confirm in `G:\work\git\pi-ralph-one\src\ralph.js` how the exit handler decides
promise-vs-stop-vs-retry and how the loop re-enqueues on retry, so Pithagoras reproduces the intended
outcome rather than an approximation. The exact marker text and prompt wording may be tuned here,
but the "marker-or-fail, standalone-line detection, flush-safe read, stop-vs-failure distinction"
must be preserved.

---

## Phase 5 — Retry/attempt handling

This phase closes out the retry/attempts behaviour that Phases 3–4 scaffolded, wires the
Project-level queue Start/Stop control into the UI (it was never added), and pins down the
Rerun vs Run semantics. Most of its items already exist from earlier phases:

* **maximum attempts** — the `max_attempts` column exists (Phase 1), but there is **no per-Task
  max attempts**. A single **server-wide default** applies to every Task. Implement it as one
  server-side constant (e.g. `DEFAULT_MAX_ATTEMPTS` in the execution layer) used wherever the
  old `task.max_attempts ?? Infinity` / `?? undefined` lived, so every Task is bounded by the same
  value. No per-Task override, no per-Task editor field.
* **fresh session per autonomous attempt** — already correct: each attempt opens a new
  `kind = 'autonomous'` session with no prior context.
* **failed state**, **attempt history** — already present (natural-end settle records `failed`;
  `listAttemptsByTask` renders history).
* **appropriate queue handling** — the loop runs one agent at a time in durable order and cannot
  bypass a failed Task.

### Auto-retry in the queue loop (resolved)

The Project queue loop **auto-retries** a naturally-failed attempt up to the server-wide
`DEFAULT_MAX_ATTEMPTS`, then marks the Task `failed`:

```
attempt ends without completion marker
   ↓
attempts < DEFAULT_MAX_ATTEMPTS?
   +-- yes → reset the Task to `pending` so the next poll launches a fresh attempt
   +-- no  → mark the Task `failed` (budget exhausted); the loop stalls on it, cannot bypass
```

Every auto-retry uses a brand-new session; the previous failed attempt stays as history. This is
the behaviour the §10 retry diagram describes. A natural end must therefore always move off
`running` — either back to `pending` (retry) or to `failed` (budget gone) — never hang.

### Rerun vs Run (resolved from CodeLoop)

These two controls are distinct, matching CodeLoop's actual behaviour:

* **Rerun** resets a Task to its initial `pending` state **without starting it**. It exists so a
  user can clear a `failed`/`stopped` Task back onto the queue and reorder/re-run it later. It does
  **not** launch an attempt.
* **Run** (the individual per-Task button) **bypasses the queue entirely** and starts that Task
  immediately. Because a `failed`/`stopped`/`completed` Task cannot run in place, Run first resets
  it to `pending` and then starts a fresh attempt — i.e. it inherently includes the Rerun reset as
  part of starting.

Neither reuses a failed attempt's conversation context. Keep both conceptually separate from
`Resume` (Phase 6) and from non-autonomous `Continue conversation` (Phase 3).

### Project-level queue Start/Stop control (added to this phase)

The Project-level **Running [Stop] / Stopped [Start]** queue control (sketched in §17, §20 but
never built) lives here. It toggles the server-owned autonomous loop for that Project only — it is
**not** the state of any individual Task and **does not** itself execute a Task. Wire it to the
existing `POST /api/projects/:name/queue/start` and `.../queue/stop` endpoints and their backed-in
`startLoop`/`stopLoop` (`task-queue.ts`); fix any wiring bugs found while connecting it. While the
loop is running, a per-Task `Run` still bypasses it and takes the single live agent slot, so guard
against launching two attempts at once (the existing `hasLiveTaskRun()` gate covers cross-project;
keep per-Project Run disabled or clearly distinct while the loop holds the agent).

### Not in scope here

* **Recently-completed behaviour** — already resolved in Phase 0: a completed Task goes straight to
  the Completed tab with no lingering “recently completed” state. Nothing to add.
* New persistence/schema. Retry uses only what Phases 1–4 already store.

Do not reuse failed autonomous attempt conversation context automatically.

---

## Phase 6 — Resume (resolved: no distinct work)

The design investigation concluded that there is **no separate "Resume" operation**. Returning
an existing pi session to life from its same context — resuming a stopped or failed Task's
conversation exactly like an ordinary chat resumes — is already provided by **Continue
conversation**, which was implemented in Phase 3.

So Phase 6 is a verification/cleanup step rather than a build step:

* Confirm the Continue conversation control resumes the Task's existing pi session from its
  same context via the ordinary session-prompt path (a normal follow-up).
* Confirm it does **not** create a new `task_attempts` row and does **not** increment the
  Task's attempt count (it runs within the current attempt).
* Ensure there is no stray Resume button, route, or handler left over from the plan.

Nothing else here changes the Rerun-vs-Continue distinction established in Phase 5: Rerun
starts a fresh session/attempt; Continue resumes the current one.

---

## Phase 7 — Project Task instructions

Implement project-level instructions for autonomous Tasks, kept fully separate from
`AGENTS.md`:

* **Persistence:** add a single free-text `instructions` column to the `projects` table via
  the usual SQLite migration (existing databases kept working).
* **Editing UI:** add the field on the existing Projects page, with copy stating it applies
  specifically to autonomous Tasks in that project.
* **Injection:** append the stored text as its own plain-text block inside the Task prompt
  built for every autonomous run (queue loop and manual Start). It sits alongside — and never
  alters — `AGENTS.md`.
* **Scope:** injected only into autonomous Task runs, not into user "Continue conversation"
  follow-ups.

### Status: implemented

Done without changing the database: Pithagoras keeps projects as filesystem folders and their
agent guidance as `AGENTS.md`, so the planned `instructions` column has no `projects` table to
live on. Following the architectural rule that this must never touch `AGENTS.md` (which pi reads
for every chat and would leak Task-only guidance into ordinary chats), the instructions are
stored in a dedicated sidecar file `PITHAGORAS_TASKS.md` in each project folder
(`server/src/projects.ts::TASK_INSTRUCTIONS_FILE`, plus `readTaskInstructions`
/`writeTaskInstructions` and name-keyed `readProjectTaskInstructions`
/`writeProjectTaskInstructions`). Existing databases are unaffected because no schema changed,
and the file dies with the folder on project delete (§8).

* **Editing UI:** a separate "Task instructions" button and modal on the Projects page
  (`web/src/components/ProjectsPage.tsx::TaskInstructions`) with copy making clear it applies
  only to autonomous Tasks in that project — distinct from the AGENTS.md editor.
* **API:** `GET`/`PUT /api/projects/:name/task-instructions` (`server/src/server.ts`), backed by
  `web/src/api.ts::projectTaskInstructions` / `setProjectTaskInstructions`.
* **Injection:** `startTask` reads the project's instructions from `task.workspace` and passes
  them to the already-existing `buildTaskPrompt(task, { projectInstructions })`, so both the
  queue loop and manual Start carry the block. The prompt builder was unchanged in contract
  (Phase 4 threaded `projectInstructions` through as an argument for exactly this).
* **Scope:** only autonomous runs go through `buildTaskPrompt`; "Continue conversation" uses the
  ordinary `POST /api/sessions/:id/prompt` path and is never injected.

Server and web builds type-check clean; new behaviour covered by `server/test/task-instructions.test.mjs`.

---

## Phase 8 — Recovery and polish

Implement/test:

* **Server restart / recovery.** No Task is ever left marked `running` when nothing is
  executing it. An interrupted Task is reconciled back to `pending` (keeping its
  attempt/session history) alongside orphan-session recovery. Verify a stopped/failed Task
  with a dead session is recoverable by running it again.
* **Queue loop across restart** behaves per the configuration setting: default off (the loop
  does not re-enable itself on boot); document/opt-in path when enabled.
* Stale running Tasks; process/session cleanup; reconnecting browser; SSE replay; Task
  history.
* **Recently completed acknowledgment.** A newly completed Task stays in the active view until
  acknowledged, then moves to Completed. Acknowledgment happens either by clicking the
  completed Task to view it (acknowledged immediately, active list rebuilt only after the
  user leaves the task) or by opening the Completed/History tab (marks all completed Tasks
  acknowledged at once). The Completed tab always lists every completed Task regardless of
  acknowledgment state.
* **Concurrent Tasks.** Never run two Task attempts at once anywhere. Starting a Task while
  another runs queues it (respecting queue order under the loop) instead of opening a second
  session. Manual Start/Rerun are subject to the same single-agent rule.
* **Deletion.** Deleting a Task aborts its underlying pi session if it is still running
  (reuse the existing stop/abort mechanism), then drops the Task and its attempts.
* **Project deletion.** Cascades to the project's Tasks and their attempts; the shared
  sessions they used are left orphaned like other project deletions.
* Error handling; queue ordering; Task/session cleanup rules.

---

# 29. Before coding

Before beginning implementation, inspect the current source again specifically for:

* existing Project API/UI
* existing Sidebar navigation structure
* existing ProjectsPage behavior
* SQLite migration conventions
* routine execution architecture
* SessionManager lifecycle methods
* session creation/resumption
* SSE event handling
* existing settings patterns
* existing chat input/editor components
* existing agent activity/session rendering

Also inspect the corresponding CodeLoop implementation for:

* Task lifecycle
* queue ordering
* Project-level Start/Stop behavior
* recently completed → Completed transition
* Task editing
* Rerun
* Resume (implemented here as Continue conversation — resuming a session from its same context)
* task/session history
* completion detection
* retry behavior
* recovery

Resolve any ambiguity between the CodeLoop behavior and this plan by examining the actual implementations before coding.

Then implement Phase 1 first.

Do not attempt to implement the entire system in one change.

After each phase, verify that existing Chats, Projects, filesystem navigation, and agent execution still work.
