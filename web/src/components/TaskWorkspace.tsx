import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { StatusDot, type TaskStatus } from "./StatusDot";
import { ThinkingBlock } from "./ChatActivity";
import { confirmDialog } from "./ConfirmDialog";
import { isEnter } from "../shortcuts";
import { formatRelative, t } from "../i18n";
import { Streamdown } from "streamdown";
import { LuArrowUp, LuChevronLeft, LuChevronRight, LuFileText, LuGripVertical, LuListChecks, LuPlay, LuPlus, LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";

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

/** Every state at once, so the workspace shows itself on open: pending, running,
    stopped, failed (twice, to show attempts), and two completed. */
const SEED: MockTask[] = [
  { id: "t1", text: "Summarise the latest discussion and list next steps", status: "pending", attempts: 0, maxAttempts: 5 },
  { id: "t2", text: "Run the test suite and fix any failures", status: "running", attempts: 1, maxAttempts: 5, startedAt: new Date(Date.now() - 4 * 1000).toISOString() },
  { id: "t3", text: "Update the README with the new commands", status: "stopped", attempts: 2, maxAttempts: 5, startedAt: new Date(Date.now() - 90 * 60_000).toISOString() },
  { id: "t4", text: "Wire up the login endpoint", status: "failed", attempts: 2, maxAttempts: 5, startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), failedAt: new Date(Date.now() - 1 * 60_000).toISOString() },
  { id: "t5", text: "Add input validation to the form", status: "completed", attempts: 1, maxAttempts: 5, completedAt: new Date(Date.now() - 12 * 60_000).toISOString() },
  { id: "t6", text: "Write tests for the folder sorting logic", status: "completed", attempts: 3, maxAttempts: 5, completedAt: new Date(Date.now() - 2 * 24 * 60_000).toISOString() },
];

const TABS = ["actions", "completed"] as const;
type Tab = (typeof TABS)[number];

export function TaskWorkspace({ projectName, onBack }: { projectName: string; onBack?: () => void }) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<MockTask[]>(SEED);
  const [tab, setTab] = useState<Tab>("actions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [preview, setPreview] = useState<MockTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);

  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clearAll = useCallback(() => { for (const t of timers.current.values()) clearTimeout(t); timers.current.clear(); }, []);
  useEffect(() => () => clearAll(), [clearAll]);

  const running = tasks.some((x) => x.status === "running");
  const selected = useMemo(() => tasks.find((x) => x.id === selectedId) ?? null, [tasks, selectedId]);

  /** A task working runs until it finishes or fails; one timer per such task. */
  const start = useCallback((id: string, opts?: { fail?: boolean }) => {
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: "running", attempts: x.attempts + 1, startedAt: new Date().toISOString() } : x)));
    const timer = setTimeout(() => {
      timers.current.delete(id);
      if (opts?.fail) fail(id);
      else finish(id);
    }, 3500);
    timers.current.set(id, timer);
  }, []);

  const finish = useCallback((id: string) => {
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: "completed", completedAt: new Date().toISOString() } : x)));
  }, []);

  const fail = useCallback((id: string) => {
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: "failed", failedAt: new Date().toISOString() } : x)));
  }, []);

  const stop = useCallback(() => {
    setTasks((prev) => prev.map((x) => (x.status === "running" ? { ...x, status: "stopped" } : x)));
    for (const id of [...timers.current.keys()]) timers.current.delete(id);
  }, []);

  const addTask = useCallback((text: string) => {
    setTasks((prev) => [{ id: `t${nextId++}`, text, status: "pending", attempts: 0, maxAttempts: 5 }, ...(prev ?? [])]);
    setTab("actions");
  }, []);

  // Reorder by moving one task before another in the underlying list; the
  // Actions and Completed views filter from this, so both keep the new order.
  const moveTask = useCallback((fromId: string, toId: string) => {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === fromId);
      if (i < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(i, 1);
      const j = next.findIndex((x) => x.id === toId);
      next.splice(j >= 0 ? j : 0, 0, moved);
      return next;
    });
  }, []);

  // A task open for the first time gets its history; kept so anything typed to
  // resume is not lost when another render redraws the list.
  const seedIfMissing = useCallback((id: string) => {
    setTasks((prev) => prev.map((x) => (x.id === id && !x.msgs ? { ...x, msgs: seedMessages(x) } : x)));
  }, []);
  useEffect(() => { if (selectedId) seedIfMissing(selectedId); }, [selectedId, seedIfMissing]);

  const actions = tab === "actions" ? tasks.filter((x) => x.status !== "completed") : tasks.filter((x) => x.status === "completed");
  const ago = (iso?: string) => (iso ? formatRelative((Date.now() - new Date(iso).getTime()) / 60000, "minute") : null);

  const rerun = (task: MockTask) => start(task.id, { fail: task.status === "failed" });

  const remove = async (task: MockTask) => {
    if (await confirmDialog({ title: t("Delete \"{name}\"?", { name: task.text }), message: t("It is gone from this list forever."), confirmLabel: t("Delete"), danger: true })) {
      setTasks((prev) => prev.filter((x) => x.id !== task.id));
      if (selectedId === task.id) setSelectedId(null);
    }
  };

  const sendResume = async () => {
    const text = resumeText.trim();
    if (!text || !selected) return;
    seedIfMissing(selected.id);
    const userMsg: MockMsg = { id: mid(), kind: "user", text, at: Date.now() };
    const reply: MockMsg = { id: mid(), kind: "assistant", text: REPLY(text), at: Date.now() + 10 };
    setTasks((prev) => prev.map((x) => (x.id === selected.id ? { ...x, attempts: x.attempts + 1, msgs: [...(x.msgs ?? []), [userMsg, reply]] } : x)));
    setResumeText("");
  };

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
              const n = label === "actions" ? tasks.filter((x) => x.status !== "completed").length : tasks.filter((x) => x.status === "completed").length;
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
          {tasks.length === 0 ? (
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
                    placeholder={t("New task title")}
                    aria-label={t("New task title")}
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
                  onRerun={() => rerun(task)}
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
                onRerun={() => rerun(selected)}
              />
            </div>

            <Conversation
              messages={selected.msgs ?? seedMessages(selected)}
              running={selected.status === "running"}
            />

            <ResumeComposer
              open={composerOpen}
              value={resumeText}
              onChange={setResumeText}
              onSend={sendResume}
              onClose={() => { setComposerOpen(false); setResumeText(""); }}
              canSend={resumeText.trim().length > 0}
              onOpen={() => setComposerOpen(true)}
            />
          </>
        )}
      </div>

      {preview && <SessionPreview task={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** The Run/Resume and Rerun controls, shared by a task row and the session
    header, so both show the same buttons for the same states. */
function RunControls({ task, onStart, onRerun }: { task: MockTask; onStart: () => void; onRerun: () => void }) {
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
      {canStart && task.attempts > 0 ? (
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
  onRerun: () => void;
  onRemove: () => void;
}) {
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
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <RunControls task={task} onStart={onStart} onRerun={onRerun} />
        {task.status === "completed" && task.attempts > 0 && (
          <ActionBtn title={t("View session")} onClick={onOpenSession} aria-label={t("View session")}>
            <LuFileText className="h-3.5 w-3.5" />
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
