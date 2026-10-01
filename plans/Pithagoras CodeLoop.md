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
