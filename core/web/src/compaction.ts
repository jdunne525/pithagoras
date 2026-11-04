import type { CompactionSettings } from "./api";

/**
 * The compaction numbers, as pi resolves them for one model.
 *
 * pi keeps two shapes of the same two numbers: the plain ones, which are every
 * chat's, and `compaction.modelOverrides["provider/model"]`, which is one
 * model's own and wins over the plain ones for the chats that use it. Only
 * keep-recent and reserve are scoped this way; the switch is one switch.
 *
 * The portal points a person at these numbers when a chat's compaction cannot
 * finish: the summary is written by the model in one answer, and a chat that
 * keeps more of its recent turns leaves less to write. That room is asked for
 * through the chat's model, because it is the model's answer that writes it.
 */

/**
 * A model as pi keys its own compaction numbers. Nothing when the chat cannot name one.
 *
 * sdk-client's placeholder for a chat whose pi cannot say what it is running is
 * "unknown"/"unknown" (a container's pi, an older one). A key built from it is a
 * number stored where pi never looks — pi matches its own `provider/model` — so it
 * is no room at all, and the card that wrote it would say a number that does
 * nothing. Such a chat has no key: what it compacts at is the plain setting, which
 * is what its pi reads, and the card says so on the inherited fields.
 */
export function modelKeyOf(provider?: string, modelId?: string): string | undefined {
  const p = provider?.trim();
  const m = modelId?.trim();
  if (!p || !m) return undefined;
  if (p === "unknown" || m === "unknown") return undefined;
  return `${p}/${m}`;
}

/**
 * pi's own numbers, for a read that has no number of its own.
 *
 * A page kept by the browser can meet a portal older than it — a portal taken
 * back a version, restarted mid-upgrade — whose answer predates the reserve.
 * A card that drew `undefined` on a slider is a slider on `NaN`, so a value the
 * read does not give is shown as what pi itself gives every chat.
 */
const PI_DEFAULTS = { keepRecentTokens: 20_000, reserveTokens: 16_384 };

function tokens(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** What a chat on this model keeps recent: its own number where it has one, the plain one otherwise. */
export function effectiveKeepRecent(settings: CompactionSettings, modelKey?: string): number {
  const own = modelKey ? settings.modelOverrides?.[modelKey]?.keepRecentTokens : undefined;
  return tokens(own ?? settings.keepRecentTokens, PI_DEFAULTS.keepRecentTokens);
}

/**
 * What a chat on this model keeps free: compaction starts above window − this.
 *
 * The other half of the same arithmetic. A chat that compacts late arrives at
 * the summariser with a head too big for one answer to write, which is the
 * failure the room controls exist for; a chat that keeps more free compacts
 * sooner, with less to write, and pays for it in more compactions.
 */
export function effectiveReserve(settings: CompactionSettings, modelKey?: string): number {
  const own = modelKey ? settings.modelOverrides?.[modelKey]?.reserveTokens : undefined;
  return tokens(own ?? settings.reserveTokens, PI_DEFAULTS.reserveTokens);
}

/** Whether this model was given its own keep-free, which is what the card says on its field. */
export function hasOwnReserve(settings: CompactionSettings, modelKey?: string): boolean {
  return modelKey !== undefined && settings.modelOverrides?.[modelKey]?.reserveTokens !== undefined;
}

/** Whether this model was given its own number, which is what the card says on its slider. */
export function hasOwnKeepRecent(settings: CompactionSettings, modelKey?: string): boolean {
  return modelKey !== undefined && settings.modelOverrides?.[modelKey]?.keepRecentTokens !== undefined;
}

/**
 * The two numbers as one chat's card shows them, plus whether each is the model's own.
 *
 * The card draws both sliders from one read of pi's file, and says on each field
 * whether the number there is this model's own or the one every model inherits —
 * which is what a person needs to know before raising it for a chat that is stuck.
 */
export type Room = {
  keepRecent: number;
  keepFree: number;
  ownRecent: boolean;
  ownFree: boolean;
};

export function roomOf(settings: CompactionSettings, modelKey?: string): Room {
  return {
    keepRecent: effectiveKeepRecent(settings, modelKey),
    keepFree: effectiveReserve(settings, modelKey),
    ownRecent: hasOwnKeepRecent(settings, modelKey),
    ownFree: hasOwnReserve(settings, modelKey),
  };
}
