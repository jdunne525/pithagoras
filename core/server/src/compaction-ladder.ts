/**
 * The compaction numbers a model's own size asks for, and the ladder worked when a
 * chat's summary will not fit one answer.
 *
 * ## What the chats on this machine measure
 *
 * Every compaction pi wrote to `data/sessions/*` (165 of them) carries the usage of
 * the call that wrote the summary. Read as a set, they say four things, and the
 * plan below is built from all four.
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
 * 4. **A compaction can only take out what the chat has added since its last one.**
 *    pi's cut point never walks back past the newest compaction record, and the record
 *    it stops at carries that record's summary *and the stretch of raw conversation it
 *    kept*. So at the moment a chat meets the threshold its context is, in order: the
 *    last summary, the last keep, and the conversation added since. The cut keeps the
 *    most recent keep-recent of that newer part, so the head is what is left of it, and
 *    the point it compacts above is the sum of all four:
 *
 *    `window − keep-free = last summary + 2 × keep-recent + head`
 *
 *    A keep-recent above half of that point leaves a cut that does not exist, whatever
 *    the chat does, and pi answers `Nothing to compact (session too small)`. The pair the
 *    chats on this machine were left on made this visible: keep-recent 58,072 of a
 *    131,072 window, the portal's own numbers, asked a chat that had just compacted for
 *    a head of 40,000 and pi answered `Nothing to compact` — in `0Mu35yqbfNWf` (7
 *    November) that was the last compaction the chat ever got, and it then filled its
 *    window to 96% of it and stopped there. A keep-recent is only worth writing where
 *    the head it leaves is reachable *with the last keep and the last document beside
 *    it*, not only under the point it compacts above.
 *
 * ## The plan the numbers come from
 *
 * Two numbers, in the model's own `compaction.modelOverrides`, chosen so all four
 * facts above come out right:
 *
 *  - **keep-free (`reserveTokens`)** a quarter of the window, never under pi's own
 *    16,384: a chat is compacted at about three-quarters of its window, never at 91%,
 *    and the answer it writes next has the room it needs;
 *  - **keep-recent (`keepRecentTokens`)** the point it compacts above, less the last
 *    document and two keeps and a head (fact 4), where the head is the biggest one
 *    whose document fits one answer with room for the chain to grow (facts 1 and 2),
 *    as large as the window and the measurement ask for, and far enough below the
 *    trigger that the chat lands at half its window and works a long time before the
 *    next one (fact 2).
 *
 * For the model these chats run on — a 131,072-token window, a 16,384-token answer —
 * that is keep-free 33,000 and keep-recent 30,460: compaction at 74% of the window,
 * 55,228 tokens of new conversation beside the 12,384 of summary its last compaction
 * left and the 30,460 it keeps, 24,768 of that handed to the summariser, the chat
 * landing at 42,844 — 33% of its window — and working 55,228 tokens before the next
 * one. The pair the portal wrote before, 58,072, is not read as a smaller head: it is
 * read as no cut at all. Its keep and the document beside it come to 131,072 against
 * the 98,072 it compacts above, so the chat has to add a third of its window before a
 * cut exists, and it meets the top of its window before it adds them.
 *
 * What the plan cannot do is stop a chain of summaries growing (fact 2): on this
 * model's window a nine-section document and its next version do not both fit one
 * answer at any head this model writes about, so a chat that walks there is worked by
 * the ladder below — the summary asked for in words first, at the compaction that left
 * the document past the plan's own ceiling, then the numbers — rather than by a pair of
 * numbers that would fit.
 *
 * It is sized for the state the chain settles in, not for the first compaction of a
 * fresh chat: a chat that has never compacted has no last keep and no last document in
 * front of the cut, so its first head is the whole of the trigger less one keep, which is
 * bigger than these numbers name. That first compaction, and the one that follows a
 * summary the ladder bounded in words, are the states the ladder's ask is written for —
 * what the pair is written for is the state that runs for hours afterwards.
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
/** Characters to a token, for the one measurement that has no count: the text of a summary
 * a pi reported no usage for. Read as a factor, and the check it is worth is a plan's own
 * ceiling, which was measured rather than counted — see `carriedSummaryOf`. */
