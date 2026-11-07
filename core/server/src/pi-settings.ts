import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * pi's own settings file — the one the CLI writes and extensions read.
 *
 * The portal edits it (Advanced), scans it for extension keys, and reads its
 * `default*` entries as the fallback for new sessions, so the path lives in one
 * place rather than being rebuilt at each call site.
 */
export const piAgentDir = (): string => {
  // pi builds this from `os.homedir()`, and the portal's whole business with
  // pi's file — its compaction numbers, its provider writes, its repair of the
  // compaction switch — is worth nothing unless it lands on the file pi opens.
  // `os.homedir()` is what answers that: on Linux (the portal's own container,
  // where HOME is `/data/home`) it is HOME; on Windows it comes from
  // USERPROFILE, which is where pi's CLI keeps its file.
  //
  // `process.env.HOME` alone is not that. A portal started from a Windows shell
  // has no HOME, and fell back to `/data/home` — the container's home, read as a
  // path on the current drive — so it read a file that does not exist (compaction
  // as pi's defaults, every time) and wrote its own numbers where pi never looks,
  // while pi's real file kept the state one chat's failed compaction left in it.
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  let home = "";
  try {
    home = homedir();
  } catch {
    // No answer at all (no HOME, no password entry, no USERPROFILE): the
    // container's home, as before — a guess, and the only one left.
  }
  return path.join(home || process.env.HOME?.trim() || "/data/home", ".pi", "agent");
};

export const piSettingsPath = (): string => path.join(piAgentDir(), "settings.json");

export function readPiSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(piSettingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or malformed: callers fall back to their own defaults.
    return {};
  }
}

