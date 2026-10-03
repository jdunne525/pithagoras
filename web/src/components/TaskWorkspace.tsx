import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { StatusDot, type TaskStatus } from "./StatusDot";
import { ThinkingBlock } from "./ChatActivity";
import { confirmDialog } from "./ConfirmDialog";
import { isEnter } from "../shortcuts";
import { formatRelative, t } from "../i18n";
import { api, type Task, type TaskAttempt } from "../api";
import { Streamdown } from "streamdown";
import { useSessionEvents } from "../use-session-events";
import { TaskTranscript } from "./TaskTranscript";
import { LuArrowUp, LuChevronLeft, LuChevronRight, LuFileText, LuGripVertical, LuListChecks, LuPen, LuPlay, LuPlus, LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";

/**
 * A task in the workspace is not a session: it has no events, so what a task
 * did is mocked here instead of fetched. Each task's history is built as a list
 * of attempts, and every attempt a short run of messages — a prompt, some
 * thinking, a tool call, an answer — so the whole thing reads like the chat it
 * stands in for. Nothing here touches the network.
 */

type MockKind = "user" | "assistant" | "thinking" | "tool";

interface MockMsg {
  id: string;
  kind: MockKind;
  /** For user and assistant messages: the words. For a tool: unused. */
  text?: string;
  /** For a thinking step: the reasoning shown when opened. */
  thinking?: string;
  /** For a tool call: what ran, and what it said. */
  tool?: { name: string; detail: string; output: string };
  /** When it happened, as a timestamp in milliseconds. */
  at: number;
}

interface MockTask {
  id: string;
  text: string;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  failedAt?: string;
  completedAt?: string;
  /** One array of messages per attempt that actually ran. Seeded lazily, kept
      once a task is open so anything typed to resume stays put. */
  msgs?: MockMsg[][];
}

let nextId = 100;
const mid = () => `m${nextId++}`;

/**
 * A fixed seed from a string, so the same task always shows the same steps — a
 * task you come back to keeps reading the way you left it, rather than
 * reshuffling on every glance.
 */
const seedOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const pick = <T,>(arr: readonly T[], key: string, i: number): T => arr[seedOf(`${key}:${i}`) % arr.length];

const THINKING = [
  "Reading the workspace and what was done before starting again.",
  "Planning the steps this attempt should take, one at a time.",
  "Deciding which tool fits the step still to do.",
  "Checking the last result before moving on.",
];
const TOOLS: { name: string; detail: string; output: string }[] = [
  { name: "read", detail: "src/index.ts", output: "export const pi = true;\n// the workspace entry point\n" },
  { name: "bash", detail: "grep -rn working src", output: "src/loop.ts:12:    // keep working until asked to stop\n" },
  { name: "edit", detail: "src/index.ts", output: "Updated the one line that was out of date." },
  { name: "find", detail: "*.md", output: "AGENTS.md\nREADME.md\nplans/spec.md" },
];
const ANSWERS = [
  "Noted — I will carry that through the rest of this attempt.",
  "That lines up with what I found. Moving on to the next step.",
  "Understood. Adjusting the plan to match.",
  "Got it — keeping that in mind as I go.",
];
const REPLY = (prompt: string) =>
  pick(
    [
      `Thanks — "${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}" noted. Continuing from here.`,
      "Noted. Picking up where the last attempt left off.",
      "Understood — I will fold that into the work now.",
    ],
    prompt,
    Date.now(),
  );

/**
 * What a task looked like across its attempts: a prompt first, then a little
 * thinking, a tool call, and an answer, repeated per attempt. The final attempt
 * ends in the task's actual outcome, so a stopped or failed task reads as one.
 */
const seedMessages = (task: MockTask): MockMsg[][] => {
  const base = Math.max(0, new Date(task.startedAt ?? Date.now()).getTime() - 6 * 60_000);
  const attempts = Math.min(task.attempts, task.maxAttempts);
  const out: MockMsg[][] = [];
  for (let a = 0; a < attempts; a++) {
    const k = `${task.id}:${a}`;
    const at = (i: number) => base + a * 5 * 60_000 + i * 45_000;
    const attempt: MockMsg[] = [];
    if (a === 0) {
      attempt.push({ id: mid(), kind: "user", text: task.text, at: at(0) });
    }
    attempt.push({ id: mid(), kind: "thinking", thinking: pick(THINKING, k, 0), at: at(1) });
    attempt.push({
      id: mid(),
      kind: "tool",
      tool: { ...pick(TOOLS, k, a), output: pick([pick(TOOLS, k, a).output, "Done with that step."], k, a + 3) },
      at: at(2),
    });
    attempt.push({ id: mid(), kind: "assistant", text: pick(ANSWERS, k, a + 1), at: at(3) });
    // An attempt that ended, whether stopped or failed, leaves a short note.
    if (task.status === "stopped" || task.status === "failed") {
      attempt.push({
        id: mid(),
        kind: "assistant",
        text: task.status === "stopped" ? "Stopped here — the run was halted before finishing." : "Hit a problem and could not continue this time.",
        at: at(4),
      });
    }
    out.push(attempt);
  }
  return out;
};

/** A real Task row from the backend, mapped into the shape the queue needs.
    `text` here holds the title; the bottom panel still renders mock history,
    because execution is a later phase. Unbounded attempts map to Infinity so
    the "no attempts left" checks simply never fire. */
const mapTask = (row: Task): MockTask => ({
  id: row.id,
  text: row.title,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.max_attempts ?? Infinity,
  startedAt: row.started_at ? normDate(row.started_at) : undefined,
  completedAt: row.completed_at ? normDate(row.completed_at) : undefined,
  failedAt:
    row.status === "failed" && row.completed_at ? normDate(row.completed_at) : undefined,
});
/** Server stores UTC as "YYYY-MM-DD HH:MM:SS"; parse it as that, not local. */
const normDate = (s: string): string => s.replace(" ", "T");

const TABS = ["actions", "completed"] as const;
type Tab = (typeof TABS)[number];

/** A short word for an attempt's outcome, used in the Runs chips. */
const statusLabel = (status: TaskAttempt["status"]): string => {
  switch (status) {
    case "running":
      return t("Running");
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "stopped":
      return t("Stopped");
    default:
      return t("Pending");
  }
};

export function TaskWorkspace({ projectName, onBack }: { projectName: string; onBack?: () => void }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<MockTask[]>([]);
  const [tab, setTab] = useState<Tab>("actions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [preview, setPreview] = useState<MockTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load this project's queue from the backend. Runs on open and again if the
  // project changes under us (e.g. navigating between projects).
  useEffect(() => {
    let cancelled = false;
    setRows([]);
    setError(null);
    api.listTasks(projectName)
      .then((tasks) => {
        if (cancelled) return;
        setRows(tasks.map(mapTask));
      })
      .catch(() => { if (!cancelled) setError("Could not load this project's tasks."); });
    return () => { cancelled = true; };
  }, [projectName]);

  // Choose the first active task once the list has loaded and none is picked,
  // so an empty workspace does not open on nothing.
  useEffect(() => {
    if (rows.length && selectedId == null) {
      const next = rows.find((x) => x.status !== "completed");
      setSelectedId(next?.id ?? rows[rows.length - 1].id);
    }
  }, [rows]);

  const running = rows.some((x) => x.status === "running");
  const selected = useMemo(() => rows.find((x) => x.id === selectedId) ?? null, [rows, selectedId]);

  // --- Phase 3: the bottom panel drives a real autonomous run. Each Task has
  // several attempts; this tracks them and renders the active one from its own
  // session, streamed live. A new attempt is created on Start (or Re-run,
  // which is Phase 5); stopping settles the current one and unwinds the run.
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [loadingAttempts, setLoadingAttempts] = useState(false);

  const activeAttempt = useMemo(
    () => attempts.find((a) => a.id === activeAttemptId) ?? attempts.at(-1) ?? null,
    [attempts, activeAttemptId]
  );
  const activeSessionId = activeAttempt?.session_id ?? null;
  // Live events for the active session: replays history, then streams as it
  // runs. `running` here is whether the session is actively working, distinct
  // from the Task status but equal to it while a run is open.
  const { events, running: sessionRunning } = useSessionEvents(activeSessionId);

  useEffect(() => {
    if (!projectName || !selected) return;
    let cancelled = false;
    setLoadingAttempts(true);
    api.getTaskAttempts(projectName, selected.id)
      .then((list) => {
        if (cancelled) return;
        setAttempts(list);
        // Select the newest run so a Task with history opens on its latest attempt.
        const latest = [...list].sort((a, b) => a.attempt_number - b.attempt_number).at(-1);
        setActiveAttemptId(latest?.id ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingAttempts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, selected]);

  // When a run stops streaming, the backend has settled the attempt (a natural
  // end becomes failed; a stop becomes stopped) and reset the Task. Reconcile
  // our local copies so the status and chips stay honest without polling.
  useEffect(() => {
    if (!activeSessionId || sessionRunning || !selected || selected.status !== "running") return;
    api.listTasks(projectName).then((tasks) => setRows(tasks.map(mapTask)));
    api.getTaskAttempts(projectName, selected.id).then(setAttempts);
  }, [sessionRunning, activeSessionId]);

  const start = async (id: string) => {
    try {
      const { attempt } = await api.startTask(projectName, id);
      setAttempts((prev) => [...prev, attempt]);
      setActiveAttemptId(attempt.id);
    } catch {
      setError("Could not start the task.");
    }
  };

  const stop = async () => {
    if (!selected) return;
    try {
      await api.stopTask(projectName, selected.id);
    } catch {
      setError("Could not stop the task.");
    }
  };

  // Continuing an open conversation sends to the running session without
  // creating a new attempt: a normal message, not a new run.
  const sendResume = () => {
    const text = resumeText.trim();
    if (!text || !activeSessionId) return;
    api.prompt(activeSessionId, text).catch(() => setError("Could not send the message."));
    setResumeText("");
    // Keep the composer open so a follow-up can be sent in the same breath.
  };

  const addTask = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text) return;
    try {
      const created = await api.createTask(projectName, text);
      setRows((prev) => [...prev, mapTask(created)]);
      setTab("actions");
    } catch {
      setError("Could not create the task.");
    }
    setAdding(false);
    setDraft("");
  }, [projectName]);

  // Move one task before another, then persist the new order to the server, which
  // owns the queue. This really reorders — unlike the mock, which would not move.
  const moveTask = useCallback(async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setRows((prev) => {
      const arr = [...prev];
      const from = arr.findIndex((x) => x.id === fromId);
      const to = arr.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to >= 0 ? to : arr.length, 0, moved);
      void api.setTaskOrder(projectName, arr.map((x) => x.id));
      return arr;
    });
  }, [projectName]);

  const rename = useCallback(async (id: string, title: string) => {
    const text = title.trim();
    if (!text) return;
    try {
      await api.editTask(projectName, id, { title: text });
      setRows((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)));
    } catch {
      setError("Could not save the change.");
    }
  }, [projectName]);

  const remove = async (task: MockTask) => {
    if (!(await confirmDialog({ title: t("Delete \"{name}\"?", { name: task.text }), message: t("It is gone from this list forever."), confirmLabel: t("Delete"), danger: true }))) return;
    try {
      await api.deleteTask(projectName, task.id);
      setRows((prev) => prev.filter((x) => x.id !== task.id));
      if (selectedId === task.id) setSelectedId(null);
    } catch {
      setError("Could not delete the task.");
    }
  };

  // Continuing a session drives the agent — Phase 3. The composer stays, but
  // sending does nothing until it is wired up.


  // One list filtered by the open tab: Actions shows everything not completed,
  // Completed shows only finished Tasks.
  const actions = tab === "actions" ? rows.filter((x) => x.status !== "completed") : rows.filter((x) => x.status === "completed");
  const ago = (iso?: string) => (iso ? formatRelative((Date.now() - new Date(iso).getTime()) / 60000, "minute") : null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* The top is short: where you pick a task. Below it, the conversation fills the rest. */}
      <div className="flex shrink-0 flex-col border-b border-line">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <button
            onClick={onBack ?? (() => navigate("/projects"))}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-fg-subtle hover:text-fg"
            title={t("Back to projects")}
            aria-label={t("Back to projects")}
          >
            <LuChevronLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("Back to projects")}</span>
          </button>
          <LuListChecks className="h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-fg">{t("Tasks")}</span>
            <span className="ml-1 truncate text-xs text-fg-faint">{projectName}</span>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-sm font-medium text-white transition hover:bg-accent/90"
          >
            <LuPlus className="h-3.5 w-3.5" />
            {t("New task")}
          </button>
        </div>

        <div className="flex items-center px-3 pb-2 text-xs">
          <div className="inline-flex items-center rounded-lg bg-raised/60 p-0.5">
            {TABS.map((label) => {
              const n = label === "actions" ? rows.filter((x) => x.status !== "completed").length : rows.filter((x) => x.status === "completed").length;
              return (
                <button
                  key={label}
                  onClick={() => setTab(label)}
                  aria-current={tab === label}
                  className={`rounded-md px-2.5 py-1 font-medium transition ${tab === label ? "bg-fg/10 text-fg" : "text-fg-subtle hover:text-fg-muted"}`}
                >
                  {t(label === "actions" ? "Actions" : "Completed")}
                  <span className="ml-1.5 text-[10px] tabular-nums text-fg-faint">{n}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="max-h-[40%] min-h-0 overflow-y-auto px-2 pb-2">
          {error ? (
            <p className="py-4 text-center text-xs text-warn">{error}</p>
          ) : rows.length === 0 && !adding ? (
            <EmptyState primary />
          ) : (
            <ul className="space-y-0.5 pt-0.5">
              {adding && (
                <li className="mb-1 rounded-xl border border-line bg-raised p-2">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => isEnter(e) && draft.trim() && addTask(draft.trim())}
                    placeholder={t("Write what you want done")}
                    aria-label={t("Write what you want done")}
                    className="w-full rounded px-2 py-1 text-sm outline-none placeholder:text-fg-faint"
                  />
                  <div className="mt-1 flex justify-end gap-1.5">
                    <button onClick={() => { setAdding(false); setDraft(""); }} className="rounded px-2.5 py-1 text-xs text-fg-subtle hover:bg-fg/5">
                      {t("Cancel")}
                    </button>
                    <button
                      onClick={() => { if (draft.trim()) addTask(draft.trim()); }}
                      disabled={!draft.trim()}
                      className="rounded bg-accent px-2.5 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {t("Create task")}
                    </button>
                  </div>
                </li>
              )}
              {actions.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  selected={selectedId === task.id}
                  dragging={dragId === task.id}
                  ago={ago(lastOf(task))}
                  onSelect={() => { setSelectedId(task.id); setTab("actions"); setComposerOpen(false); }}
                  onMove={(toId) => moveTask(task.id, toId)}
                  onDragStart={() => setDragId(task.id)}
                  onDragEnd={() => setDragId(null)}
                  onOpenSession={() => setPreview(task)}
                  onStart={() => task.status === "running" ? stop() : start(task.id)}
                  onRename={(title) => rename(task.id, title)}
                  onRemove={() => remove(task)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* The conversation fills what is left of the page. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!selected ? (
          <EmptyState />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <StatusDot taskStatus={selected.status} bare />
              <p className="min-w-0 flex-1 truncate text-sm text-fg">{selected.text}</p>
              {selected.attempts > 0 && (
                <span className="shrink-0 hidden items-center gap-1 rounded-full bg-fg/5 px-2 py-0.5 text-[11px] text-fg-subtle sm:inline-flex" title={t("{attempts} attempts, up to {max}", { attempts: selected.attempts, max: selected.maxAttempts })}>
                  <LuRotateCcw className="h-3 w-3" />
                  {selected.attempts}/{selected.maxAttempts}
                </span>
              )}
              <RunControls
                task={selected}
                onStart={() => selected.status === "running" ? stop() : start(selected.id)}
              />
            </div>

            {/* The conversation fills what is left of the page. It renders one
                attempt's real transcript, streamed from its session, with the
                previous runs shown as selectable chips above it. */}
            {loadingAttempts ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <span className="text-fg-muted">{t("Loading history…")}</span>
              </div>
            ) : (
              <>
                {attempts.length > 0 && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                      {t("Runs")}
                    </span>
                    {attempts.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setActiveAttemptId(a.id)}
                        aria-current={a.id === activeAttemptId}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
                          a.id === activeAttemptId
                            ? "border-accent/60 bg-accent/10 text-fg"
                            : "border-line text-fg-subtle hover:text-fg"
                        }`}
                      >
                        <StatusDot taskStatus={a.status} bare />
                        #{a.attempt_number} · {statusLabel(a.status)}
                      </button>
                    ))}
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {activeSessionId ? (
                    <TaskTranscript sessionId={activeSessionId} events={events} running={sessionRunning} />
                  ) : (
                    <div className="flex h-full items-center justify-center py-16">
                      <span className="text-fg-muted">{t("This run has no activity yet.")}</span>
                    </div>
                  )}
                </div>

                {activeSessionId && selected.status === "running" && (
                  <ResumeComposer
                    open={composerOpen}
                    value={resumeText}
                    onChange={setResumeText}
                    onSend={sendResume}
                    onClose={() => { setComposerOpen(false); setResumeText(""); }}
                    canSend={resumeText.trim().length > 0}
                    onOpen={() => setComposerOpen(true)}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {preview && <SessionPreview task={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** The Run/Resume and Rerun controls, shared by a task row and the session
    header, so both show the same buttons for the same states. `onRerun` is
    optional: re-running is Phase 5, so the button is hidden until wired. */
function RunControls({ task, onStart, onRerun }: { task: MockTask; onStart: () => void; onRerun?: () => void }) {
  const atMax = task.attempts >= task.maxAttempts;
  const canStart = task.status !== "running" && !atMax;
  return (
    <div className="inline-flex items-center gap-0.5">
      {task.status === "running" ? (
        <ActionBtn title={t("Stop")} onClick={onStart} aria-label={t("Stop")}>
          <span className="h-3 w-3 rounded-sm bg-current" />
        </ActionBtn>
      ) : canStart && task.status !== "completed" ? (
        <ActionBtn title={t(task.status === "pending" ? "Run" : "Resume")} onClick={onStart} aria-label={t(task.status === "pending" ? "Run" : "Resume")}>
          <LuPlay className="h-3.5 w-3.5" />
        </ActionBtn>
      ) : null}
      {onRerun && canStart && task.attempts > 0 ? (
        <ActionBtn title={t("Re-run task")} onClick={onRerun} aria-label={t("Re-run task")}>
          <LuRotateCcw className="h-3.5 w-3.5" />
        </ActionBtn>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  dragging,
  ago,
  onSelect,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenSession,
  onStart,
  onRerun,
  onRename,
  onRemove,
}: {
  task: MockTask;
  selected: boolean;
  dragging: boolean;
  ago: string | null;
  onSelect: () => void;
  onMove: (toId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpenSession: () => void;
  onStart: () => void;
  onRerun?: () => void;
  onRename?: (title: string) => void;
  onRemove: () => void;
}) {
  // Rename is local to the row: opening an input replaces the title, Enter saves
  // it server-side, Escape or leaving cancels. The prompt's first line already
  // named the task, so renaming is how you make that name your own.
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.text);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setValue(task.text);
      const id = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(id);
    }
  }, [editing, task.text]);

  const commit = () => {
    const text = value.trim();
    setEditing(false);
    if (text && onRename) onRename(text);
  };
  const cancel = () => {
    setValue(task.text);
    setEditing(false);
  };

  return (
    <li
      draggable
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => { e.preventDefault(); const from = e.dataTransfer.getData("text/plain"); if (from && from !== task.id) onMove(from); }}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition ${dragging ? "opacity-50" : ""} ${selected ? "border-accent/60 bg-accent/5" : "border-line bg-raised/40"}`}
    >
      <button
        type="button"
        aria-label={t("Drag to reorder")}
        title={t("Drag to reorder")}
        className="shrink-0 p-0.5 text-fg-faint opacity-0 hover:text-fg-muted group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <LuGripVertical className="h-3.5 w-3.5" />
      </button>
      <StatusDot taskStatus={task.status} bare />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (isEnter(e)) { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
            onBlur={cancel}
            aria-label={t("Rename task")}
            className="w-full rounded-md border border-line bg-surface px-2 py-0.5 text-sm text-fg outline-none focus:border-accent"
          />
        ) : (
          <button onClick={onSelect} draggable={false} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm text-fg">{task.text}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-faint">
              {ago && <span>{t("last {when}", { when: ago })}</span>}
              {task.status === "running" && <span className="working-text">{t("Working")}</span>}
              {task.status === "failed" && task.attempts < task.maxAttempts && <span>{t("Failed — run again")}</span>}
              {task.status === "stopped" && <span>{t("Stopped")}</span>}
              {task.status === "pending" && <span>{t("Waiting to start")}</span>}
              {task.attempts >= task.maxAttempts && <span className="text-warn">{t("No attempts left")}</span>}
            </p>
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <RunControls task={task} onStart={onStart} onRerun={onRerun} />
        {task.status === "completed" && task.attempts > 0 && (
          <ActionBtn title={t("View session")} onClick={onOpenSession} aria-label={t("View session")}>
            <LuFileText className="h-3.5 w-3.5" />
          </ActionBtn>
        )}
        {onRename && !editing && (
          <ActionBtn title={t("Rename task")} onClick={() => setEditing(true)} aria-label={t("Rename task")}>
            <LuPen className="h-3.5 w-3.5" />
          </ActionBtn>
        )}
        <ActionBtn title={t("Delete task")} onClick={onRemove} aria-label={t("Delete task")}>
          <LuTrash2 className="h-3.5 w-3.5" />
        </ActionBtn>
      </div>
    </li>
  );
}

const ActionBtn = ({ children, onClick, title }: { children: ReactNode; onClick: () => void; title: string }) => (
  <button onClick={onClick} title={title} aria-label={title} className="rounded p-1.5 text-fg-subtle hover:text-accent">
    {children}
  </button>
);

function EmptyState({ primary = false }: { primary?: boolean }) {
  return (
    <div className={`flex flex-1 items-center justify-center ${primary ? "py-8" : "py-16"}`}>
      {primary ? (
        <div className="text-center">
          <p className="text-sm text-fg-subtle">{t("No tasks yet.")}</p>
          <p className="mt-1 text-xs text-fg-faint">{t("Add one to see its history below.")}</p>
        </div>
      ) : (
        <div className="text-center">
          <LuListChecks className="mx-auto mb-3 h-8 w-8 text-fg-faint" />
          <p className="text-sm text-fg-subtle">{t("Pick a task above")}</p>
          <p className="mt-1 text-xs text-fg-faint">{t("Its history shows here, like a chat — every attempt in one scroll.")}</p>
        </div>
      )}
    </div>
  );
}

/** The conversation: every attempt laid out in one scrolling view, each attempt
    marked so the attempts read as attempts rather than one long run. */
function Conversation({ messages, running }: { messages: MockMsg[][]; running: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div ref={list} className="flex-1 overflow-y-auto px-3 py-3">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-fg-subtle">{t("Not started yet.")}</p>
        ) : (
          messages.map((attempt, i) => (
            <Fragment key={i}>
              {i > 0 && <AttemptDivider n={i + 1} />}
              {attempt.map((item) => (
                <MessageItem key={item.id} item={item} running={running} />
              ))}
            </Fragment>
          ))
        )}
        {running && <StatusIndicator />}
      </div>
    </div>
  );
}

function lastOf(task: MockTask) {
  return task.completedAt ?? task.failedAt ?? task.startedAt;
}

function AttemptDivider({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="flex-1 h-px bg-line" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">{t("Attempt {n}", { n })}</span>
      <div className="flex-1 h-px bg-line" />
    </div>
  );
}

function MessageItem({ item, running }: { item: MockMsg; running: boolean }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3 py-1.5 text-sm text-fg ring-1 ring-inset ring-accent/15 whitespace-pre-wrap">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "thinking") {
    return <ThinkingBlock thinking={item.thinking ?? ""} streaming={running} since={item.at} until={item.at + 3000} />;
  }
  if (item.kind === "tool") {
    return <ToolPanel tool={item.tool!} running={running} />;
  }
  // assistant
  return (
    <div className="max-w-[90%]">
      <div className="text-sm leading-relaxed text-fg">
        <Streamdown parseIncompleteMarkdown>{item.text ?? ""}</Streamdown>
      </div>
    </div>
  );
}

/** A tool call, styled like the chat's: a header you can open to see what ran
    and what it said. Kept simple rather than pulling in the full session model. */
function ToolPanel({ tool, running }: { tool: { name: string; detail: string; output: string }; running: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-tool ${open ? "is-open" : ""}`}>
      <button type="button" className="chat-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chat-tool-icon" aria-hidden><LuChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} /></span>
        <span className="chat-tool-name">{tool.name}</span>
        {tool.detail && <span className="chat-tool-detail" title={tool.detail}>{tool.detail}</span>}
        {running && <span className="chat-faint">{t("Running")}</span>}
      </button>
      <Collapse open={open}>
        <div className="chat-tool-body">
          <div className="chat-tool-label">{t("Output")}</div>
          <pre className="chat-tool-output">{tool.output}</pre>
        </div>
      </Collapse>
    </div>
  );
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  if (!open) return null;
  return <div>{children}</div>;
}

/** The little status pill under a conversation that is still going. */
function StatusIndicator() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-fg-subtle">
      <StatusDot taskStatus="running" bare />
      <span className="working-text">{t("Working")}</span>
    </div>
  );
}

/**
 * The composer at the foot of a conversation. Closed by default: a single
 * button says you can continue. Opened, it becomes a text entry like a normal
 * chat — send keeps it open so the conversation goes on.
 */
function ResumeComposer({
  open,
  value,
  onChange,
  onSend,
  onClose,
  canSend,
  onOpen,
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  canSend: boolean;
  onOpen: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  if (!open) {
    return (
      <div className="border-t border-line bg-surface py-2.5">
        <div className="mx-auto w-full max-w-3xl px-3">
          <button
            onClick={onOpen}
            className="w-full rounded-xl border border-line bg-raised/60 px-3 py-2 text-sm text-fg transition hover:bg-fg/5"
          >
            {t("Continue this session")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSend(); }}
      className="border-t border-line bg-surface"
    >
      <div className="mx-auto w-full max-w-3xl px-3 py-2.5">
        <textarea
          ref={box}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => isEnter(e) && !e.shiftKey && canSend && onSend()}
          placeholder={t("Continue this session…")}
          aria-label={t("Message")}
          className="prompt-input"
          rows={2}
          autoFocus
        />
        <div className="mt-1.5 flex items-center justify-between">
          <button type="button" onClick={onClose} aria-label={t("Close")} title={t("Close")} className="prompt-action">
            <LuX className="h-4 w-4" />
          </button>
          <button
            type="submit"
            disabled={!canSend}
            aria-label={t("Send message")}
            title={t("Send message")}
            className="prompt-action prompt-send"
          >
            <LuArrowUp className="h-5 w-5" />
          </button>
        </div>
      </div>
    </form>
  );
}

/** The modal that shows a task's parsed transcript, one attempt after another. */
function SessionPreview({ task, onClose }: { task: MockTask; onClose: () => void }) {
  const messages = task.msgs ?? seedMessages(task);
  return (
    <Modal title={t("Session")} onClose={onClose}>
      <div className="max-h-[80vh] min-w-[20rem] overflow-y-auto space-y-4 p-4">
        <p className="text-sm font-medium text-fg">{task.text}</p>
        {messages.map((attempt, i) => (
          <Fragment key={i}>
            {i > 0 && <AttemptDivider n={i + 1} />}
            {attempt.map((item) => (
              <MessageItem key={item.id} item={item} running={false} />
            ))}
          </Fragment>
        ))}
      </div>
    </Modal>
  );
}