const SUMMARY_CHARS_OF_TOKEN = 4;
/** The room one answer must keep for the next document's additions: the chain of summaries grows, and a document at the answer's length has nothing to grow into (fact 2). */
const SUMMARY_ROOM_TO_GROW = 4_000;

/** Below this, a compaction buys minutes and nothing else. */
const MINIMUM_PROGRESS = 1_000;
/** The least a model keeps word for word: below this the whole of pi's job is a cut of one message. */
const MIN_KEEP = 1_000;

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
  /** The summary a chat carries into this compaction, written by the one before it (fact 4). */
  carriedSummaryTokens: number;
  /** The conversation handed to the summariser at that point: what was added since the last compaction, less what the keep keeps. */
  headTokens: number;
  /** The document written about it, at the longest seen on this machine. */
  summaryTokens: number;
  /** Where a compaction that works leaves the chat: its keep, and the document beside it. */
  landsAtTokens: number;
  /** Tokens of conversation a chat adds between two compactions. */
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

/** The same, capped at one of the model's answers: the longest document that finishes inside one. */
function summaryRoomFor(headTokens: number, maxTokens: number): number {
  return Math.floor(Math.min(summaryWantedFor(headTokens), maxTokens));
}

/**
 * What a pair of numbers leaves reachable at the point a chat is asked to compact.
 *
 * This is fact 4 read as an equation: at the threshold a chat's context is its last
 * summary, then its last keep, then the conversation it added since, and the cut keeps
 * the newest keep-recent of that last part. So a head and the document written about
 * it — which the next compaction carries beside it — share what is left of the point
 * they compact above once two keeps are taken out, and the state a chain of these
 * numbers gets to is the largest head that fits under that with its own document
 * beside it. The document takes one of three forms (its floor, half the head, one
 * answer), and the equation for each is closed by a candidate head; the largest
 * candidate that fits is the state.
 */
function reachableAt(keepRecentTokens: number, triggersAtTokens: number, maxTokens: number): { headTokens: number; carriedSummaryTokens: number } {
  const above = Math.floor(triggersAtTokens) - 2 * Math.floor(keepRecentTokens);
  const answer = Math.floor(maxTokens);
  let headTokens = 0;
  let carriedSummaryTokens = 0;
  for (const candidate of [above, answer > 0 ? above - answer : above, Math.floor(above / (1 + SUMMARY_OF_HEAD)), above - SUMMARY_FLOOR]) {
    const head = Math.max(0, Math.floor(candidate));
    const document = summaryRoomFor(head, answer);
    if (head + document > above) continue;
    if (head + document > headTokens + carriedSummaryTokens) {
      headTokens = head;
      carriedSummaryTokens = document;
    }
  }
  return { headTokens, carriedSummaryTokens };
}

/**
 * The compaction numbers this model's size asks for, in its own keep-recent and keep-free.
 *
 * Returns null when this model's size has no pair: its answer is smaller than the
 * document this model writes at its own length, with room for the next version beside
 * it, so no head worth asking it for exists (a 32k window with an 8k answer, a 4k
 * window with a 1k answer); or the head its own keep leaves is shorter than the
 * document written about it, and the chain of those documents walks to the answer's
 * cap. Both are the honest answer that the size has no pair, and neither is a thing
 * the portal can fix with numbers — the ladder's ask for a summary in words is, and
 * is tried before this answer is given.
 */
