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

### Resume

Resume means:

> Return an existing Task to autonomous execution using the appropriate existing session/context where supported.

This is distinct from a fresh Rerun.

Before implementation, inspect the current CodeLoop behavior and the Pithagoras session-resume capabilities carefully. Do not assume CodeLoop's existing Resume implementation is identical to the desired Pithagoras behavior.

If the intended Pithagoras Resume behavior is to continue the most recent session and inject a simple continuation instruction such as `resume`, implement that behavior explicitly rather than treating Resume as another Rerun.

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

Do not conflate "Continue conversation" with "Rerun Task."

---

# 13. Restart/recovery

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
Task becomes pending or stopped according to chosen recovery semantics
        ↓
user/server can run it again
```

Do not leave a Task permanently marked `running` when no execution exists.

---

# 14. Project-specific Task instructions

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
* Resume
* Edit
* Delete
* Mark complete where appropriate

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

After the completion has been acknowledged according to the CodeLoop behavior, the completed Task can move out of the active Tasks view and remain available through Completed.

Before implementation, inspect the actual CodeLoop implementation to determine precisely what event constitutes this acknowledgment/transition. Do not invent a new definition without first checking CodeLoop.

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

For editing a Task, the existing description should be loaded into the same task-oriented input control.

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
* resuming a Task/session where supported
* continuing an associated session/conversation
* retrieving Task execution/history information
* acknowledging/transitioning recently completed Tasks if required by the CodeLoop behavior

Follow the existing Express/API conventions.

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
* any minimal acknowledgment state required for recently completed Tasks

Do not duplicate existing session event/history data.

Use existing database conventions and migration mechanisms.

Existing databases must continue to work after upgrading.

Preserve all existing chat/session data.

---

# 25. Concurrency

Do not initially assume Tasks must be globally serialized.

Pithagoras already supports multiple simultaneous chat sessions.

The Task runner should therefore use the existing session/executor model rather than introducing a global polling loop that unnecessarily prevents unrelated agent sessions from running.

If resource limits require restricting Task concurrency, isolate that policy from the Task model so it can be changed later.

Project-level queue execution may naturally process Tasks according to their queue semantics, but this should not unnecessarily block ordinary Pithagoras chat sessions.

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

---

## Phase 2 — Project Task UI

Add:

* Project Tasks navigation entry
* dedicated Task workspace/page
* Task list
* Task ordering/reordering
* create/edit/delete
* status display
* recently completed vs. Completed behavior as determined from CodeLoop

Still allow Tasks to exist without autonomous execution if necessary for testing.

The page should establish the basic top Task queue / bottom selected Task workspace structure even if execution is not yet implemented.

---

## Phase 3 — Basic Task execution

Implement:

* start Task
* Project-level Task loop
* create fresh Pithagoras session for an attempt
* execute through existing `SessionManager`
* associate session with Task attempt
* update Task status
* stop Task

Use existing SSE/session infrastructure for activity display.

Implement the lower Task execution view using the existing Pithagoras activity/session renderer.

---

## Phase 4 — Completion protocol

Implement:

* Task completion marker
* completion detection
* completed state
* incomplete execution handling

Keep the completion detector isolated from the rest of Task orchestration.

Verify the CodeLoop completion semantics before finalizing the protocol.

---

## Phase 5 — Retry/attempt handling

Implement:

* maximum attempts
* fresh session per autonomous attempt
* failed state
* rerun
* attempt history
* recently-completed behavior
* appropriate queue handling

Do not reuse failed autonomous attempt conversation context automatically.

---

## Phase 6 — Task conversation/resume

Implement:

* Task execution/session viewing
* Continue conversation
* Resume behavior
* appropriate session continuation
* preservation of previous attempts
* clear distinction between Rerun, Resume, and Continue conversation

Reuse existing Pithagoras session/resume mechanisms wherever possible.

---

## Phase 7 — Project Task instructions

Implement:

* Project-level Task instructions
* persistence
* editing UI
* injection into Task execution prompts

Keep this separate from `AGENTS.md`.

---

## Phase 8 — Recovery and polish

Implement/test:

* server restart during Task execution
* stale running Tasks
* process/session cleanup
* reconnecting browser
* SSE replay
* Task history
* recently completed acknowledgment behavior
* error handling
* concurrent Tasks
* deletion behavior
* queue ordering
* Project deletion behavior
* Task/session cleanup rules

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
* Resume
* task/session history
* completion detection
* retry behavior
* recovery

Resolve any ambiguity between the CodeLoop behavior and this plan by examining the actual implementations before coding.

Then implement Phase 1 first.

Do not attempt to implement the entire system in one change.

After each phase, verify that existing Chats, Projects, filesystem navigation, and agent execution still work.
