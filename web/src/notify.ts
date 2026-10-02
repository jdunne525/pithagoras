import { useState } from "react";
import { local } from "./safe-storage";

const KEY = "notifyWhenAway";

/** ntfy topic, kept in this browser's storage alongside the other preferences. */
const NTFY_TOPIC_KEY = "ntfyTopic";
/** Whether ntfy push is on — separate from the browser's own notifications. */
const NTFY_ENABLED_KEY = "ntfyEnabled";

/**
 * `unsupported`: no Notification API, or a page that is not a secure context —
 * browsers refuse them over plain HTTP, which is how a portal on a home server
 * is often reached. `denied`: the browser was told no, and only its own site
 * settings can undo that.
 */
export type NotifyState = "unsupported" | "denied" | "off" | "on";

export function notifyState(): NotifyState {
  if (typeof Notification === "undefined" || !window.isSecureContext) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && local.get(KEY) === "on" ? "on" : "off";
}

/** Asks the browser for permission, which needs a click — this is called from one. */
export async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === "unsupported") return "unsupported";
  try {
    if (Notification.permission !== "granted") await Notification.requestPermission();
  } catch {
    // Older browsers take a callback instead; the state below says what happened.
  }
  if (Notification.permission === "granted") local.set(KEY, "on");
  return notifyState();
}

export function disableNotifications(): void {
  local.set(KEY, "off");
}

/** The ntfy topic to push to, trimmed, or empty when none has been set. */
export function getNtfyTopic(): string {
  return (local.get(NTFY_TOPIC_KEY) || "").trim();
}

/** Set the ntfy topic. Empty clears it, so an unset topic reads as none. */
export function setNtfyTopic(topic: string): void {
  const value = topic.trim();
  if (value) local.set(NTFY_TOPIC_KEY, value);
  else local.remove(NTFY_TOPIC_KEY);
}

/** Whether ntfy push is on: enabled and a topic set to push to. */
export function isNtfyEnabled(): boolean {
  return local.get(NTFY_ENABLED_KEY) === "on" && !!getNtfyTopic();
}

/** Whether ntfy can reach the person — an alias the poller reads. */
export const ntfyActive = isNtfyEnabled;

/** Turn ntfy push on or off, keeping the topic the person set. */
export function setNtfyEnabled(on: boolean): void {
  if (on) local.set(NTFY_ENABLED_KEY, "on");
  else local.remove(NTFY_ENABLED_KEY);
}

export function useNotifyState() {
  const [state, setState] = useState<NotifyState>(notifyState);
  return [
    state,
    async (on: boolean) => {
      if (on) setState(await enableNotifications());
      else {
        disableNotifications();
        setState(notifyState());
      }
    },
  ] as const;
}

/**
 * Push a notification out through ntfy, independently of the browser's own.
 *
 * This is what reaches a phone or desktop while this tab is closed or hidden —
 * exactly when a browser notification cannot. It posts to the public ntfy.sh
 * instance under the configured topic, which is a random string only the owner
 * subscribes to, so nothing here is secret beyond the topic itself.
 *
 * @param title shown as the notification's title
 * @param message shown as the notification's body
 * @param priority ntfy priority; `urgent` pings harder, for a chat that needs an answer
 */
export function sendNtfy(title: string, message: string, tag: string, priority: "high" | "urgent" = "high"): void {
  if (!isNtfyEnabled()) return;
  const topic = getNtfyTopic();
  if (!topic) return;

  const url = `https://ntfy.sh/${encodeURIComponent(topic)}`;
  // ntfy headers are ASCII-only; strip anything non-ASCII from user-facing text.
  const ascii = (s: string) => s.replace(/[^\x00-\x7F]/g, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  fetch(url, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": "pithagoras/1.0",
      Title: ascii(title) || title,
      Tag: ascii(tag) || tag,
      Tags: "robot",
      Priority: priority,
    },
    // Keep well under the ~4 KB many push gateways accept, so the body survives.
    body: message.slice(0, 4096),
  })
    .then((res) => {
      if (res.ok) console.log(`[pithagoras] ntfy notification sent: ${title}`);
      else console.warn(`[pithagoras] ntfy notification failed: HTTP ${res.status}`);
    })
    .catch((err) => {
      if (err instanceof Error && err.name === "AbortError") console.warn("[pithagoras] ntfy notification timed out");
      else console.warn(`[pithagoras] ntfy notification error: ${(err as Error).message}`);
    })
    .finally(() => clearTimeout(timer));
}

/** Whether the person is somewhere else: another tab, another window, another app. */
const away = () => document.hidden || !document.hasFocus();

// Set once the tab has gone hidden or lost focus, cleared the moment it comes
// back to the foreground. It stays true across polls, so a finish detected only
// when the tab returns still counts as something missed while away — even when
// the OS had paused the tab and it could not notice the finish itself.
let sinceAway = false;
const markAway = () => { sinceAway = true; };
const markBack = () => { sinceAway = false; };
try {
  document.addEventListener("visibilitychange", () => (document.hidden ? markAway() : markBack()));
  window.addEventListener("blur", markAway);
  window.addEventListener("focus", markBack);
} catch {
  // Not every environment exposes these; without them we fall back to the
  // present-looking check alone.
}

/**
 * A notification, when a chat finishes or needs an answer.
 *
 * Someone reading the chat that just finishes does not need to be told — so the
 * browser's own popup flashes only while the person is away, not over the chat
 * they are watching. Ntfy reaches another device, so it pushes whenever the
 * person has been away since the last time this tab looked at them: now, or in
 * a period the tab could not watch because the OS paused it. Coming back to a
 * focused tab means the chat was watched, so neither channel fires.
 */
export function notifyIfAway(title: string, body: string, tag: string, onOpen: () => void, priority: "high" | "urgent" = "high"): void {
  // The browser's own popup only flashes while the person is away.
  if (away() && notifyState() === "on") {
    try {
      // One per chat: a second replaces the first instead of stacking.
      const n = new Notification(title, { body, tag, icon: "/icon-192.png" });
      n.onclick = () => {
        window.focus();
        onOpen();
        n.close();
      };
    } catch {
      // Some mobile browsers only allow them from a service worker.
    }
  }
  // Ntfy pushes whenever the person has been away, including an away period the
  // tab only now returns from.
  if (sinceAway) {
    void sendNtfy(title, body, tag, priority);
  }
}
