# Pithagoras — Source-Grounded Architecture Overview

An architectural reference for planning future extensions (Projects / autonomous Tasks).
Every claim below is traced to actual source. Three markers are used throughout:

- **OBSERVED** — what the code does, read directly from source.
- **INFERENCE** — a reasonable conclusion drawn from observed behavior.
- **UNKNOWN** — not determinable from the code; flagged where it matters.

---

## 1. Overall Architecture

Pithagoras ("the portal") is a **web front end for the `pi` coding agent** (`@earendil-works/pi-coding-agent`). It is a TypeScript monorepo (npm workspaces: `server`, `web`, `docs`) with a single long-running Node server and a React SPA.

```
Browser ──SSE (cursor replay + tail)──▶ Express server (port 4100 default)
                                            │
                          ├─ host executor: pi runs IN-PROCESS via SDK (SdkPiClient)
                          └─ container executor: pi runs in a Docker container (PiRpcClient, JSONL/RPC)
                                            │
                    SQLite (DATA_DIR/portal.db, WAL) ← events log + session rows
                                            │
                     filesystem: WORKSPACE_ROOT (projects/folders) + AGENT_HOME (agent identity)
```

### Major components

| Layer | Tech | Key files |
|---|---|---|
| Entry / process control | Node ESM | `server/src/index.ts` — locks the data dir, rewrites `process.argv[1]` to pi's CLI so an extension that launches pi can't accidentally launch a second server |
| HTTP API + routing | Express 5 | `server/src/server.ts` (1470 lines) — all REST + SSE routes |
| Session / execution engine | Custom class | `server/src/session-manager.ts` (`SessionManager`, extends `EventEmitter`) — the heart; orchestrates pi per session |
| pi execution (executors) | SDK + docker | `server/src/executors/index.ts` (`HostExecutor`, `ContainerExecutor`), `server/src/pi/sdk-client.ts` (`SdkPiClient`), `server/src/pi/rpc-client.ts` (`PiRpcClient`), `server/src/pi/types.ts` (`PiClient` interface) |
| Persistence | better-sqlite3 | `server/src/db.ts` — schema + all SQL |
| Filesystem model | node:fs | `server/src/workspaces.ts`, `server/src/projects.ts`, `server/src/agent-home.ts`, `server/src/slug.ts` |
| Background jobs / process scan | node:/proc | `server/src/background.ts` (Linux/host only) |
| Orphan recovery | — | `server/src/db.ts` (`markOrphanedSessionsInterrupted`), called from `SessionManager.recoverOrphans()` |
| Frontend | React 18 + react-router-dom 7 + Vite | `web/src/App.tsx` (routing), `web/src/components/*`, `web/src/api.ts`, `web/src/live-events.ts` |

### Communication between frontend and backend

- **REST** (`web/src/api.ts` → `server/src/server.ts`): CRUD for sessions, settings, tools, channels, etc. Most return JSON immediately.
- **Server-Sent Events (SSE)**: `/GET /api/sessions/:id/events` opens a stream. The browser connects with `?since=<last seq>`; the server replays stored history from a cursor, then tails live events. Heartbeat every 25s; on close, listeners are removed. This is what makes runs "owned by the server, not the tab" — reconnecting replays exactly what was missed.
- **Polling** (`web/src/poll.ts`, `pollWhileVisible`): the session list and places are polled every ~30s while visible, as a fallback/catch-up beside SSE.
- All events pi emits are **appended to a durable `events` table**; the SSE layer reads from it. This append-log is the central nervous system.

**INFERENCE:** The design deliberately separates *submitting* a prompt (returns as soon as pi accepts it) from *execution* (continues server-side). The browser never drives pi turn-by-turn.

---

## 2. Home and Filesystem / Workspace Model

This is the core of the existing experience and the key constraint for any extension: **Pithagoras is fundamentally folder-grounded, and chats run inside a real filesystem path.**

### Concepts (all OBSERVED)

