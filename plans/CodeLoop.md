We are considering extending the Pithagoras project to incorporate the task-oriented workflow from another project called CodeLoop.

Do not start implementing anything yet.

Your job is to investigate the existing Pithagoras and CodeLoop codebase thoroughly enough to produce a high-level implementation plan.  Create the high level plan in the plans subfolder.

Pithagoras:
G:\work\git\pithagoras

CodeLoop (aka pi-ralph-one):
G:\work\git\pi-ralph-one

## Overall goal

We want to extend Pithagoras from primarily an agent/chat-oriented application into an application where **Projects are first-class objects and Tasks are a first-class way of asking an agent to accomplish work**.
CodeLoop has the desired tasks functionality and we are migrating that functionality into pithagoras.

The existing Pithagoras filesystem/folder experience should remain intact. We are extending it, not replacing it.

The rough conceptual structure we have in mind is:

```
Pithagoras
│
├── Projects
│   ├── Project A
│   │   ├── Chats
│   │   ├── Tasks
│   │   └── Settings
│   │
│   └── Project B
│       ├── Chats
│       ├── Tasks
│       └── Settings
│
└── Folders (in Home folder)
       └── Folder A (only chats can be hosted here)
```

The diagram is conceptual rather than a proposed implementation.

### Important clarification about the existing filesystem UI

Pithagoras currently presents folders beneath its "Home" filesystem environment.

**Do not replace or redesign that filesystem experience.**

Instead, Projects should be an additional top-level concept alongside the existing filesystem.

The user should still be able to browse the filesystem normally.

A filesystem folder can additionally become/serve as a Project. Once the user enters a Project, the Project-specific UI provides access to that project's Chats, Tasks, and Settings, while the underlying project directory remains the actual filesystem workspace.

Investigate how Pithagoras currently represents its Home/folder environment and determine the cleanest way to add Projects alongside it.

---

# 1. Projects

We want folders/workspaces to be able to become first-class **Projects**.

Conceptually, the application should have two related top-level areas:

```
Projects
Filesystem
```

The Filesystem continues to work as it does today.

Projects provide an additional organizational and behavioral layer over selected filesystem folders.

A Project should ultimately provide access to:

* Chats
* Tasks
* Settings
* the underlying project files/workspace

Do not assume that a filesystem folder needs to be copied, moved, or replaced.

Investigate whether a Project can simply reference an existing folder/path and add project-specific metadata and behavior around it.

Determine how Pithagoras currently represents folders, workspaces, projects, sessions, etc.

---

# 2. Project navigation

The intended user experience is roughly:

```
Home
  │
  ├── Projects
  │     ├── MyProject
  │     ├── AnotherProject
  │     └── ...
  │
  └── Filesystem
        ├── folder
        ├── folder
        └── ...
```

Selecting a Project takes the user into the Project environment.

Inside the Project, the user should be able to access things such as:

```
MyProject

  Chats
  Tasks
  Settings
  Files
```

The exact UI should be determined after inspecting the existing Pithagoras UI architecture.

Do not unnecessarily redesign the existing Home/filesystem navigation.

---

# 3. Chats

Existing Pithagoras chats should remain essentially what they are.

We do NOT want to turn every chat into a task.

A Chat is conversational and user-driven.

A Task is goal-oriented and agent-driven.

They may share underlying session/agent infrastructure, but they should remain distinct concepts in the user interface and persistence model.

Investigate how chats are currently represented and executed in Pithagoras and identify infrastructure that Tasks could potentially reuse.

---

# 4. Tasks

Tasks are the major new concept.

A Task represents a specific piece of work that the user wants the agent to accomplish.

For example:

```
"Implement support for XYZ."
```

A Task differs from a Chat because it has an explicit lifecycle and completion concept.

Tasks should be persistent objects associated with a Project.

They should have user-visible statuses such as:

* In Progress
* Stopped
* Completed
* Failed

There may be additional internal/transient states if the architecture calls for them, but do not decide those prematurely.

Tasks should have their own area/list within a Project.

For example:

```
Project: MyProject

Chats
  Chat A
  Chat B

Tasks
  Implement feature X       In Progress
  Fix bug Y                 Completed
  Update documentation      Stopped
  Fix build failure         Failed
```

Opening a Task should provide an execution view showing the agent working on that Task.

The execution view can reuse or resemble the existing Pithagoras agent/chat execution UI where appropriate.

