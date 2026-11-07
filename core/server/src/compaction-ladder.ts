/**
 * The compaction numbers a model's own size asks for, and the ladder worked when a
 * chat's summary will not fit one answer.
 *
 * ## What the chats on this machine measure
 *
 * Every compaction pi wrote to `data/sessions/*` (165 of them) carries the usage of
 * the call that wrote the summary. Read as a set, they say three things, and the
 * plan below is built from all three.
 *
 * 1. **The summary's length is its own, not the head's.** pi's summarization call is
 *    given a serialized copy of the span it is summarising (tool results cut to 2,000
 *    characters, thinking dropped) and a fixed prompt asking for a nine-section
 *    document. The measured outputs: 59,598 tokens read → 3,912 written; 65,453 → 5,736;
 *    46,984 → 14,474; 38,002 → 10,371; 23,567 → 10,805. The written length sits between
 *    about 1,300 and 14,500 tokens whatever it reads, with one strong tendency: a small
 *    head is summarised at the document's own length — 4,717 → 5,790 and 7,480 → 12,189,
 *    a summary *bigger* than the conversation it came from.
 *
 *    So a compaction only takes tokens out when the head is much bigger than the
 *    document written about it. A 100,000-token head in, 3,912 out, is a real cut; a
 *    23,000-token head in, 12,189 out, is a rounding.
 *
 * 2. **Every compaction feeds the next one.** pi's update prompt merges the previous
 *    summary into the new one. In `6-QfTViApKKy` (5 November), the summary grew
 *    5,790 → 12,189 → over the model's 16,384-token answer, in three attempts ten
 *    minutes apart. A chat compacting every few thousand tokens walks its summary to
 *    the cap and then fails there, forever.
 *
 * 3. **Failure at the cap is what "compaction did not happen" looks like.** The chat
 *    keeps its whole context, meets the threshold again at the next turn boundary,
 *    fails again, and after two failures the portal stops its attempts — which leaves
 *    it running at 88%, 90%, 91% of its window with no compaction at all, answering
 *    with a token of thinking. That is the state this module exists to prevent; the
 *    ladder below is what is worked when it arrives anyway.
 *
 * ## The plan the numbers come from
 *
 * Two numbers, in the model's own `compaction.modelOverrides`, chosen so all three
 * facts above come out right:
 *
 *  - **keep-free (`reserveTokens`)** a quarter of the window, never under pi's own
 *    16,384: a chat is compacted at about three-quarters of its window, never at 91%,
 *    and the answer it writes next has the room it needs;
 *  - **keep-recent (`keepRecentTokens`)** the trigger point less a head of at least
 *    40,000 tokens, capped at two and a half answers: big enough that the nine-section
 *    document is a cut rather than a copy (fact 1), small enough that the document
 *    fits the answer the model has (fact 3), and far enough below the trigger that the
 *    chat lands at half its window and works a long time before the next one (fact 2).
 *
 * For the model these chats run on — a 131,072-token window, a 16,384-token answer —
 * that is keep-free 33,000 and keep-recent 58,000: compaction at 74% of the window,
 * 40,000 tokens written down to one summary, the chat landing at about 57% and working
 * ~24,000 tokens before the next one. The numbers the chats failed on were 24,000 and
 * 90,000, which compact at 82%, hand the summariser a 25,000-token head, land at the
 * trigger point they started from, and walk the summary to the cap.
 */

/** pi's own keep-free, and the floor for the portal's: a chat must compact before the answer is squeezed. */
const RESERVE_MIN = 16_384;
/** A quarter of the window kept free: the chat compacts at about 75% of it. */
const RESERVE_OF_WINDOW = 4;
/** Keeping more than half the window free is a chat compacting on every second turn. */
const RESERVE_MAX_SHARE = 0.5;

/** A head this small is written up at the document's own length, which is no cut at all (fact 1). */
const MIN_HEAD = 40_000;
/** A head this big is more than the chats of this machine were summarising when they succeeded. */
const MAX_HEAD = 120_000;
/** A head as a share of the trigger point, for the windows that are much bigger than this one. */
const HEAD_OF_TRIGGER = 8;
/** Two and a half answers is the largest head whose document has been seen to fit the answer. */
const HEAD_OF_ANSWER = 2.5;
/** Half the trigger point is all of the conversation a compaction may be asked about. */
const HEAD_MAX_SHARE = 0.5;