- **Home** — the agent's own fixed directory: `server/src/agent-home.ts` `agentHomePath()` = `$AGENT_HOME || $DATA_DIR/agent-home`. Contains the agent's identity/memory files (SOUL.md, PrimaryUser.md, MEMORY.md). It is *outside* the workspace root by design. Represented in the UI as `home` in the "places" model.
- **Workspace root** — `server/src/workspaces.ts` `workspaceRoot()` = `$WORKSPACE_ROOT || $WORKSPACES_DIR || /workspaces`. All user projects live directly under it. Configured via env (`WORKSPACES_DIR` in Compose, mounted at `/workspaces`).
- **Workspace / folder** — any directory *inside* the workspace root. Validated by `checkWorkspace()` which resolves symlinks (`realpathSync`) and refuses anything escaping the root or not a real directory. A bare name is treated as a project under the root.
- **Project** — an *existing* Pithagoras concept (not the future one this doc is about): a folder made on purpose under the workspace root, carrying its own instructions file. Managed by `server/src/projects.ts` and exposed at `/api/projects`. See §2.3 and §B.

### How paths are stored

- A chat's location is stored verbatim as an **absolute path** in the `sessions.workspace` column (`db.ts`, `sessions` table). Home is stored as the resolved `agentHomePath()`.
- No separate "project id" ties a chat to a project. Instead, `chatsIn(dir)` in `server.ts` matches by string prefix (`s.workspace === dir || s.workspace.startsWith(dir + sep)`); `workingIn()` follows real symlink resolution via `isWithin()`. A chat started in a subfolder still belongs to its project.

### How folders are selected / opened

- `POST /api/sessions` with `{ workspace }` creates a chat bound to that path (or Home if omitted). `checkWorkspace()` validates at creation.
- The frontend resolves the current folder through the **places** abstraction: `web/src/use-session-folders.ts` `usePlaces()` polls `GET /api/projects?bare=1` (returns `{ root, home, projects:[{name,path}] }`) plus the session list, and gathers chats into folders.
- Folder open/collapse, grouping ("folders" vs "list"), sort and manual order are kept **per-browser in `localStorage`** (`session-folders.ts`, `useFolderPrefs`, `useOpenFolders`). These are preferences, not server state.

### Can metadata be associated with a filesystem folder?

- **Yes, partially.** A project carries `AGENTS.md` (its instructions) written/read via `O_NOFOLLOW | O_NONBLOCK` (`readInstructions`/`writeInstructions` in `projects.ts`). That is the only first-class per-folder metadata today. Nothing else (tags, custom fields, dates) is attached to a folder by the portal.
- Session-level metadata (title, model, tool toggles, pinned, `pi_session_file`) lives in the DB row keyed by session id, *not* on the folder.

### UI/backend control points

- Backend: `workspaces.ts`, `projects.ts`, `agent-home.ts`, `slug.ts`.
- Frontend: `FolderTree.tsx` (renders chats grouped by folder), `Sidebar.tsx`, `SessionsPage.tsx`, `ProjectsPage.tsx`, `use-session-folders.ts`.

**INFERENCE:** Because binding is by literal path, any new "project/task" concept that wants to coexist must either reuse the `workspace` path field (e.g. point a task at a folder) or carry its own independent identity — there is no spare "project reference" column today.

---

## 3. Chats and Sessions

### Data model (OBSERVED — `db.ts`, `sessions` table)

```
sessions:
  id TEXT PK           nanoid(12)
  title TEXT
  workspace TEXT       absolute path (Home or inside WORKSPACE_ROOT)
  executor TEXT        'host' | 'container'
  status TEXT          idle|running|error|interrupted
  created_at/updated_at TEXT (datetime('now'))
  last_error TEXT
  provider/model/thinking_level TEXT   per-session overrides
  pinned INTEGER
  auto_title INTEGER
  pi_session_file TEXT   ← pi's own conversation file; used to RESUME
  kind TEXT            'task' (default) | 'agent' | 'routine'
  channel_slug/key TEXT
  routine_slug TEXT
  reloads INTEGER
```

