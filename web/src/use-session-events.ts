import { useEffect, useState } from "react";
import type { PortalEvent } from "./api";

/**
 * One session's whole event log, replayed first then streamed live.
 *
 * Opening the stream from `since=0` replays every stored event before it
 * begins delivering new ones, so a single subscription carries an attempt's
 * complete history and its next token without two round-trips. The advanced
 * stream features the app root handles (removing messages, alternate
 * versions, canvas updates, dialogs) are not part of a Task transcript, so
 * this listens only for the conversation events and the session status —
 * enough to render, and enough to know when a run is still going.
 */
export function useSessionEvents(sessionId: string | null): {
  events: PortalEvent[];
  /** True while the session is actively working, i.e. its last status was
    running and it was not aborted. Drives the transcript's streaming state. */
  running: boolean;
} {
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    // The latest live seq; the stream replays from 0 and continues from here.
    let seq = 0;

    const es = new EventSource(`/api/sessions/${sessionId}/events?since=0`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as PortalEvent & { seq: number };
      if (ev.type === "portal_status") {
        const payload = ev.payload as { status: string; aborted?: boolean };
        setRunning(payload.status === "running" && !payload.aborted);
      }
      // Live-only events carry a negative seq and must not advance the resume
      // point, though none occur in a Task transcript.
      if (ev.seq > 0) seq = ev.seq;
      setEvents((prev) => [...prev, ev]);
    };
    es.onerror = () => {
      // A dropped connection closes the stream; React remounts on the next
      // effect pass, but until then nothing updates. That is acceptable for
      // a Task view, which the user watches rather than depends on second by
      // second across network blips.
      if (!cancelled) es.close();
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [sessionId]);

  return { events, running };
}
