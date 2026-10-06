import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { StatusDot, type TaskStatus } from "./StatusDot";
import { ThinkingBlock } from "./ChatActivity";
import { confirmDialog } from "./ConfirmDialog";
import { isEnter } from "../shortcuts";
import { t } from "../i18n";
import { api, type Task, type TaskAttempt } from "../api";
import { local } from "../safe-storage";
import { Streamdown } from "streamdown";
import { useSessionEvents } from "../use-session-events";
import { useFollowBottom } from "../use-follow-bottom";
import { TaskTranscript } from "./TaskTranscript";
import { LuArrowUp, LuCheck, LuChevronLeft, LuChevronRight, LuFileText, LuFolderOpen, LuGitBranch, LuGripVertical, LuListChecks, LuPen, LuPlus, LuReply, LuRotateCcw, LuSettings, LuSquare, LuTrash2, LuX } from "react-icons/lu";

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
  /** The full task description (the actual content). Shown when editing; the
      list shows `text`, which holds the title. */
  desc: string;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  failedAt?: string;
  completedAt?: string;
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
    `text` here holds the title; `desc` the full description. The bottom panel
    still renders mock history, because execution is a later phase. Unbounded
    attempts map to Infinity so the "no attempts left" checks simply never fire. */
const mapTask = (row: Task): MockTask => ({
  id: row.id,
  text: row.title,
  desc: row.description,
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

/** Compact accumulated runtime for the task row: space is tight on mobile, so
    show minutes and seconds (`3m 42s`) rather than the fuller `formatElapsed`
    form. Under a minute it drops to whole seconds so a just-started run still
    ticks visibly. */
const formatShortElapsed = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m ${s % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${Math.floor(mins % 60)}m`;
};

const TABS = ["actions", "completed"] as const;
type Tab = (typeof TABS)[number];

/** Called after any change to the queue, so the sidebar can keep its pending-count badge current. */
type OnTaskActivity = () => void;

/** Whether the viewport is under a mobile width. Used to hide the session
    transcript while the resume composer is open on phone screens, so the
    controls do not sit on top of the conversation. */
function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(`(max-width: ${breakpoint - 1}px`).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${breakpoint}px)`);
    // Invert: mql.matches means wide, which is not mobile.
    const read = () => setMobile(!mql.matches);
    read();
    mql.addEventListener("change", read);
    return () => mql.removeEventListener("change", read);
  }, [breakpoint]);
  return mobile;
}