- Every event pi emits is a row in the `events` table (`seq AUTOINCREMENT, session_id, type, payload TEXT, created_at`). This is the transcript; `messages` are reconstructed from events.
- `message_versions` stores alternate branches of the conversation (from edits/reverts), keeping only the differing tail of pi's file.
- Related tables: `canvases`, `channels`, `routines`, `people`, `questions`, `grants`, `notes`, `tool_rules`, `audit`, `open_subagents`, `settings`.

### Chat vs session vs logical conversation

- A **chat == a session row + its event log**. There is exactly one session per user-created chat.
- **Multiple sessions CAN belong to one logical object**, but only for scheduled/channel identities, not arbitrary chats:
  - Each **channel** (Telegram/Slack/Discord/webhook) links to agent sessions via `channel_slug`+`channel_key`; deleting a channel and recreating it under the same slug restores its conversations (`findChannelSession`, `resolveChannelSession`).
  - Each **routine** owns one session in a given workspace (`findRoutineSession`: one per slug+workspace, so moving a project back reclaims its history). Routines can also run `fresh_session` (a new session each run).
- The **"browser" session** (`POST /api/agent/sessions`) uses `channelSlug: "browser"` — a reserved slug — so browser-started chats group together on the Agent tab as genuine sessions with full transcript/replay.

### Creation / opening / resuming / deletion

- **Create**: `POST /api/sessions {workspace?, title?}` → `createSession()` in `server.ts`; starts in Home unless a workspace is given. Title becomes a placeholder until the first message names it (`titleFrom`).
- **Open**: navigate to `/s/:id`; frontend loads the session then connects SSE `?since=`.
- **Resume**: a session is resumed by relaunching pi with its stored `pi_session_file` (`startClient` passes `sessionFile: session.pi_session_file`; `SdkPiClient.create` opens it via `pi.SessionManager.open(...)` when the file exists). The file path is recorded the first time pi creates it.
- **Delete**: `DELETE /api/sessions/:id` → `sessions.discard(id)` (stops any running pi), `deleteSession(id)` (DB rows), `removeFiles(id)` (deletes `$SESSION_ROOT/<id>/`, which holds the transcript-on-disk — fixed so deleted chats no longer leak files).

### Streaming & rendering

- pi events flow: `SdkPiClient`/`PiRpcClient` → `SessionManager` client `"event"` handler → `record(type, payload)` → both `LiveEvents` snapshot store AND `appendEvent` (durable) → emitted on `session:${id}` → server.ts SSE `onEvent` writes to the browser.
- `LiveEvents` (`live-events.ts`) keeps **one current snapshot per message/tool/subagent** (not growing token lists). Canvas updates are coalesced (≤ every 250ms) to avoid flooding the stream.
- Live-only / ephemeral events use negative seqs (never move the replay cursor).

### Main trace: User → UI → backend → agent → output → UI

```
ComposerBar sends → POST /api/sessions/:id/prompt
  → server.ts prompt route → sessions.prompt(id, msg, opts)
  → submit() → ensureClient() → startClient() → executor.launch()
      host: SdkPiClient.create (in-process pi)
      container: PiRpcClient (docker run -i, RPC JSONL)
  → client.prompt(msg) → pi runs
  → client "event" → SessionManager.record → appendEvent + LiveEvents
  → emit session:id → SSE → web live-events.ts → Chat/ChatActivity renders
```

**Reusable infrastructure:** the `PiClient` interface (`pi/types.ts`), the `SessionManager` queue/steer mechanics, the `events` append-log + SSE replay, and `LiveEvents` snapshots are all executor-agnostic and would serve any agent that speaks the pi event protocol.

---

## 4. Pi / Agent Execution

### Process creation & execution modes (OBSERVED — `executors/index.ts`)

Two executors, selected by `EXECUTOR` env (`host` default / `container`):

