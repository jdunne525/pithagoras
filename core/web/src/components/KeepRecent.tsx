import { useCallback, useRef } from "react";
import { api, type CompactionSettings } from "../api";
import { formatTokens } from "../transcript";
import { t } from "../i18n";

/**
 * How much of a conversation compaction leaves alone.
 *
 * The number that decides how full a session is *after* it has been compacted:
 * the most recent stretch is kept word for word and only what is older gets
 * summarised. pi's default is 20,000 tokens, which on a 64k model is a third of
 * the window spent before the summary is even added — so a compacted session
 * reads as still half full and it looks as though compaction did nothing.
 *
 * A slider rather than a number field because the useful question is not "how
 * many tokens" but "how much of my window", and that is a shape, not a figure.
 */

/** The API's own floor, so a stored value can always be shown as what it is. */
const MIN = 1_000;
const STEP = 1_000;
/** What pi leaves free at the top of the window has its own span: it is a share of the window, not a share of the conversation. */
const RESERVE_MIN = 1_000;
const RESERVE_FALLBACK_MAX = 32_000;
/**
 * Where the slider ends when the window is unknown.
 *
 * Not the API's ceiling of 500,000: a slider spanning that would put every
 * useful value in its first few pixels. A value already above this raises the
 * end instead, so a setting made elsewhere is never misrepresented or clamped
 * by a control that merely cannot draw it.
 */
const FALLBACK_MAX = 48_000;

type SliderProps = {
  value: number;
  onChange: (next: number) => void;
  /** Fired when the drag ends, so a save is not sent on every pixel. */
  onCommit?: (next: number) => void;
  /** The model's window, when it is known — turns tokens into a proportion. */
  contextWindow?: number;
  disabled?: boolean;
  /** What the control is called. The chat's card names the model the number is for. */
  label?: string;
  /** The least the number may be, as the setting itself defines it. */
  floor?: number;
  /** How far the slider reaches into the window: keep-recent spans the whole of it, keep-free half. */
  capShare?: number;
  /** Where the slider ends when the window is unknown. */
  fallbackMax?: number;
  /** What the control is called for the screen reader, which the visible label may not say. */
  ariaLabel?: string;
};

export function KeepRecent({
  value,
  onChange,
  onCommit,
  contextWindow,
  disabled,
  label,
  floor = MIN,
  capShare = 1,
  fallbackMax = FALLBACK_MAX,
  ariaLabel = t("Tokens kept verbatim by compaction"),
}: SliderProps) {
  const ceiling =
    contextWindow && contextWindow > floor ? Math.min(contextWindow * capShare, 200_000) : fallbackMax;
  const max = Math.max(ceiling, value);
  const clamped = Math.min(Math.max(value, floor), max);
  const share = contextWindow ? (clamped / contextWindow) * 100 : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-fg-subtle">{label ?? t("Keep recent")}</span>
        <span className="tabular-nums text-xs text-fg">
          {t("{n} tokens", { n: formatTokens(clamped) })}
          {share !== null && <span className="ml-1 text-fg-faint">· {t("{n}% of window", { n: share.toFixed(0) })}</span>}
        </span>
      </div>
      <input
        type="range"
        min={MIN}
        max={max}
        step={STEP}
        value={clamped}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        aria-label={ariaLabel}
        className="mt-1.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-raised accent-accent disabled:opacity-40"
      />
      <div className="mt-1 flex justify-between text-[10px] text-fg-faint">
        <span>{formatTokens(floor)}</span>
        <span>{formatTokens(max)}</span>
      </div>
    </div>
  );
}

/**
 * Save the value, in order, and only the value that is still current.
 *
 * A slider driven from the keyboard fires a commit per keypress, so several
 * saves are asked for in quick succession. Two problems, and guarding the
 * callbacks only solves the visible one.
 *
 * Requests do not have to come back in the order they were sent. An earlier
 * reply landing last would repaint the control with a value the server no
 * longer holds — the number appears to jump backwards on its own. Worse, an
 * earlier request can *arrive* last, and then the server ends up storing the
 * older value while the control quite correctly shows the newer one. No amount
 * of care on the client's side of the reply fixes that; the writes themselves
 * have to be ordered.
 *
 * So they run one at a time, and a value that a newer commit has already
 * replaced is dropped when its turn comes rather than sent — the newer one is
 * behind it in the queue and will write. Dragging a slider across twenty steps
 * makes two requests, not twenty, and the last one holds the value you left it
 * on.
 *
 * All of this is module level rather than per component: it is one file pi
 * reads, the two sliders of keep-recent and keep-free and the three places that
 * offer them (the chat's context card, the settings page) must not race each
 * other either, and they do write into one `compaction` object.
 *
 * `serialSaver` (serial-saver.ts) orders the saves of the other settings the
 * same way, one saver to a component. This one is not built on it for two
 * reasons: its queue has to be shared by both places, and a failed save does
 * not drop the value waiting behind it here (the newest is still sent, and its
 * own failure is the one told), where a saver gives up with the failure.
 */
