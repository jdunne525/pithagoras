import type { SessionStatus } from "../api";
import { labelOf, msg } from "../i18n";

const LABEL: Record<SessionStatus, string> = {
  running: msg("running"),
  idle: msg("idle"),
  error: msg("error"),
  interrupted: msg("interrupted — server restarted mid-run"),
};

/** How a task is doing, in the Tasks workspace: pending, running, stopped,
    failed, and completed once it is done. Kept apart from SessionStatus so the
    chat's statuses are untouched — a task is not a session here. */
export type TaskStatus = "pending" | "running" | "stopped" | "failed" | "completed";

const TASK_LABEL: Record<TaskStatus, string> = {
  pending: msg("pending"),
  running: msg("running"),
  stopped: msg("stopped"),
  failed: msg("failed"),
  completed: msg("completed"),
};

/**
 * How a chat is doing: the same everywhere a list of chats is shown. At rest
 * a dot; working, the app's π, breathing with a glow behind it — the way the
 * thinking in a chat breathes — rather than one more spinner or blinking dot.
 * Its title shimmers beside it (`working-text`), as "Thinking" does.
 */
export function StatusDot({
  status,
  taskStatus,
  className = "",
  bare = false,
}: {
  status?: SessionStatus;
  /** A task's status, when this marks a task rather than a chat. */
  taskStatus?: TaskStatus;
  className?: string;
  /**
   * Without its slot. In a list every mark takes the same 16px, so a title
   * stays put when its chat starts or stops; a badge placed on its own does
   * not need one.
   */
  bare?: boolean;
}) {
  if (taskStatus) {
    // A task working shows the same breathing π as a chat; the others are
    // plain coloured dots, their colour carrying the state on its own.
    return taskStatus === "running" ? (
      <span className={`status-working ${bare ? className : ""}`} title={labelOf(TASK_LABEL, "running")} role="img" aria-label={labelOf(TASK_LABEL, "running")}>
        <span aria-hidden>π</span>
      </span>
    ) : (
      <span className={`status-dot is-${taskStatus} ${bare ? className : ""}`} title={labelOf(TASK_LABEL, taskStatus)} role="img" aria-label={labelOf(TASK_LABEL, taskStatus)} />
    );
  }

  const mark =
    status === "running" ? (
      <span className={`status-working ${bare ? className : ""}`} title={labelOf(LABEL, "running")} role="img" aria-label={labelOf(LABEL, "running")}>
        <span aria-hidden>π</span>
      </span>
    ) : (
      <span className={`status-dot is-${status!} ${bare ? className : ""}`} title={labelOf(LABEL, status!)} role="img" aria-label={labelOf(LABEL, status!)} />
    );
  return bare ? mark : <span className={`status-slot ${className}`}>{mark}</span>;
}

/** A chat's title while it works: it shimmers, as "Thinking" does in the chat. */
export const workingText = (status: SessionStatus) => (status === "running" ? "working-text" : "");