- **`HostExecutor`** — runs pi **in-process** via the SDK (`SdkPiClient.create`). Works directly on the mounted repos at `/workspaces`. Fast, real git, full permissions = the portal's own permissions.
- **`ContainerExecutor`** — runs pi in a throwaway Docker container: `docker run -i --rm ... -v <workspace>:/workspace -v <sessionDir>:/sessions … PI_IMAGE pi --mode rpc --session-dir /sessions`. Capabilities dropped (`--cap-drop ALL`, `no-new-privileges`), memory/CPU/PID caps (`TASK_MEMORY_MB`/`TASK_CPUS`/`TASK_PIDS_LIMIT`). Container labelled `pithagoras.session=<id>` and `pithagoras.managed=true` so a crashed portal can find/reap it. Talks to pi over the RPC protocol (`PiRpcClient`).

### Config/executable selection, working directory, prompt delivery

- `executor.launch({ sessionId, workspacePath, provider, model, thinkingLevel, sessionFile, ... })`.
- Working directory: host = `opts.workspacePath` (the chat's folder); container = `/workspace` mount.
- Args: `pi --mode rpc --session-dir <dir> [--provider ..] [--model ..]` (`piArgs`).
- Provider credentials pass through env (`OPENROUTER_API_KEY`, etc.).
- **Prompt delivery**: `client.prompt(message, { voice, images, steer })`. `steer:true` delivers a mid-run message into the going run; otherwise it queues after. One message at a time into pi, in send order (the `sending`/`handed` gate in `submit()`).

### Session creation / resume

- Fresh run: no `sessionFile` → pi starts a new conversation.
- Resume: `sessionFile` set and file exists → `pi.SessionManager.open(file, dir, cwd)` reopens the exact prior conversation. Recorded in DB as `pi_session_file`.

### stdout/stderr/event handling

- `client.on("event", msg)` handles all pi events; `client.on("stderr")` captures stderr; `client.on("exit")` cleans up.
- Events drive status transitions: `agent_start`→running, `agent_settled`→idle (chosen over `agent_end` because of retries/compaction), `extension_error`, `extension_ui_request` (dialogs), `queue_update` (steering/follow-up lanes), model failures, subagent streams, etc.

### Termination / stop (OBSERVED — `SessionManager.abort`)

`POST /api/sessions/:id/abort` → `abort(id)`: gates concurrent sends, `whenHanded` waits for the in-flight prompt, drops queued waiting messages, `client.abort()`, settles any compaction, sets status idle + records `portal_status {aborted:true}`.

### Background execution (OBSERVED — `background.ts`)

- The portal discovers processes the *agent* left running in a workspace (background shells, servers, watchers, extension-started jobs). A process counts if it carries env `PITHAGORAS_AGENT=1` (the MARKER, which survives detachment/reparenting) and its cwd is inside a workspace. Grouped by Unix session id (`/proc` scan).
- **Linux + host executor only**; a container's processes aren't in this `/proc`. Output can be followed; tool calls attach to the chat as they go.

### Concurrent execution

- Per session: messages serialize into pi (one run at a time; extras queue or steer).
- Across sessions: each session has its own pi client/process; multiple chats can run simultaneously. `SessionManager` is an `EventEmitter` with `setMaxListeners(0)`.

### Cleanup / orphan handling (OBSERVED)

- On startup, `SessionManager.recoverOrphans()`: `markOrphanedSessionsInterrupted()` marks sessions that were running when the server died as `interrupted`; settles unanswered commands, detached subagents, and unsent prompts by reading what pi actually wrote vs. what the portal had queued (`settleOrphanedMessages`, `saidInFile`).
- Container cleanup: `executor.cleanup(sessionId)` removes the labeled container on exit.

### Application/server restart behavior

- Single-instance enforced by holding the data dir via a listening socket (`instance-lock.ts` `holdDataDir`) — a second server is refused; the first marks its chats interrupted on restart.
- Execution state is **only in memory** (`SessionManager.live` Map of live clients). Durable state is the DB (rows + event log + `pi_session_file`) and pi's own session files on disk. After restart, existing chats resume from their `pi_session_file`; brand-new runs start fresh.

**INFERENCE:** Because live execution state is in-memory, "autonomous work" must be resumable from durable state (DB row + a session/file) rather than assumed alive — the routine/session machinery already does exactly this.

---

## 5. Session / History Persistence

### Format & location (OBSERVED)

- **SQLite** at `$DATA_DIR/portal.db`, WAL mode (`db.ts` `getDb()`). Primary persistence.
- **Session files on disk**: `$SESSION_DIR (./data/sessions)/<sessionId>/` holds pi's conversation file and per-session artifacts. Removed by `removeSessionFiles`/`removeFiles`.
- **Images**: `$DATA_DIR/images/<sessionId>/` (named by random id, never rewritten).

### Structure & logical↔physical relationship

- Logical chat = one `sessions` row + many `events` rows (the transcript) + optional `canvases`/`message_versions`.
- pi's durable conversation is `pi_session_file` (inside the session dir). That single field is what lets a chat resume.

### Discovery of history

- `listSessions()` returns `kind='task'` sessions (pinned first, then `updated_at DESC`). `listAgentSessions()` (`kind='agent'`) and `listRoutineSessions()` similarly.
- Historical events fetched paginated: `GET /api/sessions/:id/events/before?before=&limit=` (max 3000; default 1200). Live replay uses `eventsSince` from a cursor. `REPLAY_EVENTS=1200` caps how far back a fresh load replays (a UX limit, not correctness — a reconnect with a cursor still gets everything missed).

### Resumption & display

- Displayed in `Chat`/`ChatActivity` from the SSE stream + initial snapshot; scrolling back loads older pages via `events/before`.
- Resume path already documented in §3/§4: relaunch with `pi_session_file`.

### Does history support multiple executions per logical object?

- **Yes, already.** Routine sessions are many executions under one routine identity (same workspace, ordered by created_at). Channel sessions share one agent across connections. `message_versions` stores multiple branches of a single conversation's history. So the "one logical object ↔ many executions" shape exists for routines/channels today.

---

## 6. Instructions & Context

### What is sent to Pi (OBSERVED)

- **pi's own system context** (~3.8k tokens fresh, per README): agent identity/memory (from Home: SOUL.md, PrimaryUser.md, MEMORY.md), tool schemas, a one-line listing of installed skills (bodies read lazily). This is pi's SDK-level context, constructed by `SdkPiClient`.
- **Project instructions**: a project's `AGENTS.md` is **read by pi itself when a chat starts in that folder** — there is no hand-off (`projects.ts` comment). The portal edits/reads the same file but does not inject it into the prompt.
- **Channel instructions**: appended to the agent's system prompt for messages arriving via that channel (`channels.instructions`).
- **Session initialization**: `startClient` builds launch options including `role` (picks which context files load), `toolsOff`, `browserNow`, `whoNow`, `enforceTaint`, `routineTools`/`routineSlug` for agent/routine kinds.
- **Working-directory context**: pi runs with cwd = the workspace folder, so it sees that directory's files/AGENTS.md naturally.
- **Notes** (`notes` table): things the portal said into a conversation while nobody was watching (routine reports, relayed answers) are folded into context the next time the chat runs, to avoid "why did you say that?".

### Where additional workspace-specific instructions could be incorporated

- Directly as an **`AGENTS.md`** in the target folder (already read by pi) — the natural, already-supported seam.
- Via **channel/instructions-style injection** if building a new prompt-building layer.
- Via **`notes`** for standing context to replay into a future run.
- Through **session-level settings** (`provider/model/thinking_level` overrides) already carried on the row.

**INFERENCE:** There is currently no portal-side "system prompt builder" that assembles extra instructions and passes them to pi per-run — context comes from Home files, the working folder's AGENTS.md, and channel metadata. A new autonomous-task feature would likely need to introduce its own instruction-injection path (or standardize on a folder's AGENTS.md).

