import { useMemo } from "react";
import type { PortalEvent } from "../api";
import { buildTranscript } from "../transcript";
import { Streamdown } from "streamdown";
import { CompactionMarker, ThinkingBlock, ToolCall } from "./ChatActivity";
import { CommandLine } from "./CommandLine";

/** A reply arrives token at a time, so an incomplete assistant message is
briefly malformed markdown — an unclosed fence, a half-written link. A strict
renderer flickers between interpretations as it lands, so this parses
incomplete markdown with a single stable interpretation instead. */
const assistantText = (text?: string) => (text ?? "").replace(/<\/?think(ing)?>/gi, "");

/**
 * One attempt's conversation, rendered from its session's events the same way
 * the main chat renders its own — ThinkingBlock and ToolCall for agent work,
 * Streamdown for answers, the colored boxes for notices — but read-only and
 * without the composer. It is used once per open attempt, so several attempts
 * of a Task are never stacked in one scroll; switching an attempt swaps the
 * whole transcript.
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

  if (items.length === 0) {
    return (
      <div role="status" className="flex h-full items-center justify-center py-16">
        <span className="text-fg-muted">No activity yet.</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 py-6">
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <div key={item.id} className="flex justify-end">
              <div className="max-w-[90%] rounded-2xl rounded-br-md bg-raised px-3 py-2 text-sm leading-relaxed text-fg whitespace-pre-wrap">
                {item.text}
              </div>
            </div>
          );
        }
        if (item.kind === "assistant") {
          return (
            <div key={item.id} className="max-w-[90%]">
              {item.thinking && (
                <ThinkingBlock
                  thinking={item.thinking}
                  streaming={running && !item.done && !item.text}
                  since={item.thinkingSince}
                  until={item.thinkingUntil}
                />
              )}
              {item.text && (
                <div className="md text-sm leading-relaxed text-fg">
                  <Streamdown
                    parseIncompleteMarkdown
                    animated={{ animation: "blurIn", duration: 240, sep: "word" }}
                    isAnimating={running && !item.done}
                    caret={running && !item.done ? "circle" : undefined}
                    shikiTheme={["github-light", "github-dark"]}
                  >
                    {assistantText(item.text)}
                  </Streamdown>
                </div>
              )}
            </div>
          );
        }
        if (item.kind === "compaction") {
          return (
            <div key={item.id} className="chat-row">
              <CompactionMarker item={item} />
            </div>
          );
        }
        if (item.kind === "command") {
          return (
            <div key={item.id} className="chat-row">
              <CommandLine item={item} />
            </div>
          );
        }
        if (item.kind === "tool") {
          return (
            <div key={item.id} className="tool-row space-y-0.5">
              <ToolCall item={item} />
              {item.picture && (
                <a
                  href={`/api/sessions/${sessionId}/images/${encodeURIComponent(item.picture.path)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-1 mt-0.5 block w-fit"
                  title={item.picture.title ?? item.picture.path}
                >
                  <img
                    src={`/api/sessions/${sessionId}/images/${encodeURIComponent(item.picture.path)}`}
                    alt={item.picture.title ?? item.picture.path}
                    loading="lazy"
                    className="max-h-80 max-w-full rounded-lg border border-line object-contain"
                  />
                </a>
              )}
            </div>
          );
        }
        return (
          <div
            key={item.id}
            className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
              item.tone === "error"
                ? "bg-danger/10 text-danger"
                : item.tone === "warn"
                  ? "bg-warn/10 text-warn"
                  : "bg-raised/60 text-fg-muted"
            }`}
          >
            {item.portal ? item.text : item.text}
          </div>
        );
      })}
    </div>
  );
}