/** The nine-section document's own length, measured: 12,189 for a 7,480-token conversation. */
const SUMMARY_FLOOR = 12_000;
/** Measured on the large heads: 59,598 → 3,912, 46,984 → 14,474, 38,002 → 10,371. */
const SUMMARY_OF_HEAD = 0.5;

/** Below this, a compaction buys minutes and nothing else. */
const MINIMUM_PROGRESS = 1_000;

export interface ModelSize {
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** What one answer gets from this model, in tokens (pi's `maxTokens`; 16,384 where the model says nothing else). */
  maxTokens: number;
}

/**
 * What pi gives a model that says nothing about its own size — its provider code
 * reads `contextWindow ?? 128e3` and `maxTokens ?? 16384`. A model row in
 * Settings → Providers usually says the window and rarely the answer, so sizing
 * every model the portal has needs both defaults, and a plan built on them is a
 * plan for what pi would run that model as.
 */
export const PI_MODEL_WINDOW_DEFAULT = 128_000;
export const PI_MODEL_ANSWER_DEFAULT = 16_384;

export interface CompactionPlan {
  /** What the model keeps free at the top of its window: pi's `compaction.reserveTokens`. */
  reserveTokens: number;
  /** What it keeps word for word: pi's `compaction.keepRecentTokens`. */
  keepRecentTokens: number;
  /** Above this many tokens of context pi compacts: window − keep-free. */
  triggersAtTokens: number;
  /** The same as a share of the window, which is the number a person reads it as. */
  triggersAtPercent: number;
  /** The conversation handed to the summariser at that point. */
  headTokens: number;
  /** The document written about it, at the longest seen on this machine. */
  summaryTokens: number;
  /** Where a compaction that works leaves the chat. */
  landsAtTokens: number;
  /** Tokens of work the chat gets between two compactions. */
  progressTokens: number;
}

const round1000 = (tokens: number): number => Math.max(1_000, Math.round(tokens / 1_000) * 1_000);
const clamp = (tokens: number, low: number, high: number): number => Math.min(Math.max(tokens, low), Math.max(low, high));

/**
 * What a head is written up at, at the longest measured on this machine.
 *
 * The document has a length of its own, so a small head is written up at more than
 * its size; a big head is written up at about half of it. This is what a head asks
 * for, uncapped — the number worth naming in a line about a summary that will not
 * fit. Whether a head fits a model at all is `RoomShape.headFitsAnswerTokens`: one
 * answer times `HEAD_OF_ANSWER`, the largest head whose document has been seen to
 * fit the answer — which is where the measured ratios, a third of a head at the top
 * and less below it, and the plans this module makes, all agree.
 */
export function summaryWantedFor(headTokens: number): number {
  return Math.floor(Math.max(headTokens * SUMMARY_OF_HEAD, SUMMARY_FLOOR));
}

/** The same, capped at one of the model's answers: the longest summary that finishes. */
export function summaryRoomFor(headTokens: number, maxTokens: number): number {
  return Math.floor(Math.min(summaryWantedFor(headTokens), maxTokens));
}

/**
 * The compaction numbers this model's size asks for, in its own keep-recent and keep-free.
 *
 * Returns null when the model is too small for a compaction to buy anything: the head
 * its window and answer leave is smaller than the document written about it, so every
 * compaction would leave the chat bigger than it started. That is the honest answer for
 * a 4k model with a 1k answer, and it is not a thing the portal can fix with numbers.
 */
export function planForModel(size: ModelSize): CompactionPlan | null {
  const window = Math.floor(size.contextWindow);
  const answer = Math.floor(size.maxTokens);
  if (!Number.isFinite(window) || !Number.isFinite(answer) || window <= 0 || answer <= 0) return null;

  const reserve = round1000(clamp(window / RESERVE_OF_WINDOW, RESERVE_MIN, window * RESERVE_MAX_SHARE));
  const triggersAt = window - reserve;
  if (triggersAt <= 0) return null;

  const head = Math.floor(
    clamp(
      Math.min(Math.max(triggersAt / HEAD_OF_TRIGGER, MIN_HEAD), Math.max(MIN_HEAD, answer * HEAD_OF_ANSWER)),
      Math.max(MIN_HEAD, 1),
      Math.max(MIN_HEAD, Math.min(MAX_HEAD, triggersAt * HEAD_MAX_SHARE)),
    ),
  );
  const keepRecent = Math.max(1_000, triggersAt - head);
  const headTokens = triggersAt - keepRecent;
  const summary = summaryRoomFor(headTokens, answer);
  const landsAt = keepRecent + summary;
  const progress = triggersAt - landsAt;
  if (headTokens < MINIMUM_PROGRESS || summary <= 0 || progress < MINIMUM_PROGRESS) return null;

  return {
    reserveTokens: reserve,
    keepRecentTokens: keepRecent,
    triggersAtTokens: triggersAt,
    triggersAtPercent: Math.round((triggersAt / window) * 100),
    headTokens,
    summaryTokens: summary,
    landsAtTokens: landsAt,
    progressTokens: progress,
  };
}

/**
 * Where a chat of this window is at the wall: close enough to the top that the next
 * answer has no room, and any compaction it is asked for has to be written in an
 * answer the size of what it is summarising.
 *
 * The chat that asked for this fix was working at 91% of its window. pi compacts above
 * window − keep-free, so a chat sitting here has a compaction behind it that did not
 * land, and one ahead of it that will not.
 */
export const CONTEXT_AT_WALL_PERCENT = 88;

/**
 * pi's report of a summary that stopped in the middle of the answer, which is the one
 * failure the portal can do something about by itself: the model used the whole of its
 * answer and the summary is incomplete, so the room it needed is a number the portal
 * writes — a keep-recent, a keep-free, a Max output tokens. The other failures (a
 * provider down, a model taken away, the person's own Stop) are not a shape arithmetic
 * answers.
 */
export function summaryRanOutOfRoom(errorMessage: unknown): boolean {
  return /hit the token cap/i.test(String(errorMessage ?? ""));
}

/**
 * The summary asked for short, for pi's `compact(customInstructions)` — which it appends
 * to its own summarization prompt as "Additional focus".
 *
 * The default prompt asks for a nine-section document and says to keep it concise; what
 * it does not do is bound it, and a model that reads 40,000 tokens of a coding run and
 * writes the sections it is asked for runs out of the answer it has. So the ask is a
 * length, in words, and a rule about what not to copy: a summary of a coding chat that
 * quotes the source it read is a second copy of it, and the chat can read it back.
 *
 * It is the manual path only — pi's automatic compaction calls its own prompt and takes
 * no instructions from anyone. That is why this is the ladder's first rung and not part
 * of the plan: the plan is what makes the automatic path work without it.
 */
export const COMPACT_SHORT_SUMMARY =
  "Write the whole summary under 1,200 words. Bullets, not prose, and no section you have nothing to report. " +
  "Do not quote source, diffs or tool output: name the file, the function, the command, the error, and say what is true of it. " +
  "Anything the next turn can read back from the files, leave out — keep the path it reads back from.";

/** Two numbers the portal wrote for a model, as it wrote them. */
export interface WrittenRoom {
  keepRecentTokens: number;
  reserveTokens: number;
}

/**
 * The room the portal gives a model when it has a plan, in the shape pi's file keeps.
 * Kept apart from `planForModel` so the two numbers written are the plan's own two
 * numbers, named: a partial write (a plan whose answer is unknown) is not a room.
 */
export function planRoom(plan: CompactionPlan): WrittenRoom {
  return { keepRecentTokens: plan.keepRecentTokens, reserveTokens: plan.reserveTokens };
}

/**
 * What a pair of compaction numbers leaves a chat doing, on a model of this size.
 *
 * `planForModel` answers what the numbers should be; this answers what a pair does.
 * The two are the same arithmetic read from the other side, and the second one is
 * what the warning about a configuration that does not work needs: a chat can be
 * running on numbers nobody computed — pi's defaults are one pair, read for whatever
 * window a chat happens to be on, and a person's two numbers in the Settings card
 * are every chat's — and a pair decided that way can be wrong in one of five ways,
 * each of which is what "compaction did nothing" looks like. The shape is returned
 * for the sentence: the caller has the words, these are the numbers it names.
 */
export interface RoomShape {
  /** The model's context window and one answer of it, as the pair was read for. */
  contextWindow: number;
  maxTokens: number;
  /** What the pair keeps word for word, and keeps free at the top of the window. */
  keepRecentTokens: number;
  reserveTokens: number;
  /** Above this many tokens of context pi compacts: window − keep-free, at or below nothing when the room it keeps free is the whole window. */
  triggersAtTokens: number;
  /** The same as a share of the window: at `CONTEXT_AT_WALL_PERCENT` the chat is at the wall. */
  triggersAtPercent: number;
  /** The conversation handed to the summariser at that point. */
  headTokens: number;
  /** What that head would be written up at, at the longest seen on this machine, uncapped by the answer. */
  summaryWantedTokens: number;
  /** A head bigger than this many answers is written up at more than one of them holds: `HEAD_OF_ANSWER`, the largest head whose document has been seen to fit. */
  headFitsAnswerTokens: number;
  /** The longest summary that fits one answer. */
  summaryTokens: number;
  /** Where a compaction that finishes leaves the chat. */
  landsAtTokens: number;
  /** Tokens of work the chat gets before the next one is asked. */
  progressTokens: number;
}

/** Null when nothing is known of the model's size — there is nothing to say about the pair then. */
export function roomShapeFor(size: ModelSize, room: WrittenRoom): RoomShape | null {
  const contextWindow = Math.floor(size.contextWindow);
  const maxTokens = Math.floor(size.maxTokens);
  if (![contextWindow, maxTokens, room.keepRecentTokens, room.reserveTokens].every(Number.isFinite)) return null;
  const keepRecentTokens = Math.floor(room.keepRecentTokens);
  const reserveTokens = Math.floor(room.reserveTokens);
  const triggersAtTokens = contextWindow - reserveTokens;
  const headTokens = Math.max(0, triggersAtTokens - keepRecentTokens);
  const summaryWantedTokens = summaryWantedFor(headTokens);
  const summaryTokens = summaryRoomFor(headTokens, maxTokens);
  const landsAtTokens = keepRecentTokens + summaryTokens;
  return {
    contextWindow,
    maxTokens,
    keepRecentTokens,
    reserveTokens,
    triggersAtTokens,
    triggersAtPercent: Math.round((triggersAtTokens / contextWindow) * 100),
    headTokens,
    summaryWantedTokens,
    headFitsAnswerTokens: Math.floor(maxTokens * HEAD_OF_ANSWER),
    summaryTokens,
    landsAtTokens,
    progressTokens: triggersAtTokens - landsAtTokens,
  };
}

/**
 * What is wrong with a pair of compaction numbers, or nothing when the compaction
 * it gives works. The keys are the ways a pair can be wrong; the sentence each
 * becomes is the caller's, which has the numbers and the model's name.
 */
export type RoomFault =
  /** It keeps free as much as the window has: a chat fills its context before pi asks for a compaction. */
  | "keeps-free-the-whole-window"
  /** It keeps more word for word than it compacts above: pi never reaches the point it would summarise from. */
  | "keeps-past-its-point"
  /** It asks for a compaction only at the top of the window: a chat is at the wall of its context before that point. */
  | "compacts-at-the-wall"
  /** The head it leaves is smaller than the document written about it: a compaction changes nothing. */
  | "head-too-small"
  /** A summary of the head it leaves is written up at more than one answer holds: the summary stops in the middle, and the chat keeps its whole context. */
  | "summary-wont-fit"
  /** A compaction that finishes leaves the chat at the point it compacts at: the next one is asked almost immediately. */
  | "walks-to-the-cap";

/** Read a shape as a fault. Null for a shape whose compaction works, and for one there is no shape for. */
export function roomFaultFor(shape: RoomShape | null): RoomFault | null {
  if (!shape) return null;
  if (shape.triggersAtTokens <= 0) return "keeps-free-the-whole-window";
  if (shape.keepRecentTokens >= shape.triggersAtTokens) return "keeps-past-its-point";
  if (shape.headTokens < MINIMUM_PROGRESS) return "head-too-small";
  if (shape.triggersAtPercent >= CONTEXT_AT_WALL_PERCENT) return "compacts-at-the-wall";
  if (shape.headTokens > shape.maxTokens * HEAD_OF_ANSWER) return "summary-wont-fit";
  if (shape.progressTokens < MINIMUM_PROGRESS) return "walks-to-the-cap";
  return null;
}
