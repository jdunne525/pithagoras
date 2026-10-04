/**
 * Push notifications through ntfy.sh, sent from the server rather than the
 * browser: a finished chat or a waiting question alerts your phone or desktop
 * whether or not any page is open. The portal keeps only three keys here —
 * enabled, the topic, and how long a response must take before it counts as
 * "slow enough to announce" — stored like the other settings, in the database.
 *
 * A poller, started once the server is listening, compares the current state
 * against what it saw last: only transitions that happen while it is watching
 * are news. That is what lets a restart stay quiet about chats already running
 * and questions already waiting when it comes up.
 */
import http from "node:http";
import https from "node:https";
import { getDb, eventTime } from "./db.js";
import { pendingQuestions, type QuestionRow } from "./questions.js";

export interface NtfyConfig {
  /** Whether push alerts are on at all. */
  enabled: boolean;
  /** The topic the user subscribes to in their ntfy app. */
  topic: string;
  /**
   * A response faster than this many seconds is not worth announcing — a quick
   * reply the person could see for themselves. Defaults to 60.
   */
  minResponseSeconds: number;
}

const KEY_ENABLED = "ntfy.enabled";
const KEY_TOPIC = "ntfy.topic";
const KEY_MIN = "ntfy.min_response_seconds";
const DEFAULT_MIN = 60;

/** What the page shows and edits: its own view of these three settings. */
export function readNtfyConfig(): NtfyConfig {
  const rows = getDb().prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)").all(
    KEY_ENABLED,
    KEY_TOPIC,
    KEY_MIN,
  ) as { key: string; value: string | null }[];
  const map = new Map(rows.map((r) => [r.key, r.value ?? ""]));
  const topic = (map.get(KEY_TOPIC) ?? "").trim();
  const rawMin = Number(map.get(KEY_MIN));
  const min = Number.isFinite(rawMin) && rawMin >= 0 ? Math.floor(rawMin) : DEFAULT_MIN;
  return { enabled: map.get(KEY_ENABLED) === "true", topic, minResponseSeconds: min };
}

/**
 * Save whatever fields are given, leaving the rest untouched. An empty topic
 * or an explicit false clears the enable flag rather than pinning a blank one.
 */
export function saveNtfyConfig(patch: Partial<NtfyConfig>): NtfyConfig {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const clear = getDb().prepare("DELETE FROM settings WHERE key = ?");
  const apply = (key: string, value: string | undefined) => {
    if (value === undefined || value.trim() === "") clear.run(key);
    else upsert.run(key, value.trim());
  };
  apply(KEY_ENABLED, patch.enabled === true ? "true" : patch.enabled === false ? "false" : undefined);
  apply(KEY_TOPIC, patch.topic);
  const min = patch.minResponseSeconds === undefined ? undefined : String(Math.floor(patch.minResponseSeconds));
  apply(KEY_MIN, min);
  return readNtfyConfig();
}

/**
 * The topic is a random string only the user's apps know, so posting to the
 * public instance reaches just them. Non-ASCII is stripped from headers: ntfy
 * rejects anything outside the ASCII range there.
 */
function asciiOnly(text: string): string {
  return text.replace(/[^\x00-\x7F]/g, "");
}

/**
 * Fire one notification. Returns whether the request went out with a 2xx.
 * Silent — never throws — because a failed alert should not disturb a chat.
 */
export async function sendNtfy(title: string, message: string, priority: "default" | "high" | "max" = "high"): Promise<boolean> {
  const config = readNtfyConfig();
  if (!config.enabled || !config.topic) return false;

  const url = new URL(`https://ntfy.sh/${encodeURIComponent(config.topic.trim())}`);
  const lib = url.protocol === "https:" ? https : http;
  const body = asciiOnly(message).slice(0, 4096);

  return await new Promise<boolean>((resolve) => {
    const req = lib.request(
      url.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "User-Agent": "pithagoras/1.0",
          Title: asciiOnly(title) || title,
          Tags: "bell,message",
          Priority: priority,
        },
      },
      (res) => {
        res.resume(); // drain; the response carries nothing we need
        const status = res.statusCode!;
        if (status < 200 || status >= 300) console.warn(`[portal] ntfy notification failed: HTTP ${status}`);
        resolve(status >= 200 && status < 300);
      },
    );
    req.on("error", (e) => {
      console.warn(`[portal] ntfy notification error: ${e.message}`);
      resolve(false);
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("ntfy timed out"));
      console.warn("[portal] ntfy notification timed out");
    });
    req.write(body);
    req.end();
  });
}