export function TaskWorkspace({ projectName, onBack, onTaskActivity }: { projectName: string; onBack?: () => void; onTaskActivity?: OnTaskActivity }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [rows, setRows] = useState<MockTask[]>([]);
  const [tab, setTab] = useState<Tab>("actions");
  // Client-side view concern (§18): which completed Tasks have been acknowledged
  // and are therefore eligible to leave the active "Actions" view. A Task that
  // has just completed stays visible here until acknowledged, so completion is
  // actually seen before it moves into history. Nothing is persisted — this is
  // purely what the active list shows, not a stored field.
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  // Id of the task whose conversation is shown inline at the foot of the
  // workspace (opened from “View session”). `null` means the normal activity
  // transcript is showing. Keeping it inline — not a centered dialog — keeps
  // the session view in the same area used for the task list and never overlaps
  // the rest of the UI.
  const [viewingMockId, setViewingMockId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The task description typed into “New task” but not submitted. Kept in
  // storage (see below) so leaving the page — to another project, a session,
  // anywhere — and coming back does not drop what was half written, the way it
  // would if this were only component state.
  const draftKey = useMemo(() => `pithagoras.task-draft.${projectName}`, [projectName]);
  const [draft, setDraft] = useState("");
  // On entering a project, restore what was left for it; remember every change
  // so a reload or a wander away keeps it. An empty draft is forgotten, not
  // stored as blank.
  useEffect(() => { setDraft(local.get(draftKey) ?? ""); }, [projectName, draftKey]);
  useEffect(() => {
    if (draft) local.set(draftKey, draft);
    else local.remove(draftKey);
  }, [draft, draftKey]);
  // Ids of Task rows whose rename input is open. Raised from each row so the
  // parent can hide the activity view while any task is being edited (see below).
  const [editingRows, setEditingRows] = useState<Set<string>>(new Set());
  const notifyEdit = (id: string, open: boolean) =>
    setEditingRows((prev) => {
      const next = new Set(prev);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether this project's server-owned autonomous queue loop is running.
  // Read once on open (Phase 5); recovery after a restart is Phase 8.
  const [loopRunning, setLoopRunning] = useState(false);

  // Load this project's queue from the backend. Runs on open and again if the
  // project changes under us (e.g. navigating between projects).
  useEffect(() => {
    let cancelled = false;
    setRows([]);
    setAcknowledged(new Set());
    setError(null);
    api.listTasks(projectName)
      .then((tasks) => {
        if (cancelled) return;
        setRows(tasks.map(mapTask));
      })
      .catch(() => { if (!cancelled) setError("Could not load this project's tasks."); });
    return () => { cancelled = true; };
  }, [projectName]);

  // Read whether the queue loop is already running for this project, so the
  // Start/Stop control is honest on load rather than assuming stopped.
  useEffect(() => {
    let cancelled = false;
    api.queueStatus(projectName)
      .then((s) => { if (!cancelled) setLoopRunning(s.running); })
      .catch(() => {});
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
  const viewedTask = useMemo(() => rows.find((x) => x.id === viewingMockId) ?? null, [rows, viewingMockId]);
  // The "View session" messages are seeded once per task and kept, rather than
  // rebuilt whenever the project list refreshes. They are cached by task id in a
  // ref, because the list is refreshed continuously while the queue runs, and
  // each refresh builds a fresh set of Task objects. Rebuilding would hand the
  // conversation scroller a new array (with new message ids) on every refresh,
  // making its follow-the-bottom effect re-run and every message re-mount —
  // which fights the auto-scroll. Keeping one stable array per task, the way the
  // main chat keeps its transcript stable, lets the scroller follow only when the
  // content really changes and never churns the messages out from under it.
  const viewMsgCache = useRef<Map<string, MockMsg[][]>>(new Map());
  const viewMsgs = useMemo(() => {
    if (!viewedTask) return [];
    const existing = viewMsgCache.current.get(viewedTask.id);
    if (existing) return existing;
    const msgs = seedMessages(viewedTask);
    viewMsgCache.current.set(viewedTask.id, msgs);
    return msgs;
  }, [viewedTask]);
  // A task row is being renamed, or a new one is being written. On a phone the
  // virtual keyboard leaves very little room, so while either is open we drop
  // the whole activity view below (see its guard) to give the edit area all the
  // vertical space available, with nothing obstructing it.

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
  // Keep this session's transcript pinned to its end while a run streams, using
  // the same follow-the-bottom logic the main chat does (see use-follow-bottom):
  // new tokens stay in view, and scrolling up to read is left alone instead of
  // snapping back. Without it the running view would fight with itself on every
  // stream tick, bouncing between the top and whatever the run had reached.
  const transcriptScroller = useFollowBottom<HTMLDivElement>();
  // Follow the transcript whenever its content changes, like the main chat does
  // (see Chat). Following starts on and stays until you scroll up to read; new
  // tokens then re-pin you to the end. Tied to the attempt's events and session,
  // so switching an attempt or a run ending settles without chasing content.
  useEffect(() => {
    transcriptScroller.follow();
  }, [events, activeSessionId]);

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
  }, [projectName, selected?.id]);

  // When a run stops streaming, the backend has settled the attempt (a natural
  // end becomes failed; a stop becomes stopped) and reset the Task. Reconcile
  // our local copies so the status and chips stay honest without polling.
  useEffect(() => {
    if (!activeSessionId || sessionRunning || !selected || selected.status !== "running") return;
    api.listTasks(projectName).then((tasks) => setRows(tasks.map(mapTask)));
    api.getTaskAttempts(projectName, selected.id).then(setAttempts);
  }, [sessionRunning, activeSessionId]);

  // The loop drives Tasks on the server, so a Task can start (or finish) at any
  // moment the view never hears about directly. While the queue is running we
  // poll the list: apply the drift, and the moment the loop launches a Task we
  // make sure its fresh session is the one being followed — selecting it if it
  // is not already, or reloading its attempts if it is — so its transcript
  // streams live instead of appearing only once something else changes.
  const prevStatusesRef = useRef<Record<string, Task["status"]>>({});
  useEffect(() => {
    if (!loopRunning) return undefined;
    let cancelled = false;
    const refresh = () => {
      api.listTasks(projectName)
        .then((tasks) => {
          if (cancelled) return;
          const next = tasks.map(mapTask);
          const prev = prevStatusesRef.current;
          // A Task the loop just started: its status flipped from not-running.
          const launched = next.find((n) => n.status === "running" && prev[n.id] !== "running");
          setRows(next);
          prevStatusesRef.current = Object.fromEntries(next.map((n) => [n.id, n.status]));
          if (!launched) return;
          if (launched.id !== selectedId) {
            setSelectedId(launched.id);
          } else {
            // Already the selected Task but its attempt/session was not loaded
            // yet (it started while we were looking at it): load it now so the
            // session content begins streaming immediately.
            api.getTaskAttempts(projectName, launched.id)
              .then((list) => {
                const latest = [...list].sort((a, b) => a.attempt_number - b.attempt_number).at(-1);
                if (latest) setActiveAttemptId(latest.id);
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [loopRunning, projectName]);

  // The queue changed: tell the parent to re-read this project's pending count,
  // so the sidebar badge stays honest without the sidebar polling.
  const notifyActivity = () => onTaskActivity?.();

  const start = async (id: string) => {
    try {
      const { attempt } = await api.startTask(projectName, id);
      setAttempts((prev) => [...prev, attempt]);
      setActiveAttemptId(attempt.id);
      notifyActivity();
    } catch {
      setError("Could not start the task.");
    }
  };

  const stop = async () => {
    if (!selected) return;
    try {
      await api.stopTask(projectName, selected.id);
      notifyActivity();
    } catch {
      setError("Could not stop the task.");
    }
  };

  // Rerun (Phase 5): reset a task to pending WITHOUT starting it, so it drops
  // back onto the queue to be reordered and Run later. Keeps previous attempts
  // as history; it does not touch any session.
  const rerun = async (id: string) => {
    try {
      const updated = await api.rerunTask(projectName, id);
      setRows((prev) => prev.map((x) => (x.id === id ? mapTask(updated) : x)));
      notifyActivity();
    } catch {
      setError("Could not rerun the task.");
    }
  };

  // Mark a task complete no matter what state it is in now — pending, running,
  // failed, stopped or already done. This is “finished by hand”, so it does not
  // start or rerun anything and leaves prior attempts as history. A task that
  // was not yet completed simply leaves the Actions tab for the Completed one.
  const markComplete = async (id: string) => {
    try {
      const updated = await api.completeTask(projectName, id);
      setRows((prev) => prev.map((x) => (x.id === id ? mapTask(updated) : x)));
      // Marking complete is an explicit, hands-on action, so it counts as
      // acknowledging (§18): the Task has been dealt with directly, and it leaves
      // the Actions tab for Completed right away — matching what this handler's
      // comment promises, unlike a queue-finished Task which stays until seen.
      acknowledge(id);
      notifyActivity();
    } catch {
      setError("Could not mark the task complete.");
    }
  };

  // Project-level queue control (Phase 5): start/stop the server-owned loop for
  // this project only. This toggles automatic processing, not an individual task.
  const startQueue = async () => {
    try {
      await api.startQueue(projectName);
      setLoopRunning(true);
      notifyActivity();
    } catch {
      setError("Could not start the queue.");
    }
  };
  const stopQueue = async () => {
    try {
      await api.stopQueue(projectName);
      setLoopRunning(false);
      notifyActivity();
    } catch {
      setError("Could not stop the queue.");
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
      notifyActivity();
    } catch {
      setError("Could not create the task.");
    }
    setAdding(false);
    setDraft("");
  }, [projectName]);

  // Follow up (as CodeLoop does on its tasks page): open the same “New task”
  // dialog used to create one, but pre-fill the box with the chosen task so a
  // related task can be sent at once. The original prompt sits under a header
  // marking this a follow-up, using the same format CodeLoop uses, so the user
  // can edit it before creating. Nothing runs until they submit.
  const startFollowUp = useCallback((task: MockTask) => {
    const base = (task.desc || task.text).trim();
    if (!base) return;
    setSelectedId(task.id);
    setTab("actions");
    setDraft(`Follow-up to the previous task:\n\n${base}`);
    setAdding(true);
  }, []);

  // Move one task before another, then persist the new order to the server, which
  // owns the queue. This really reorders — unlike the mock, which would not move.
  const moveTask = useCallback(async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const key = `${fromId}->${toId}`;
    if (key === lastMoveRef.current) return;
    lastMoveRef.current = key;
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

  // Guard against redundant repeats. On touch, one continuous finger drag emits
  // many pointermove events before the row leaves its slot. Without a guard the
  // same move is replayed against freshly-updated state and the row oscillates
  // back to where it started, leaving the order unchanged. Remember the last
  // (from -> to) pair and skip identical repeats until the next distinct move.
  const lastMoveRef = useRef<null | string>(null);

  // Edit a task's content. The edit box writes the full description (what the
  // agent actually works on), not just the name. No title is sent: like creating
  // a task, the server re-names it from the first line of the new description,
  // clipped the same way. The returned row gives back that fresh name to show.
  const rename = useCallback(async (id: string, description: string) => {
    const text = description.trim();
    if (!text) return;
    try {
      const updated = await api.editTask(projectName, id, { description: text });
      setRows((prev) =>
        prev.map((x) => (x.id === id ? { ...x, text: updated.title, desc: updated.description } : x)),
      );
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
      notifyActivity();
    } catch {
      setError("Could not delete the task.");
    }
  };

  // Continuing a session drives the agent — Phase 3. The composer stays, but
  // sending does nothing until it is wired up.


  // Acknowledge a completed Task so it can leave the active view (§18). This is
  // only a client-side view concern — no API call, no stored field.
  const acknowledge = useCallback((id: string) => {
    setAcknowledged((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Walking into Completed marks every completed Task acknowledged at once (§18),
  // so they all become eligible to leave the active view on the next pass.
  const acknowledgeAllCompleted = useCallback(() => {
    setAcknowledged((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const x of rows) if (x.status === "completed") { next.add(x.id); changed = true; }
      return changed ? next : prev;
    });
  }, [rows]);

  // One list filtered by the open tab. Completed shows every finished Task,
  // regardless of acknowledgment. Actions shows every non-completed Task plus
  // any completed one not yet acknowledged — a just-finished Task stays put here
  // so its completion is actually seen before it moves into history. An
  // acknowledged Task still renders while it is the one being viewed or selected,
  // so picking it does not yank its row out mid-view; it drops away once the user
  // leaves it (a fresh active-view pass never brings it back).
  const actions =
    tab === "actions"
      ? rows.filter((x) => {
          if (x.status !== "completed") return true;
          if (!acknowledged.has(x.id)) return true; // recently completed, unacked
          return x.id === selectedId || x.id === viewingMockId; // shown while viewed
        })
      : rows.filter((x) => x.status === "completed");

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* The task list sits above the conversation. Section A is a flex item
            (so it never overlaps the title row below) yet capped to roughly
            three tasks: the list scrolls internally instead of stretching to
            fill the page, and the conversation below keeps its room. */}
      <div className="flex min-h-0 flex-1 flex-col border-b border-line max-h-[15rem]">
        {/* The header row carries everything at a glance: the breadcrumb on the left,
            the queue control and the add action pushed to the right. On narrow screens
            the two sides wrap instead of overlapping the project name. */}
        <div className="flex flex-wrap items-center gap-2 justify-between px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
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
            <div className="min-w-0">
              <span className="hidden md:inline text-sm font-semibold text-fg">{t("Tasks")}</span>
              <span className="ml-1 hidden md:inline truncate text-xs text-fg-faint">{projectName}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={loopRunning ? stopQueue : startQueue}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${
                loopRunning
                  ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
                  : "border-line bg-raised text-fg-subtle hover:text-fg hover:bg-fg/5"
              }`}
              aria-label={loopRunning ? t("Stop queue") : t("Start queue")}
              title={loopRunning ? t("Stop the autonomous queue") : t("Start the autonomous queue")}
            >
              <StatusDot taskStatus={loopRunning ? "running" : "stopped"} bare />
              {loopRunning ? t("Stop queue") : t("Start queue")}
            </button>
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-sm font-medium text-white transition hover:bg-accent/90"
            >
              <LuPlus className="h-3.5 w-3.5" />
              {t("New task")}
            </button>
          </div>
          {/* Folder and git mirror the two the chat shows at the top of its
              header; settings opens the project, like the projects page does.
              All three live on this project, so they reach it through its folder.
              Execution is a later phase, so these point at the project itself
              rather than an open files/git pane. */}
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => navigate(`/sessions?folder=${encodeURIComponent(`project:${projectName}`)}`)}
              className="panel-toggle relative rounded-lg border px-2 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg [&>svg]:h-3.5 [&>svg]:w-3.5"
              title={t("Browse the files in this project's folder")}
              aria-label={t("Browse the files in this project's folder")}
            >
              <LuFolderOpen />
            </button>
            <button
              type="button"
              onClick={() => navigate(`/sessions?folder=${encodeURIComponent(`project:${projectName}`)}`)}
              className="panel-toggle relative rounded-lg border px-2 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg [&>svg]:h-3.5 [&>svg]:w-3.5"
              title={t("What changed, commits and branches — for this project's repository")}
              aria-label={t("What changed, commits and branches — for this project's repository")}
            >
              <LuGitBranch />
            </button>
            <button
              type="button"
              onClick={() => navigate("/projects")}
              className="panel-toggle relative rounded-lg border px-2 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg [&>svg]:h-3.5 [&>svg]:w-3.5"
              title={t("Project settings")}
              aria-label={t("Project settings")}
            >
              <LuSettings />
            </button>
          </div>
        </div>

        {/* Tabs sit on a line beneath the header, the open one dropping down into the list.
            The counts stay so you can see how many are queued versus finished. */}
        <div className="flex items-center px-3 pb-2">
          <div className="flex border-b border-line">
            {TABS.map((label) => {
              // Count what each tab actually shows: Actions includes the
              // recently completed-but-unacked tasks, Completed lists them all.
              const n = label === "actions" ? actions.length : rows.filter((x) => x.status === "completed").length;
              return (
                <button
                  key={label}
                  onClick={() => {
                    // Entering Completed acknowledges every completed Task at once
                    // (§18), so they all become eligible to leave the active view.
                    if (label === "completed") acknowledgeAllCompleted();
                    setTab(label);
                  }}
                  aria-current={tab === label}
                  className={`flex items-center gap-1.5 border-b -mb-px pb-2 px-3 text-sm font-medium transition ${
                    tab === label
                      ? "border-accent text-fg"
                      : "border-transparent text-fg-subtle hover:text-fg"
                  }`}
                >
                  {t(label === "actions" ? "Pending" : "Completed")}
                  <span className="text-[10px] tabular-nums text-fg-faint">{n}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {error ? (
            <p className="py-4 text-center text-xs text-warn">{error}</p>
          ) : rows.length === 0 && !adding ? (
            <EmptyState primary />
          ) : (
            <ul className="space-y-0.5 pt-0.5">
              {adding && (
                <li className="mb-1 rounded-xl border border-line bg-raised p-2">
                  <textarea
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => isEnter(e) && (e.ctrlKey || e.metaKey) && draft.trim() && addTask(draft.trim())}
                    placeholder={t("Write what you want done")}
                    aria-label={t("Write what you want done")}
                    className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm leading-relaxed outline-none placeholder:text-fg-faint focus:border-accent"
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
                  // Selecting a task only opens it: never move between tabs just because a
                  // row was picked, or clicking a finished task in Completed would jump home.
                  onSelect={() => {
                    setSelectedId(task.id);
                    setComposerOpen(false);
                    // Viewing a just-completed Task acknowledges it (§18): it is now
                    // eligible to leave the active view. It stays visible while still
                    // selected, then drops away on the next pass.
                    if (task.status === "completed") acknowledge(task.id);
                    // Picking another task leaves any inline session view, since
                    // that view belongs to the task it was opened for.
                    if (viewingMockId && viewingMockId !== task.id) setViewingMockId(null);
                  }}
                  onMove={(toId) => moveTask(task.id, toId)}
                  onDragStart={() => setDragId(task.id)}
                  onDragEnd={() => setDragId(null)}
                  onOpenSession={() => {
                    setSelectedId(task.id);
                    setComposerOpen(false);
                    // Opening the session of a completed Task counts as viewing it,
                    // so it is acknowledged (§18) and can leave the active view.
                    acknowledge(task.id);
                    setViewingMockId(task.id);
                  }}
                  onStart={() => task.status === "running" ? stop() : start(task.id)}
                  onRerun={() => rerun(task.id)}
                  onComplete={() => markComplete(task.id)}
                  onRename={(title) => rename(task.id, title)}
                  onFollowUp={() => startFollowUp(task)}
                  onRemove={() => remove(task)}
                  onEditStateChange={(open) => notifyEdit(task.id, open)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* The conversation sits below the list and fills whatever vertical room
            is left between the list above and the Reply bar below, so the
            Reply bar stays pinned to the foot of the workspace rather than
            floating mid-screen with a gap underneath it. The transcript inside
            scrolls on its own, so a long history (many attempts) never pushes
            the Reply bar off the bottom — whether it shows normal activity or a
            completed task's "View session". While a task is being created or
            edited, though, drop this whole view (header and transcript both)
            so the edit area keeps every pixel left on a small screen. */}
      {!adding && editingRows.size === 0 ? (
      <div className="flex min-h-0 flex-1 shrink-0 flex-col">
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
                onRerun={() => rerun(selected.id)}
                onComplete={() => markComplete(selected.id)}
              />
            </div>

            {/* The conversation fills what is left of the page, pinned just
                above the Reply bar below. It renders one attempt's real
                transcript, streamed from its session. Its bottom sits flush
                against the Reply bar whichever view is showing. */}
            <div className="flex min-h-0 flex-1 flex-col">
              {loadingAttempts ? (
                <div className="flex flex-1 items-center justify-center py-16">
                  <span className="text-fg-muted">{t("Loading history…")}</span>
                </div>
              ) : viewedTask ? (
                // The session view renders inline in this bottom panel, in the
                // same area the activity normally uses, instead of a centered
                // dialog that would overlap the whole workspace. Its bottom sits
                // pinned just above the Reply bar.
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                    <LuFileText className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-sm text-fg">{t("Session")}</p>
                    <button
                      type="button"
                      onClick={() => setViewingMockId(null)}
                      className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
                      aria-label={t("Back to activity")}
                      title={t("Back to activity")}
                    >
                      <LuX className="h-4 w-4" />
                    </button>
                  </div>
                  <Conversation messages={viewMsgs} running={viewedTask.status === "running"} />
                </div>
              ) : (
                <div {...transcriptScroller.attach} onScroll={transcriptScroller.onScroll} onWheel={transcriptScroller.onWheel} onPointerDown={transcriptScroller.hold} onKeyDown={transcriptScroller.hold} className="min-h-0 flex-1 overflow-y-auto">
                  {activeSessionId && !(composerOpen && isMobile) ? (
                    <TaskTranscript sessionId={activeSessionId} events={events} running={sessionRunning} />
                  ) : composerOpen && isMobile ? (
                    // While editing on a phone the transcript is hidden so the
                    // composer's controls never overlap the session text.
                    <div className="pointer-events-none" />
                  ) : (
                    <div className="flex h-full items-center justify-center py-16">
                      <span className="text-fg-muted">{t("This run has no activity yet.")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* The Reply bar is pinned to the bottom of the view, wherever a
                session exists — not only while it runs, as before. It opens a
                note to send into the session and continue the run; the stop
                icon to its right halts it, using the same square as the chat
                page. The history above settles onto it rather than filling the
                whole panel. */}
            {activeSessionId && (
              <ResumeComposer
                open={composerOpen}
                value={resumeText}
                onChange={setResumeText}
                onSend={sendResume}
                onClose={() => { setComposerOpen(false); setResumeText(""); }}
                canSend={resumeText.trim().length > 0}
                onOpen={() => setComposerOpen(true)}
                running={selected.status === "running"}
                onStop={stop}
              />
            )}
          </>
        )}
      </div>
      ) : null}

    </div>
  );
}

/** The Rerun control, shown alongside the Stop button in the session header,
    so both places present the same buttons for the same states.

    * Rerun only resets a Task to pending without starting it, so it can be
      reordered and run later via the project's Start queue button. It does not
      touch an existing attempt's history.

    There is intentionally no play/run (triangle) button here: Tasks are started
    by running the project's autonomous queue, never by a per-task triangle. */
function RunControls({ task, onStart, onRerun, onComplete }: { task: MockTask; onStart: () => void; onRerun?: () => void; onComplete?: () => void }) {
  const atMax = task.attempts >= task.maxAttempts;
  const canRerun = !!onRerun && ["failed", "stopped", "completed"].includes(task.status) && task.attempts > 0;
  return (
    <div className="inline-flex items-center gap-0.5">
      {task.status === "running" ? (
        <ActionBtn title={t("Stop")} onClick={onStart} aria-label={t("Stop")}>
          <span className="h-3 w-3 rounded-sm bg-current" />
        </ActionBtn>
      ) : null}
      {canRerun ? (
        <ActionBtn title={t("Re-run task")} onClick={onRerun} aria-label={t("Re-run task")}>
          <LuRotateCcw className="h-3.5 w-3.5" />
        </ActionBtn>
      ) : null}
      {/* Mark complete is available for every task that is not already done,
          no matter what state it is in — pending, running, failed or stopped. */}
      {onComplete && task.status !== "completed" ? (
        <ActionBtn title={t("Mark completed")} onClick={onComplete} aria-label={t("Mark completed")}>
          <LuCheck className="h-3.5 w-3.5" />
        </ActionBtn>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  dragging,
  onSelect,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenSession,
  onStart,
  onRerun,
  onComplete,
  onRename,
  onFollowUp,
  onRemove,
  onEditStateChange,
}: {
  task: MockTask;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onMove: (toId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpenSession: () => void;
  onStart: () => void;
  onRerun?: () => void;
  onComplete?: () => void;
  onRename?: (title: string) => void;
  /** Open the “New task” dialog pre-filled as a follow-up to this task. */
  onFollowUp?: () => void;
  onRemove: () => void;
  /** Called when the rename input opens or closes, so the parent can hide the
      activity view while a task is being edited on a small screen. */
  onEditStateChange?: (open: boolean) => void;
}) {
  // Editing is local to the row: opening an input replaces the title with the
  // full description, Ctrl/Cmd+Enter (or blur) saves it server-side, Escape or
  // leaving cancels. The saved description re-names the task from its first line
  // (see rename), so the name keeps matching the content.
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.desc);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    onEditStateChange?.(editing);
  }, [editing]);
  useEffect(() => {
    if (editing) {
      setValue(task.desc);
      const id = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(id);
    }
  }, [editing, task.desc]);

  const commit = () => {
    const text = value.trim();
    setEditing(false);
    if (text && onRename) onRename(text);
  };
  const cancel = () => {
    setValue(task.desc);
    setEditing(false);
  };

  // While the task runs, tick once a second so the row's accumulated runtime
  // stays live; otherwise leave the clock untouched. A re-render alone would
  // not update the ticking time, so this drives it.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (task.status !== "running") return;
    const id = setInterval(() => setClock((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [task.status]);

  // Accumulated execution time since the task started, shown only while running.
  // Kept off the status line for finished tasks, where no runtime applies.
  const elapsedText = useMemo(() => {
    if (task.status !== "running" || !task.startedAt) return "";
    const start = new Date(task.startedAt).getTime();
    return formatShortElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
  }, [task.status, task.startedAt, clock]);

  // ---- Touch reorder -------------------------------------------------------
  // On a phone the native `draggable` above never fires, so we follow the finger
  // by hand and call moveTask via onMove. For this to feel right on touch:
  //
  //   * A press-and-hold must MOVE the row, not select its text. Pressing used
  //     to wash the label dark grey (the browser's native selection) instead of
  //     dragging, because selection was only stopped once a drag had started. We
  //     disable it from the very first pointerdown, so nothing can highlight.
  //   * A plain tap must still open the task and the list must still scroll. So
  //     we only "grab" the row once the gesture clearly means to: the finger has
  //     held for a moment AND started past a small threshold. A quick scroll
  //     (fast, little hold) slips through untouched; a deliberate long-press-
  //     plus-drag engages. Grabbing anywhere on the row — not just the grip — is
  //     what makes it discoverable on a small screen.
  const DRAG_HOLD_MS = 120;
  const DRAG_THRESHOLD_PX = 12;
  const rowRef = useRef<HTMLLIElement>(null);
  const draggingRef = useRef(false);
  // Whether the current pointer session grabbed the row to drag it. Set once the
  // gesture engages so we can stop the following click from opening the task — a
  // release after a drag is not a tap. Reset at the start of every new press.
  const draggedRef = useRef(false);
  const gestureRef = useRef<{
    pid: number; startX: number; startY: number; startTime: number; engaged: boolean;
  } | null>(null);

  const beginDragGesture = (e: ReactPointerEvent<HTMLLIElement>) => {
    // Desktop mice drive the native draggable above. Everything else (touch,
    // pen) uses this hand-followed drag so phones can reorder too.
    if (e.pointerType === "mouse" || e.button !== 0) return;
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    gestureRef.current = { pid, startX, startY, startTime: Date.now(), engaged: false };
    draggedRef.current = false;
    const body = document.body;
    const savedSelect = body.style.userSelect;
    const savedWebkit = body.style.webkitUserSelect;
    const savedTouch = body.style.touchAction;
    // Kill text selection for the whole press so a long-press can never produce
    // the dark grey highlight that used to block reordering. Page scrolling is
    // left alone until the row is actually grabbed (see engage() below).
    body.style.userSelect = "none";
    body.style.webkitUserSelect = "none";

    const engage = () => {
      if (gestureRef.current?.pid !== pid) return;
      gestureRef.current.engaged = true;
      draggedRef.current = true;
      // The row is being moved now, so stop the page panning — otherwise the
      // reorder fights the list scroll.
      body.style.touchAction = "none";
      if (!draggingRef.current) {
        draggingRef.current = true;
        onDragStart();
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const g = gestureRef.current;
      if (!g) return;
      if (!g.engaged) {
        const held = Date.now() - g.startTime >= DRAG_HOLD_MS;
        const moved = Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) >= DRAG_THRESHOLD_PX;
        if (!held || !moved) return;
        engage();
      }
      ev.preventDefault();
      const el = rowRef.current;
      const ul = el?.parentElement;
      if (!el || !ul) return;
      const kids = Array.from(ul.children) as HTMLLIElement[];
      const idx = kids.indexOf(el);
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (idx > 0 && ev.clientY < mid - 10) {
        const prevId = kids[idx - 1].getAttribute("data-task-id");
        if (prevId && prevId !== task.id) onMove(prevId);
      } else if (idx < kids.length - 1 && ev.clientY > mid + 10) {
        const nextId = kids[idx + 1].getAttribute("data-task-id");
        if (nextId && nextId !== task.id) onMove(nextId);
      }
    };

    const end = () => {
      if (gestureRef.current?.pid !== pid) return;
      gestureRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      body.style.userSelect = savedSelect;
      body.style.webkitUserSelect = savedWebkit;
      body.style.touchAction = savedTouch;
      if (draggingRef.current) {
        draggingRef.current = false;
        onDragEnd();
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <li
      ref={rowRef}
      data-task-id={task.id}
      draggable
      onPointerDown={beginDragGesture}
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
          <textarea
            ref={inputRef}
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (isEnter(e) && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
            onBlur={commit}
            aria-label={t("Edit task")}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm leading-relaxed text-fg outline-none focus:border-accent"
          />
        ) : (
          <button onClick={() => { draggedRef.current ? (draggedRef.current = false) : onSelect(); }} draggable={false} className="min-w-0 flex-1 text-left">
            {/* First row: just the prompt, never wrapped and clipped horizontally if
                it is longer than the field. */}
            <p className="min-w-0 truncate text-sm text-fg">{task.text}</p>
            {/* Second row: a single line of status, plus the accumulated runtime
                only while running. A single truncate keeps the whole line from
                spilling past the field's edge on narrow screens. */}
            <p className="min-w-0 mt-0.5 flex items-center gap-x-2 truncate text-[11px] text-fg-faint">
              {task.status === "running" && <span className="working-text">{t("Working")}</span>}
              {elapsedText && <span className="tabular-nums">{elapsedText}</span>}
              {task.status === "failed" && task.attempts < task.maxAttempts && <span>{t("Failed — run again")}</span>}
              {task.status === "stopped" && <span>{t("Stopped")}</span>}
              {task.status === "pending" && <span>{t("Waiting to start")}</span>}
              {task.status === "completed" && <span>{t("Completed")}</span>}
              {task.status !== "completed" && task.attempts >= task.maxAttempts && <span className="text-warn">{t("No attempts left")}</span>}
            </p>
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        {onFollowUp && (
          <ActionBtn title={t("Follow up")} onClick={onFollowUp} aria-label={t("Follow up")}>
            <LuReply className="h-3.5 w-3.5" />
          </ActionBtn>
        )}
        {/* No play/run button here: tasks are started by running the project's queue, not by a per-task triangle. */}
        <RunControls task={task} onStart={onStart} onRerun={onRerun} />
        {onRename && !editing && (
          <ActionBtn title={t("Edit task")} onClick={() => setEditing(true)} aria-label={t("Edit task")}>
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
        <div className="max-w-md text-center">
          <p className="text-sm text-fg-subtle">{t("No tasks yet.")}</p>
          <p className="mt-1 text-xs text-fg-faint">{t("Add one to see its history below.")}</p>
          <p className="mt-3 leading-relaxed text-xs text-fg-faint">{t("Tasks are prompts that Pithagoras works on until they're completed. Failed attempts are automatically retried with fresh context like a Ralph Wiggum loop, and each project can provide additional instructions that are included with every prompt.")}</p>
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
  // Same follow-the-bottom behaviour as the live transcript and the main chat:
  // a still-running mock settles to its end, and a finished one just stays put.
  const scroller = useFollowBottom<HTMLDivElement>();
  useEffect(() => {
    scroller.follow();
  }, [messages]);
  return (
    <div {...scroller.attach} onScroll={scroller.onScroll} onWheel={scroller.onWheel} onPointerDown={scroller.hold} onKeyDown={scroller.hold} className="flex-1 overflow-y-auto px-3 py-3">
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
  running,
  onStop,
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  canSend: boolean;
  onOpen: () => void;
  /** Whether the session is currently running, which is when the stop is meaningful. */
  running: boolean;
  onStop: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  if (!open) {
    // Pinned to the foot of the view. The label says "Reply"; the stop square
    // to its right halts the run — the same icon and style as the chat page.
    // It is inert unless a run is actually going, mirroring the header's own
    // stop, but stays visible so the control is where it is expected.
    return (
      <div className="border-t border-line bg-surface">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={onOpen}
            className="flex-1 text-left rounded-xl border border-line bg-raised/60 px-3 py-2 text-sm text-fg transition hover:bg-fg/5"
          >
            {t("Reply")}
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={!running}
            aria-label={t("Stop generation")}
            title={t("Stop generation (Esc)")}
            className={`prompt-action prompt-stop ${running ? "" : "pointer-events-none opacity-40"}`}
          >
            <LuSquare aria-hidden className="h-4 w-4" fill="currentColor" />
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