/** A project's own pi settings, in `.pi` in its folder; empty when it has none. */
export function readProjectPiSettings(folder: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(folder, ".pi", "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** A string setting from pi's file, or undefined if absent or the wrong type. */
export function piSetting(key: string): string | undefined {
  const value = readPiSettings()[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * How compaction is tuned, from pi's own file rather than the portal's.
 *
 * `keepRecentTokens` is the floor a compaction cannot go below: the most
 * recent stretch of conversation is kept verbatim and only what is older gets
 * summarised. pi's default of 20000 is most of a 64k window, which is why a
 * compacted session can still read as a third full.
 */
export interface CompactionSettings {
  enabled: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
  /**
   * pi's own per-model tuning, keyed "provider/model": a model given its own
   * numbers uses them and the plain values above are left to every other model.
   * This is the only compaction knob pi scopes to one model, which is why the
   * portal's remedy for a chat whose summary cannot be written goes here.
   */
  modelOverrides: Record<string, CompactionModelSettings>;
}

/** What one model is given its own, in pi's `compaction.modelOverrides`. */
export interface CompactionModelSettings {
  keepRecentTokens?: number;
  reserveTokens?: number;
}

/** pi's own defaults, repeated here so the UI can show what it is inheriting. */
export const COMPACTION_DEFAULTS: CompactionSettings = {
  enabled: true,
  keepRecentTokens: 20_000,
  reserveTokens: 16_384,
  modelOverrides: {},
};

/** A token count pi would accept for itself, or undefined for anything else. */
function tokenSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function readCompactionSettings(): CompactionSettings {
  const stored = readPiSettings().compaction;
  const c = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const raw = c.modelOverrides && typeof c.modelOverrides === "object" ? (c.modelOverrides as Record<string, unknown>) : {};
  const modelOverrides: Record<string, CompactionModelSettings> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const keep = tokenSetting(entry.keepRecentTokens);
    const reserve = tokenSetting(entry.reserveTokens);
    if (keep !== undefined) modelOverrides[key] = { ...(reserve !== undefined ? { reserveTokens: reserve } : {}), keepRecentTokens: keep };
    else if (reserve !== undefined) modelOverrides[key] = { reserveTokens: reserve };
  }
  return {
    enabled: c.enabled !== false,
    keepRecentTokens: tokenSetting(c.keepRecentTokens) ?? COMPACTION_DEFAULTS.keepRecentTokens,
    reserveTokens: tokenSetting(c.reserveTokens) ?? COMPACTION_DEFAULTS.reserveTokens,
    modelOverrides,
  };
}

/**
 * What a chat on this model compacts at: its own override when it has one,
 * the plain setting for every other model. Same order pi resolves in.
 */
export function effectiveCompactionTokens(
  settings: CompactionSettings,
  modelKey?: string,
): { keepRecentTokens: number; reserveTokens: number } {
  const own = modelKey ? settings.modelOverrides[modelKey] : undefined;
  return {
    keepRecentTokens: own?.keepRecentTokens ?? settings.keepRecentTokens,
    reserveTokens: own?.reserveTokens ?? settings.reserveTokens,
  };
}

/** The two numbers, as one of them was written for one model. */
export interface RoomPair {
  keepRecentTokens: number;
  reserveTokens: number;
}

/** Whose numbers a model is compacting on, and what the portal may do about them. */
export type RoomOwner =
  /** Nobody has tuned this model, or the numbers there are the portal's own: it may write them. */
  | "plan"
  /** The person gave this model these numbers in the card: they are theirs, and the portal's plan is only offered as a suggestion. */
  | "person-model"
  /** The person tuned the plain numbers every model inherits: the portal sizes nobody's model. */
  | "person-plain"
  /** The portal's numbers were taken off this model in the card: leaving them off is the person's doing. */
  | "taken-back";

/**
 * Whose compaction numbers this model is running on.
 *
 * The portal sizes a model's compaction from the model's own window and answer (see
 * `compaction-ladder.ts`), which is a write to pi's file like any other, and the card
 * has the same two sliders. So writing needs a rule about whose number a number is:
 *
 *  - the model's own numbers, where they are what the portal wrote: the portal's, and
 *    it may bring them up to date when the model's row changes (a window typed in,
 *    Max output tokens raised);
 *  - the model's own numbers, where they are not what the portal wrote: the person's,
 *    and nothing the portal computes writes over them;
 *  - the plain numbers, left at what pi itself gives every model: nobody has tuned
 *    anything, and this model is the portal's to size;
 *  - the plain numbers, tuned: the person has spoken for every chat, and a per-model
 *    number of the portal's would sit over their words;
 *  - the plain numbers, untouched, on a model the portal has sized and the person has
 *    since cleared from the card: taking the portal's numbers off is a move on them,
 *    so they stay off.
 *
 * `portalWrote` is the portal's own record of what it wrote for this model, which is
 * the only way to tell its write from a person's write of the same two numbers.
 */
export function roomOwnership(
  settings: CompactionSettings,
  modelKey: string,
  portalWrote?: RoomPair,
): RoomOwner {
  const own = settings.modelOverrides[modelKey];
  if (own) {
    const ours =
      portalWrote !== undefined &&
      (own.keepRecentTokens === undefined || own.keepRecentTokens === portalWrote.keepRecentTokens) &&
      (own.reserveTokens === undefined || own.reserveTokens === portalWrote.reserveTokens);
    if (ours) return "plan";
    return "person-model";
  }
  const untouched =
    settings.keepRecentTokens === COMPACTION_DEFAULTS.keepRecentTokens &&
    settings.reserveTokens === COMPACTION_DEFAULTS.reserveTokens;
  if (!untouched) return "person-plain";
  return portalWrote ? "taken-back" : "plan";
}

/**
 * Whether the portal may put its numbers on this model at all.
 *
 * `roomOwnership` answers the fuller question — whose numbers a chat is running on —
 * and it lets a person's plain numbers, which are every chat's, stand for a model the
 * portal has not sized. The question a pass over the models the portal has asks is
 * narrower: one pair of plain numbers cannot be right for more than one model, since
 * pi reads them for whatever window a chat happens to be on, so they stay as the
 * fallback and a model the portal has is sized under its own name anyway. What is
 * never written over is a number for that model: the person's, or one they took back
 * from the card.
 */
export function modelRoomMayBeSized(
  settings: CompactionSettings,
  modelKey: string,
  portalWrote?: RoomPair,
): boolean {
  const owner = roomOwnership(settings, modelKey, portalWrote);
  return owner === "plan" || owner === "person-plain";
}

/**
 * The file as a change starts from it: none yet is empty, but one that is there
 * and cannot be read stops the change. Taken as empty, the save would write back
 * only what it adds, and every package, default and switch in the file would be
 * gone (providers.ts does the same for models.json and auth.json).
 */
function readForChange(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(piSettingsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`settings.json could not be read (${(e as Error).message}), so nothing was changed. Put it right by hand, then save again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json does not hold what pi expects, so nothing was changed.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Put `text` in place of the file, whole: a temp file and a rename, which is
 * atomic on the same filesystem — a reader arriving mid-write sees the old file
 * whole rather than half of the new one. What it replaces is kept beside it as
 * settings.json.bak, so a save that was not what was meant can be taken back.
 */
function replaceFile(text: string): void {
  const file = piSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  let before: string | undefined;
  try {
    before = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // A save that changes nothing leaves the copy of the file before it alone.
  if (before === text) return;
  if (before !== undefined) writeFileAtomic(`${file}.bak`, before, 0o600);
  writeFileAtomic(file, text);
}

/** The portal's own writes to the file, one after the other: the last of them. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * `work` once the writes before it are done, and before the next. For what is
 * kept alongside the file, which neither reads nor changes it.
 */
export function inTurnWithSettings<T>(work: () => T): Promise<T> {
  const next = writeChain.then(work);
  // Kept unbroken by a failure, or one bad write would wedge every later one.
  writeChain = next.catch(() => {});
  return next;
}

/**
 * Change pi's settings file without losing what else is in it.
 *
 * Read-modify-write on a file pi also owns, so two precautions. The write goes
 * through a rename, so a reader never sees half of it. And the portal's own
 * writes are serialised, so a slider released at the same moment as a Save
 * cannot interleave and drop one of the two changes.
 *
 * What this cannot do is coordinate with pi itself: pi has no setter for most
 * of these fields, so the portal writes the file directly, and a pi write
 * landing between the read and the rename would still be lost. That window is
 * milliseconds wide and pi only writes on a deliberate action, so it is a
 * smaller risk than the alternative of reaching into its internals.
 *
 * `written` runs once the file is in place, still in turn with other writes:
 * for what is kept elsewhere alongside it, which must not change when the
 * file did not.
 *
 * A file that is there but cannot be read is not changed: this throws, saying so.
 */
export function updatePiSettings(
  mutate: (settings: Record<string, unknown>) => void,
  written?: () => void,
): Promise<Record<string, unknown>> {
  return inTurnWithSettings(() => {
    const all = readForChange();
    mutate(all);
    replaceFile(JSON.stringify(all, null, 2) + "\n");
    written?.();
    return all;
  });
}

/**
 * The same change, made now rather than in turn with the others: for the database's upgrade, which runs as the portal
 * starts, before anything of it writes the file, and cannot wait for a promise.
 */
export function updatePiSettingsNow(mutate: (settings: Record<string, unknown>) => void): Record<string, unknown> {
  const all = readForChange();
  mutate(all);
  replaceFile(JSON.stringify(all, null, 2) + "\n");
  return all;
}

/**
 * The raw editor's save: whatever the user wrote, as long as it is an object
 * pi can read, in turn with the other writes. It does not start from the file,
 * so it is also how one that cannot be read is put right.
 */
export function writePiSettingsText(text: string): Promise<void> {
  return inTurnWithSettings(() => replaceFile(text));
}

/** Merged, never replaced: the portal has no business dropping a key it does not know. */
export async function writeCompactionSettings(
  patch: Partial<CompactionSettings>,
): Promise<CompactionSettings> {
  await updatePiSettings((all) => {
    const current = all.compaction && typeof all.compaction === "object" ? all.compaction : {};
    all.compaction = { ...current, ...patch };
  });
  return readCompactionSettings();
}

/**
 * One model's own compaction numbers, in pi's file, merged with what it has.
 *
 * pi scopes a compaction number to a model (`compaction.modelOverrides`), and
 * nothing else in compaction: the switch is one switch for every chat, and the
 * plain numbers are every chat's. So "this chat's summary needs more room" is
 * said to pi in the only shape it has — the model's own number — and the chat
 * that shares its model takes the same room, which is what the arithmetic
 * needs anyway: it is the model's answer that has to write the summary.
 *
 * Only the fields given are written: a card that changes one number leaves the
 * other as the model had it.
 */
export async function writeCompactionModelRoom(
  modelKey: string,
  patch: CompactionModelSettings,
): Promise<CompactionSettings> {
  await updatePiSettings((all) => {
    const compaction = all.compaction && typeof all.compaction === "object" ? (all.compaction as Record<string, unknown>) : {};
    const overrides = compaction.modelOverrides && typeof compaction.modelOverrides === "object"
      ? (compaction.modelOverrides as Record<string, unknown>)
      : {};
    const entry = overrides[modelKey] && typeof overrides[modelKey] === "object"
      ? (overrides[modelKey] as Record<string, unknown>)
      : {};
    overrides[modelKey] = { ...entry, ...patch };
    all.compaction = { ...compaction, modelOverrides: overrides };
  });
  return readCompactionSettings();
}