---

## 7. Frontend / Navigation Architecture

### Routing (OBSERVED — `web/src/App.tsx`)

react-router-dom 7 `Routes` inside a `Shell`:

| Path | View |
|---|---|
| `/` | home (chat view of selected session) |
| `/sessions` | Sessions page (all chats, grouped by folder) |
| `/projects` | Projects page (existing projects concept) |
| `/agent` | Agent page (channel/browser sessions) |
| `/routines` | Routines page |
| `/browser`, `/memory`, `/audit` | Add-on pages |
| `/s/:sessionId` [`,`view`] | Open a chat (`,settings`, `,settings/:tab`) |
| `/settings` [`/:tab`] | Settings |

Everything renders inside `Shell`, which owns global state (sessions, settings, executor, auth) and hosts the `Sidebar`.

### Navigation between areas

- **Sidebar** (`components/Sidebar.tsx`): top-level rail buttons navigate (`onNavigate` → `navigate(/<to>)`): Home implicitly via `/`, plus **Projects**, Sessions, Agent, Routines, Browser, Memory, Audit. Below the rail, chats are shown either **grouped by folder** (`FolderTree`, only when projects exist) or as a flat **Recents** list.
- The **currently selected folder/workspace** is represented by the open folder(s) in `FolderTree` (per-browser open state) and by each session's `workspace` path; **the current chat** is `/s/:sessionId`.

### Where an additional top-level concept could fit

- The nav is a horizontal set of `Destination` entries (`RailButton`/`NavItem`) fed by a fixed array in `Sidebar.tsx`, and each maps to a `/Route` + `Shell view="..."`. Adding a new top-level area = add a destination entry + a route + a page component + a `Shell view` type. The existing tabs are the established insertion pattern.
- Chats themselves are always grounded in a folder (Home/project) via `usePlaces`/`FolderTree`; a new concept must decide whether it plugs into that folder grouping or sits beside it as another rail section.

---

## 8. Persistence & Runtime State

| Mechanism | Stores | Survives restart? |
|---|---|---|
| `DATA_DIR/portal.db` (SQLite WAL) | sessions, events log, canvases, message_versions, channels, routines, people, questions, grants, notes, tool_rules, audit, settings, open_subagents, signed_out | **Yes** |
| `$SESSION_DIR/<id>/` | pi's conversation file, on-disk transcript artifacts | **Yes** (until the chat is deleted via `removeFiles`) |
| `$DATA_DIR/images/<id>/` | pictures sent with messages | **Yes** |
| `pi_session_file` (column) | path to pi's durable conversation | **Yes** (in DB); this is the resume handle |
| Config env vars | EXECUTOR, WORKSPACES_DIR/WORKSPACE_ROOT, AGENT_HOME, PORTAL_DATA_DIR, provider keys, task caps | **Yes** (deployment) |
| `settings` table | portal-wide defaults (model, thinkingLevel, keepRecentTokens, context limits, report-to…) applied to every new session | **Yes** |
| Per-session overrides | provider/model/thinking_level/pinned/draft/tools on the session row | **Yes** |
| `localStorage` (browser) | folder grouping/sort/order, open-folder state, known places, sidebar collapsed, session drafts, settings cache, confirm-prefs | Browser-only; **not server** |
| In-memory `SessionManager.live` | live Pi clients per running session | **No** (rebuilt on launch) |
| Background-job scan (`background.ts` `tracked` Map) | discovered agent-launched processes | **No** (re-scanned on boot; finished jobs kept ≤30 min) |
| Data-dir lock socket | single-instance enforcement | **No** |

### Path-associated state (the important part for extensions)

- **Every chat carries a real absolute path** (`sessions.workspace`). This is the single place application state is bound to the filesystem.
- **Projects** are folders under the workspace root with an `AGENTS.md`; chat counts/last-active are derived by matching paths against the project dir (including subfolders and symlinks).
- **Home** is a special path outside the root.
- No other app state (settings, tools, channels, routines, audit) is tied to a path except routines, which record a `workspace` they run in (and can be switched if the folder vanishes).

---

## 9. Important Execution Paths (source-level)

### Open filesystem / workspace — `UI → backend → path/workspace state`
```
User opens/selects a folder (Sidebar/FolderTree) or "New"
  → frontend usePlaces() polls GET /api/projects?bare=1
  → POST /api/workspaces {name} → slugify(name) → mkdir(WORKSPACE_ROOT/name)  [workspaces.ts]
  → returns { name, path, isGit }
  → session created bound to that path via checkWorkspace() (resolves symlinks, bounds to root)
```
Key: `server.ts` workspaces routes, `workspaces.ts` `checkWorkspace`/`workspaceRoot`, `slug.ts` `slugify`.

### Create / open Chat — `UI → backend → persistence/session → agent`
```
POST /api/sessions {workspace?, title?}
  → where = workspace ? checkWorkspace(workspace) : {path: agentHome()}
  → createSession({ id: nanoid(12), title, workspace: resolved, executor, auto_title })   [db.ts]
  → res.json(toApi(getSession(id)))
Open: GET /api/sessions/:id + SSE /api/sessions/:id/events?since=
  → history replayed from cursor; live events tail
```

### Start agent — `UI → backend → process/session → Pi`
```
POST /api/sessions/:id/prompt {message, images?, voice?, steer?}
  → sessions.prompt(id, msg, opts)  [session-manager.ts:1143]
  → promptNow → submit() → ensureClient() → startClient()  [session-manager.ts:866]
  → buildExecutor(EXECUTOR_KIND) .launch({ sessionId, workspacePath, provider, model, sessionFile, ... })
        host   → SdkPiClient.create({ cwd: workspacePath, sessionDir, sessionFile, ... })
        container → spawn("docker", ["run","-i",...]) → new PiRpcClient(child)
  → client.prompt(message, {...}) → pi runs
  → returns { ok:true, status:"running" } as soon as pi accepts
```

### Agent activity — `Pi → backend/event mechanism → frontend`
```
pi event → SdkPiClient/PiRpcClient emits "event"
  → SessionManager client handler: rememberSessionFile, noteCall, queue_update, model failures, portal_failed, etc.
  → this.record(sessionId, type, payload)  [session-manager.ts:419]
       ├─ LiveEvents (snapshot) 
       ├─ appendEvent() → durable events row
       └─ emit(`session:${sessionId}`, row)
  → server.ts SSE onEvent → res.write(`id: <seq>\ndata: <json>`)
  → web live-events.ts / ChatActivity → render
Canvas updates coalesced via canvasEvents (≤250ms).
```

### Stop agent — `UI → backend → process/session cleanup`
```
POST /api/sessions/:id/abort
  → sessions.abort(id)  [session-manager.ts:2245]
  → gate sends, whenHanded(), dropWaiting(), client.abort(), settleCompaction()
  → updateSession(status idle) + record portal_status {aborted}
  → client exit handler: live.delete, stream.clear, forgetPi, executor.cleanup (container rm -f)
```

### Resume session — `UI → backend → persisted session → Pi`
```
Open a past chat → ensureClient/startClient
  → reads session.pi_session_file (from DB)
  → launch({ sessionFile })
        host → pi.SessionManager.open(sessionFile, sessionDir, cwd)   [sdk-client.ts:482]
        container → docker run -v sessionDir:/sessions … pi --mode rpc --session-dir /sessions
  → pi reopens the exact prior conversation; SSE replays remaining events
```

---

## A. Architecture Summary

Pithagoras is a **server-owned, append-log-backed agent platform**. The Express server runs `pi` either in-process (host executor) or in a Docker container (container executor), one pi instance per active session. Every pi event is appended to a durable SQLite `events` log and fanned out to browsers over SSE with cursor-based replay, so runs survive tab refreshes and server restarts. Chats are bound to real filesystem paths (`sessions.workspace`): Home (the agent's identity dir) or any folder under the workspace root. Projects already exist as folders-with-AGENTS.md under the root. State is split cleanly between durable (SQLite + pi session files + folder AGENTS.md) and transient (in-memory live clients, background-job scan).

## B. Existing Concepts

| Concern | Existing concept |
|---|---|
| Filesystem / workspace | `WORKSPACE_ROOT`/`WORKSPACES_DIR`, `checkWorkspace`, chats bound by absolute `workspace` path |
| Project / folder metadata | **Projects** already exist: folders under root with an editable `AGENTS.md` (`projects.ts`); chat counts derived by path matching |
| Home | `$AGENT_HOME`/`DATA_DIR/agent-home`, agent identity/memory files |
| Chats | `sessions` rows (`kind='task'`) + `events` transcript |
| Sessions (logical identity) | `kind='agent'` (channel/browser) and `kind='routine'` (scheduled) — multiple physical sessions can share one logical identity |
| Agent execution | `SessionManager` + `Executor` interface (`HostExecutor`/`ContainerExecutor`) + `PiClient` (`SdkPiClient`/`PiRpcClient`) |
| Instructions / context | pi SDK context from Home files; per-folder `AGENTS.md` read by pi; channel instructions; `notes` replayed into context |

## C. Reusable Infrastructure

- **`PiClient` interface + both implementations** — any new agent that speaks the pi event protocol plugs in unchanged.
- **`SessionManager`** — per-session lifecycle, in/pi message queue, steering, compaction gating, abort, orphan recovery, extension-dialog handling, drafts.
- **`events` table + SSE cursor replay** — durable, reconnectable history for any execution type.
- **`LiveEvents` snapshots** — efficient rendering of current state.
- **Routine machinery** — scheduled runs, one session per place, reporting via channels, audit — already implements "autonomous, goal-oriented, report-back" execution against a folder.
- **Background-job discovery** (`background.ts`) — tracking long-lived agent-launched processes per workspace.
- **Places/FolderTree grouping** — renders anything folder-grounded without new UI plumbing.

## D. Likely Modification Areas

- **Persistence**: a new independent "project/task" entity would need its own storage (a new table) since binding today is purely by filesystem path; or reuse `workspace` + extend `sessions.kind`.
- **Backend/routing**: new REST routes + a `SessionManager`-level coordinator for multi-step autonomous work beyond a single prompt cycle.
- **Navigation**: a new rail entry + route + page in `Sidebar.tsx`/`App.tsx` (the established pattern used by Projects/Routines).
- **Session/execution**: possibly a new executor or a wrapper around `SdkPiClient` that drives repeated autonomous steps, plus durable task state so it survives restart like routines do.
- **Instructions/context**: an injection path for task-specific system context (currently only Home files, folder AGENTS.md, channel notes exist).

## E. Architectural Gaps

- **No first-class project/task model independent of the filesystem.** "Projects" today are just folders with AGENTS.md; there is no separate notion of a goal, plan, subtasks, or status that isn't a real directory.
- **No portal-side instruction/context assembler.** Context is assembled by pi from files/role; the portal does not build a composite system prompt it controls.
- **No durable multi-run "owner" abstraction besides routines/channels.** Arbitrary "one logical object with many executions" exists only for those two kinds.
- **Background process tracking is Linux/host-only** and knows only about MARKER'd agent processes — not portable to container mode or other OSes.
- **No cross-session coordination** beyond sharing a folder; sessions are isolated.

## F. Unresolved Questions (not answerable from code alone)

1. Should new Tasks be grounded in a real folder (reusing `workspace`/AGENTS.md) or be pure in-memory/app-level entities with no directory? This determines whether the filesystem model needs extending at all.
2. How should existing "Projects" (folders) relate to the future "Projects" (goal-oriented entities)? Are they the same thing to be enriched, or distinct?
3. What authN/authZ model applies to autonomous tasks (approvals, grants, roles) given pi has *no* approval prompts by design and runs with process permissions?
4. Where does the boundary of "one run" end for unattended execution — timeouts, budgets, token caps (some exist: `TASK_*`, context limits), and who decides completion?
5. How must the SQLite schema migrate without losing existing transcripts, and is WAL + append-log sufficient for concurrent task writes?
6. For container mode, how are persistent task state and multiple containers orchestrated/reconciled across restarts (only per-session container labels exist today)?