let queue: Promise<unknown> = Promise.resolve();
/** How many saves of each number have been asked for, per number. */
const newest: Record<string, number> = {};

/** Skipped rather than sent, when something newer is already waiting behind it. */
const SUPERSEDED = Symbol("superseded");

/**
 * One save, queued behind whatever save is already on its way. `kind` says which
 * number it writes: the newest value of *that* number supersedes an older one of
 * the same, and a save of the other number waiting in the same queue is left
 * alone — "Keep recent" and "Keep free" are two settings, and one moving must
 * not swallow the other's pending write.
 */
function queueSave<T>(kind: string, run: () => Promise<T>): Promise<T | typeof SUPERSEDED> {
  const mine = (newest[kind] ?? 0) + 1;
  newest[kind] = mine;
  const send = (): unknown => (mine === newest[kind] ? run() : SUPERSEDED);
  const next = queue.then(send, send) as Promise<T | typeof SUPERSEDED>;
  queue = next.then(
    () => {},
    () => {},
  );
  return next;
}

export function useKeepRecentSave(
  onSaved: (compaction: CompactionSettings, refreshed: number) => void,
  onFailed: (error: Error) => void,
  /**
   * Save this as one model's own number, keyed as pi keys it. Left out, the
   * save is the plain setting every chat inherits. The chat's context card
   * passes its model: a chat whose summary cannot be written needs its model
   * to have room, and pi has no per-chat shape to be told that in.
   */
  modelKey?: string,
) {
  const saved = useRef(onSaved);
  const failed = useRef(onFailed);
  saved.current = onSaved;
  failed.current = onFailed;

  return useCallback(
    async (tokens: number) => {
      const run = () =>
        api.saveSettings(modelKey ? { keepRecentTokens: tokens, forModel: modelKey } : { keepRecentTokens: tokens });
      try {
        const r = await queueSave("keepRecent", run);
        if (r === SUPERSEDED) return;
        saved.current(r.compaction, r.refreshed);
      } catch (e) {
        failed.current(e as Error);
      }
    },
    // The model the number is written as. A chat that changes its model gets a
    // saver that writes for the model it is on now.
    [modelKey],
  );
}

/**
 * Save "Keep free" — the reserve, in pi's words.
 *
 * The same queue as keep-recent: the two live in one file and one save writes
 * only the number it was asked for, so two sliders released one after the other
 * must not land on each other, and they must not be written by one request that
 * carries a stale value of the other.
 */
export function useKeepFreeSave(
  onSaved: (compaction: CompactionSettings, refreshed: number) => void,
  onFailed: (error: Error) => void,
  /** Save it as one model's own number. See useKeepRecentSave. */
  modelKey?: string,
) {
  const saved = useRef(onSaved);
  const failed = useRef(onFailed);
  saved.current = onSaved;
  failed.current = onFailed;

  return useCallback(
    async (tokens: number) => {
      const run = () =>
        api.saveSettings(modelKey ? { reserveTokens: tokens, forModel: modelKey } : { reserveTokens: tokens });
      try {
        const r = await queueSave("keepFree", run);
        if (r === SUPERSEDED) return;
        saved.current(r.compaction, r.refreshed);
      } catch (e) {
        failed.current(e as Error);
      }
    },
    [modelKey],
  );
}

/**
 * "Keep free": what pi leaves empty at the top of the window.
 *
 * pi compacts a chat above window − reserve, so this is the number that decides
 * how much the model has to write in one answer when it compacts. A bigger one
 * compacts sooner and more often, with a head small enough to be written; a
 * smaller one lets the chat arrive at the summariser with more than one answer
 * can hold — which is the failure the control exists for.
 */
export function KeepFree(props: SliderProps) {
  return (
    <KeepRecent
      {...props}
      floor={RESERVE_MIN}
      capShare={0.5}
      fallbackMax={RESERVE_FALLBACK_MAX}
      ariaLabel={t("Tokens kept free at the end of the window")}
    />
  );
}