// ── the poller ────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/** Last known status per session, so only transitions count as news. */
const lastStatus = new Map<string, string>();
/** Sessions already announced as finished, until they run again. */
const notifiedSessions = new Set<string>();
/** Questions already announced as waiting, until answered. */
const notifiedQuestions = new Set<string>();
/**
 * Sessions whose running turn was cut short by a mid-turn compaction and which
 * a resume message has just been sent into. Their status can read idle for one
 * poll between the aborted turn and the resume that follows the compaction; that
 * idle is not a finish, so the poller skips it. The resumed turn's own natural
 * end — the only finish worth announcing here — is left to count normally.
 */
const suppressedFinishes = new Set<string>();

interface SessionRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Every session and its current status, oldest-changed first so finishes surface in order. */
function sessionsByStatus(): SessionRow[] {
  return getDb().prepare("SELECT id, title, status, created_at, updated_at FROM sessions ORDER BY updated_at ASC").all() as SessionRow[];
}

/**
 * How long ago, in seconds, a session started — used to skip announcing a reply
 * arrived too quickly to have been missed. The stored time is UTC (SQLite's
 * `datetime('now')`) but a bare string `Date.parse` reads as local, which lands
 * hours off and can even read as the future, giving a negative age that would
 * suppress every alert; `eventTime` parses it as UTC either way.
 */
function durationSeconds(createdAt: string | null | undefined): number | null {
  const start = eventTime(createdAt ?? undefined);
  return start == null ? null : Math.floor((Date.now() - start) / 1000);
}

/**
 * How long between two instants, in brief human words — "3 min", "2 hrs 5 min",
 * or a raw seconds count under a minute. Empty when either time is missing or
 * they are in the wrong order, so a caller can drop the field rather than show
 * nonsense. Times come back already parsed by `eventTime`, both UTC.
 */
function humanDuration(startMs: number | undefined, endMs: number | undefined): string {
  if (startMs == null || endMs == null || endMs <= startMs) return "";
  let secs = Math.floor((endMs - startMs) / 1000);
  const hrs = Math.floor(secs / 3600);
  secs -= hrs * 3600;
  const mins = Math.floor(secs / 60);
  secs -= mins * 60;
  if (hrs > 0) return `${hrs} hr${hrs === 1 ? "" : "s"}${mins > 0 ? ` ${mins} min` : ""}`.trim();
  if (mins > 0) return `${mins} min${mins === 1 ? "" : "s"}`;
  return `${secs}s`;
}

/** A one-line "Took …" field for how a session ran, from start to its end. */
function tookField(createdAt: string | null | undefined, updatedAt: string | null | undefined): string {
  const d = humanDuration(eventTime(createdAt ?? undefined), eventTime(updatedAt ?? undefined));
  return d ? `Took ${d}` : "";
}

/**
 * The agent's final answer for a session: the text of its last assistant
 * message, with any thinking excluded — that is the part a person would have
 * missed, not the model's private reasoning. Undefined when there was no such
 * answer (the run was stopped, or only ran tools), so the caller can fall back
 * to a plain status word instead. Read from stored events, since by the time a
 * chat is finished the live stream is long gone.
 */
function finalResponse(sessionId: string): string | undefined {
  const row = getDb().prepare(
    "SELECT payload FROM events WHERE session_id = ? AND type = 'message_end'"
      + " AND json_extract(payload, '$.message.role') = 'assistant' ORDER BY seq DESC LIMIT 1",
  ).get(sessionId) as { payload: string } | undefined;
  if (!row) return undefined;
  let p: unknown;
  try {
    p = JSON.parse(row.payload);
  } catch {
    return undefined;
  }
  const content = (p as { message?: { content?: { type?: string; text?: string }[] } })?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return text.trim();
}

/**
 * Forget alerts fired before this restart, but keep a snapshot of what is
 * currently running or waiting so those are not re-announced as news on the
 * next tick after coming up.
 */
function seedFromCurrent(): void {
  for (const row of sessionsByStatus()) {
    lastStatus.set(row.id, row.status);
    if (row.status !== "running") notifiedSessions.delete(row.id);
  }
  for (const q of pendingQuestions() as QuestionRow[]) notifiedQuestions.add(q.id);
}