However, the Task itself should be a separate persistent object rather than simply another Chat.

---

# 5. CodeLoop-style task execution

CodeLoop is based around the idea that an autonomous coding request is a **Task**, rather than simply a single query.

The general workflow is:

```
User creates Task
    ↓
Agent works on Task
    ↓
Agent reaches a stopping point
    ↓
System determines whether Task is complete
    ↓
If not complete:
    continue/retry the Task
    ↓
Eventually:
    Completed / Failed / Stopped
```

The exact implementation of CodeLoop's completion mechanism should be investigated if its source is available.

Do not assume that the completion protocol, retry behavior, prompts, or state machine should be copied exactly.

Instead:

1. Find how CodeLoop actually implements this.
2. Explain the relevant behavior.
3. Determine how the same conceptual behavior could fit into Pithagoras.
4. Identify which Pithagoras mechanisms can be reused.

The goal is to preserve the useful **task-oriented execution model**, not necessarily the exact CodeLoop implementation.

---

# 6. Project-specific instructions/settings

Projects should have project-specific settings.

One important setting is a **project-specific prompt/instruction addon**.

For example, a project might specify:

```
"Always restart the server using xyz.ps1 after completing a task."
```

These instructions should apply to Tasks launched within that Project.

Do not assume how this should be stored or injected.

First investigate Pithagoras's existing mechanisms for:

* project/workspace instructions
* AGENTS.md or equivalent instruction files
* session initialization
* system prompts
* agent prompts
* project configuration
* context loading

Then determine where an additional project-specific task instruction mechanism would naturally fit.

---

# 7. Task history / attempts

CodeLoop's concept includes repeatedly working on the same Task rather than creating a completely new task for every attempt.

We expect a Task to retain its execution history.

For example:

```
Task: Fix authentication bug

Attempt 1
Attempt 2
Attempt 3
Attempt 4 → Completed
```

Investigate CodeLoop to determine what "attempt" means there and what information is actually persisted.

Investigate Pithagoras's existing session/event/history persistence and determine whether Tasks could reuse it.

Do not design a detailed database schema yet.

---

# 8. Reuse Pithagoras wherever possible

A major goal is to extend Pithagoras rather than rewrite its agent infrastructure.

Investigate the existing Pithagoras implementation for:

* Home/filesystem navigation
* folder/workspace handling
* chat/session management
* Pi agent integration
* server-side execution
* event streaming
* persistent sessions
* background execution, if present
* UI navigation/state
* persistence/database/storage
* project/workspace configuration
* instruction/context handling

Identify which existing pieces can be reused directly for Projects and Tasks.

---

# 9. What I want from your investigation

Do NOT produce a detailed implementation specification yet.

Instead produce a **rough architectural/product plan** answering:

### A. What are we building?

Describe the resulting application at a conceptual level, including the relationship between:

* Home
* Projects
* Filesystem
* Chats
* Tasks
* Project Settings

### B. What new concepts are required?

For example:

* Project
* Task
* Task status
* Project settings
* Task execution/history

Only include concepts that the source investigation supports.

### C. What already exists in Pithagoras?

Map the desired functionality onto actual existing Pithagoras components.

### D. What can be reused?

Identify existing Pithagoras functionality that should remain underneath the new Project/Task layer.

### E. What needs to change?

Give a high-level list of frontend, backend, persistence, navigation, and agent-execution changes.

### F. What is uncertain?

Explicitly call out anything that requires a design decision or further investigation.

### G. Suggested implementation phases

Give a rough sequence, adjusted based on your findings. A possible starting point is:

1. Project representation/navigation alongside existing filesystem
2. Project settings
3. Task model/list/detail UI
4. Task execution
5. Completion/retry behavior
6. Project-specific task instructions

Do not assume this ordering is correct without examining the code.

---

# Important constraints

Do not invent details about CodeLoop if you cannot access its source.

Do not invent details about Pithagoras based solely on its README or screenshots when the source code can answer the question.

When describing existing behavior, cite the relevant files/classes/functions so another developer can verify your findings.

Avoid prematurely designing:

* database schemas
* API endpoints
* exact UI layouts
* exact React component hierarchy
* exact task state machines
* prompt formats
* retry algorithms

Those will be designed after we understand the existing architecture.

The purpose of this investigation is to establish a **shared high-level understanding of what we're trying to build and how the existing Pithagoras architecture relates to it**, while leaving implementation details for the next planning phase.
