import { useEffect, useMemo, useState } from "react";
import type { DiagramPlugin } from "streamdown";
import type { PortalEvent } from "../api";
import { HAS_MERMAID, loadMermaidPlugin } from "../mermaid";
import { buildTranscript } from "../transcript";
import { useResolvedTheme } from "../theme";
import { TranscriptRow, type RowActions } from "./TranscriptRow";

/**
 * What a row can do, in a transcript nobody can answer in. The rows of the main
 * chat offer their actions through these; a Task's transcript is read-only, so
 * each of them does nothing. One object, made once: a row handed fresh functions
 * would draw again for every draw of the list (see `useStableActions`).
 */
const readOnly: RowActions = {
  openPicture: () => undefined,
  edit: () => undefined,
  cancelEdit: () => undefined,
  saveEdit: async () => undefined,
  retry: () => undefined,
  again: async () => undefined,
  remove: async () => undefined,
  dropQueued: async () => undefined,
  sendQueued: async () => undefined,
  switchVersion: () => undefined,
  trustFlagged: async () => false,
  isTrusted: () => false,
};

/**
 * One attempt's conversation, rendered from its session's events with the chat's
 * own row (`TranscriptRow`) so a Task's run shows exactly what the chat shows —
 * tool rows an extension can draw into, pictures, notices, answers, diagrams —
 * but read-only and without the composer. It is used once per open attempt, so
 * several attempts of a Task are never stacked in one scroll; switching an
 * attempt swaps the whole transcript.
 *
 * `running` drives streaming: while true, the last answer animates its caret
 * and its thinking block pulses, mirroring a live run.
 */
export function TaskTranscript({
  sessionId,
  events,
  running,
}: {
  sessionId: string;
  events: PortalEvent[];
  running: boolean;
}) {
  const items = useMemo(() => buildTranscript(events, { ended: !running }), [events, running]);

  // Diagrams, as in the chat: fetched only once an answer has a mermaid fence,
  // and handed the theme, since mermaid bakes its palette into the SVG.
  const wantsMermaid = useMemo(
    () => items.some((item) => item.kind === "assistant" && HAS_MERMAID.test(item.text ?? "")),
    [items],
  );
  const [mermaid, setMermaid] = useState<DiagramPlugin | null>(null);
  const theme = useResolvedTheme();
  const mermaidOptions = useMemo(
    () => ({ config: { theme: theme === "light" ? ("default" as const) : ("dark" as const) } }),
    [theme],
  );

  useEffect(() => {
    if (!wantsMermaid || mermaid) return;
    let live = true;
    loadMermaidPlugin().then(
      (plugin) => live && setMermaid(plugin),
      // A failed chunk fetch leaves the fence as a code block, which is still readable.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantsMermaid, mermaid]);

  if (items.length === 0) {
    return (
      <div role="status" className="flex h-full items-center justify-center py-16">
        <span className="text-fg-muted">No activity yet.</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-6">
      <div className="chat-list mx-auto w-full max-w-3xl space-y-3">
        {items.map((item) => (
          <TranscriptRow
            key={item.id}
            item={item}
            enter=""
            mine=""
            entering={false}
            running={running}
            editing={false}
            last={false}
            switching={false}
            sessionId={sessionId}
            mermaid={mermaid}
            mermaidOptions={mermaidOptions}
            act={readOnly}
          />
        ))}
      </div>
    </div>
  );
}