export function planForModel(size: ModelSize): CompactionPlan | null {
  const window = Math.floor(size.contextWindow);
  const answer = Math.floor(size.maxTokens);
  if (!Number.isFinite(window) || !Number.isFinite(answer) || window <= 0 || answer <= 0) return null;

  const reserve = round1000(clamp(window / RESERVE_OF_WINDOW, RESERVE_MIN, window * RESERVE_MAX_SHARE));
  const triggersAt = window - reserve;
  if (triggersAt <= 0) return null;

  // A head, and the document written about it, have to share one of the model's answers
  // with room left for the chain's next additions (fact 2): the model writes the
  // document it is asked for at up to half the head, so the head that leaves room is
  // twice what is left of the answer's length. Below its floor a model writes at the
  // floor whatever it reads, so a model whose answer cannot hold a document at the
  // floor plus room has no head worth asking it for at all.
  const headWritable = answer >= SUMMARY_FLOOR + SUMMARY_ROOM_TO_GROW ? Math.floor(2 * (answer - SUMMARY_ROOM_TO_GROW)) : 0;

  const wanted = Math.floor(
    clamp(
      Math.min(Math.max(triggersAt / HEAD_OF_TRIGGER, MIN_HEAD), Math.max(MIN_HEAD, answer * HEAD_OF_ANSWER)),
      Math.max(MIN_HEAD, 1),
      Math.max(MIN_HEAD, Math.min(MAX_HEAD, triggersAt * HEAD_MAX_SHARE)),
    ),
  );
  const head = Math.floor(Math.min(wanted, headWritable));

  // The keep is the other half of fact 4: the point it compacts above, less this head,
  // less the document the model writes about it, less that document again, which the
  // next compaction carries beside the keep. Halved because the keep is counted twice
  // there — the last compaction's, and this one's.
  const keepRecent = Math.floor((triggersAt - head - summaryRoomFor(head, answer)) / 2);
  const keep = Math.max(MIN_KEEP, keepRecent);

  const reach = reachableAt(keep, triggersAt, answer);
  const headTokens = reach.headTokens;
  const carriedSummaryTokens = reach.carriedSummaryTokens;
  const summary = summaryRoomFor(headTokens, answer);
  const landsAt = keep + summary;
  const progress = triggersAt - landsAt;

  // A pair this module cannot put a cut in, or cannot keep out of the answer: with its
  // keep, the last keep and the last document above the point it compacts at there is
  // nothing to take out whatever the chat does (fact 4), and a document at the answer's
  // length has nothing beside it to grow into (fact 2). Both are the honest answer that
  // this model's size has no pair, as it was before for a model too small to buy anything.
  if (headTokens < MINIMUM_PROGRESS || headTokens <= summary || summary >= answer || progress < MINIMUM_PROGRESS) return null;

  return {
    reserveTokens: reserve,
    keepRecentTokens: keep,
    triggersAtTokens: triggersAt,
    triggersAtPercent: Math.round((triggersAt / window) * 100),
    carriedSummaryTokens,
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
 * pi's other no-result answer, and the one a pair of numbers asks for by itself: the
 * cut is out of reach, so there is nothing to summarise (`Nothing to compact
 * (session too small)`). Nothing about the summary went wrong here, and no further
 * try changes it — what is wrong is that the room was written where no cut can be
 * reached, which is fact 4 read at the one chat rather than at the model.
 */
export function nothingLeftToCompact(errorMessage: unknown): boolean {
  return /nothing to compact/i.test(String(errorMessage ?? ""));
}

/**
 * What a compaction left the chat carrying, in tokens.
 *
 * pi's `compaction_end` carries the summary it wrote and the usage of the call that wrote
 * it, and that document is what the next compaction reads beside the chat's last keep —
 * fact 4, at one chat rather than at a model. A report with a usage answers the question
 * with a count; one without it is answered by the text's own length over four to a token,
 * which is the same question asked the wrong way round and is only ever read as a factor.
 */
export function carriedSummaryOf(compactionEnd: any): number {
  const output = Number(compactionEnd?.result?.usage?.output);
  if (Number.isFinite(output) && output > 0) return output;
  const summary = compactionEnd?.result?.summary;
  return typeof summary === "string" ? Math.ceil(summary.length / SUMMARY_CHARS_OF_TOKEN) : 0;
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
 * are every chat's — and a pair decided that way can be wrong in one of seven ways,
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
  /** The summary a chat carries into this compaction, written by the one before it (fact 4). */
  carriedSummaryTokens: number;
  /** The conversation handed to the summariser at that point: what was added since the last compaction, less what the keep keeps. */
  headTokens: number;
  /** What that head would be written up at, at the longest seen on this machine, uncapped by the answer. */
  summaryWantedTokens: number;
  /** A head bigger than this many answers is written up at more than one of them holds: `HEAD_OF_ANSWER`, the largest head whose document has been seen to fit. */
  headFitsAnswerTokens: number;
  /** The longest document that finishes inside one answer. */
  summaryTokens: number;
  /** Where a compaction that finishes leaves the chat: its keep, and the document beside it. */
  landsAtTokens: number;
  /** Tokens of conversation the chat gets before the next one is asked. */
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
  const reach = reachableAt(keepRecentTokens, triggersAtTokens, maxTokens);
  const headTokens = reach.headTokens;
  const carriedSummaryTokens = reach.carriedSummaryTokens;
  const summaryTokens = summaryRoomFor(headTokens, maxTokens);
  const landsAtTokens = keepRecentTokens + summaryTokens;
  return {
    contextWindow,
    maxTokens,
    keepRecentTokens,
    reserveTokens,
    triggersAtTokens,
    triggersAtPercent: Math.round((triggersAtTokens / contextWindow) * 100),
    carriedSummaryTokens,
    headTokens,
    summaryWantedTokens: summaryWantedFor(headTokens),
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
 *
 * `nothing-left-to-cut` is the pair fact 4 says never had a cut: its keep, counted
 * twice — the last compaction's and this one's — and the document beside it come to
 * more than the point they compact above, so pi has nothing to take out whatever the
 * chat does, and answers `Nothing to compact (session too small)`. That is not the
 * shape where a compaction finishes and the next one is asked for immediately, which
 * is `walks-to-the-cap`: there a cut exists and works, and it is the chain of
 * documents grown to one answer's length that has nothing left to add (fact 2).
 */
export type RoomFault =
  /** It keeps free as much as the window has: a chat fills its context before pi asks for a compaction. */
  | "keeps-free-the-whole-window"
  /** It keeps more word for word than it compacts above: pi never reaches the point it would summarise from. */
  | "keeps-past-its-point"
  /** It keeps word for word, and the summary its last compaction left, more than it compacts above: there is no cut for pi to take, and there never will be. */
  | "nothing-left-to-cut"
  /** It asks for a compaction only at the top of the window: a chat is at the wall of its context before that point. */
  | "compacts-at-the-wall"
  /** A summary of the head it leaves is written up at more than one answer holds: the summary stops in the middle, and the chat keeps its whole context. */
  | "summary-wont-fit"
  /** A compaction that finishes leaves the chat at its keep and its own summary beside it, and the next one is asked for before the chat has added its keep. */
  | "walks-to-the-cap"
  /** The span it leaves above its keep is smaller than the document written about it: a compaction changes nothing. */
  | "head-too-small";

/** Read a shape as a fault. Null for a shape whose compaction works, and for one there is no shape for. */
export function roomFaultFor(shape: RoomShape | null): RoomFault | null {
  if (!shape) return null;
  if (shape.triggersAtTokens <= 0) return "keeps-free-the-whole-window";
  if (shape.keepRecentTokens >= shape.triggersAtTokens) return "keeps-past-its-point";
  if (shape.headTokens <= 0) return "nothing-left-to-cut";
  if (shape.triggersAtPercent >= CONTEXT_AT_WALL_PERCENT) return "compacts-at-the-wall";
  if (shape.headTokens > shape.maxTokens * HEAD_OF_ANSWER) return "summary-wont-fit";
  if (shape.carriedSummaryTokens >= shape.maxTokens) return "walks-to-the-cap";
  if (shape.headTokens < shape.summaryWantedTokens) return "head-too-small";
  return null;
}