/** Start polling. Safe to call once at startup; calling twice does nothing. */
export function startNtfyNotifications(intervalMs = 20_000): void {
  if (timer) return;
  seedFromCurrent();
  timer = setInterval(() => void tick().catch((e) => console.error(`[portal] ntfy poll failed: ${e.message}`)), intervalMs);
  // Not strong enough to hold the process open on its own.
  timer.unref?.();
  console.log(`[portal] ntfy push notifications polling every ${Math.round(intervalMs / 1000)}s`);
}

/**
 * Mark a session whose turn a compaction just disrupted, so the next idle it
 * shows — the moment between the aborted turn and the resume — is never called
 * a finished chat. Call this when the compaction is detected, before the resume.
 */
export function markCompactionResume(sessionId: string): void {
  suppressedFinishes.add(sessionId);
}

export function stopNtfyNotifications(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  const config = readNtfyConfig();
  if (!config.enabled || !config.topic) {
    // Off: drop past alerts so turning it back on can fire again, and forget
    // which sessions were running so none are announced as news.
    notifiedSessions.clear();
    notifiedQuestions.clear();
    for (const row of sessionsByStatus()) lastStatus.set(row.id, row.status);
    return;
  }
  await scanFinished(config);
  await scanPendingQuestions(config);
}

interface FinishedNotification {
  title: string;
  message: string;
}

/**
 * Build the "a chat finished" alert. The header is the project's name in bold;
 * beneath it a short "Took …" of how long the session ran, then the agent's own
 * final answer — its thinking left out, since that is what the person missed,
 * not the model's reasoning — takes the place of a plain "finished". When the
 * run left no answer to show (it was stopped, or only ran tools), the status
 * word stands in so the alert still says something true.
 */
function finishedNotification(
  label: string,
  status: string,
  createdAt: string | null | undefined,
  updatedAt: string | null | undefined,
  sessionId: string,
): FinishedNotification {
  const header = `**${asciiOnly(label)}**`;
  const lines = [header];
  const took = tookField(createdAt, updatedAt);
  if (took) lines.push(took);
  const response = finalResponse(sessionId);
  lines.push("", response || (status === "error" ? "finished with an error." : "finished."));
  return { title: asciiOnly(label), message: lines.join("\n") };
}

/** A chat that was running when last checked is now idle or an error — announce it. */
async function scanFinished(config: NtfyConfig): Promise<void> {
  // Reconcile any session we are resuming a compaction-interrupted turn for:
  // record whatever it reads now (idle from the aborted turn, or running again
  // once the resume has started) and stop watching it, so exactly the resumed
  // turn's own end is treated as a finish afterwards.
  for (const id of [...suppressedFinishes]) {
    const row = sessionsByStatus().find((r) => r.id === id);
    if (row) lastStatus.set(id, row.status);
    suppressedFinishes.delete(id);
  }
  for (const row of sessionsByStatus()) {
    const previous = lastStatus.get(row.id);
    if (previous === "running" && (row.status === "idle" || row.status === "error")) {
      lastStatus.set(row.id, row.status);
      if (notifiedSessions.has(row.id)) continue;
      // Too quick to be worth pinging about — the person likely saw it arrive.
      const seconds = durationSeconds(row.created_at);
      if (seconds != null && seconds < config.minResponseSeconds) continue;
      const label = row.title.trim() || "a chat";
      const { title, message } = finishedNotification(label, row.status, row.created_at, row.updated_at, row.id);
      await sendNtfy(title, message);
      notifiedSessions.add(row.id);
    } else if (row.status === "running") {
      // Track it again: an alert may have been missed while disabled.
      lastStatus.set(row.id, "running");
      notifiedSessions.delete(row.id);
    } else {
      lastStatus.set(row.id, row.status);
    }
  }
}

/** A question still unanswered, newly arrived since the last check. */
async function scanPendingQuestions(config: NtfyConfig): Promise<void> {
  for (const q of pendingQuestions() as QuestionRow[]) {
    if (notifiedQuestions.has(q.id)) continue;
    const started = eventTime(q.asked_at);
    if (started == null) continue;
    const waited = (Date.now() - started) / 1000;
    if (waited >= config.minResponseSeconds) {
      const asker = q.person_name ? `${q.person_name} asked:` : "A question is waiting:";
      const message = `${asker} ${q.question}`;
      await sendNtfy("Answer needed", message);
      notifiedQuestions.add(q.id);
    }
  }
}
