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
 * 5. **A merge keeps the document it was given, and adds to it.** pi's update prompt
 *    opens with `Update the existing structured summary with new information` and asks
 *    that every section of the previous document be kept, so the document of the next
 *    compaction is the document of this one plus what the model writes about the new
 *    head. Measured on the numbers this module writes for this machine's model
 *    (`jUpqIIxeWIWe`, 8 November): a first compaction wrote 4,497 tokens about a head
 *    of 19,000; the merge after it kept that document and wrote the new head beside
 *    it, coming out at 11,993 of the model's 16,384-token answer; the third merge
 *    asked for more than one answer and stopped in the middle, and the chat heard the
 *    pair of notices. The plan did its job throughout — the chat compacted at 98,072
 *    and landed at 36,017 then 41,681 — and the failure came at its third compaction,
 *    on a chat that had just started. So a chain is one merge's additions away from
 *    the answer's length after any two compactions, and the room the answer needs
 *    beside a document is what the model writes about the head this model's numbers
 *    leave (fact 1's ratio), which is more than any plan keeps beside its own.
 *
 * 6. **A compaction says where it left the chat, and some chats are left where they
 *    were asked.** pi's `compaction_end` carries `tokensBefore`, and an `estimatedTokensAfter`
 *    read from its own estimate of the context the chat now has. Measured on
 *    `bWDX-fMbF8eo` (8 November), on the numbers this module writes for this model's
 *    window: seven compactions in 30 minutes, at 102,226 → 95,665, 103,113 → 96,138,
 *    104,005 → 97,574, 105,630 → 100,343, 111,043 → 104,165, 118,088 → 107,268, 119,171
 *    → 108,816 of a 131,072-token window — every one of them asked above at 98,072. Each
 *    took 6,400-7,000 tokens out of a context it had only just been asked above, and the
 *    document it wrote grew 1,741 → 3,177 → 6,852 → 8,173 → 10,472 → 16,045 → 16,367, the
 *    last of them 17 tokens short of the model's 16,384-token answer; the merge after that
 *    is what stopped in the middle, and is the pair of notices that chat's person read.
 *    A chat whose last keep and last document are already at the point it is asked above
 *    (fact 4 read at one chat rather than at a model) cannot be got below it by compacting
 *    again whatever its numbers are: what sits above the reach of those numbers is the chat's
 *    fixed part — the instructions it is given and the tools it is offered — and that part
 *    was nearly half of this window. The chain of documents growing to the answer is a symptom
 *    of that state, not the thing to fix; the state is named, and the attempts at it are
 *    stopped, at the compaction that left the chat where it was asked (see
 *    `landedRoomOf` and `compactionRoomWonFor` below, and `session-manager.ts`'s
 *    `keepCompactionRoom`).
 *
 * 7. **A chat's instructions, and the tools it is offered, sit above every compaction.**
 *    pi's `tokensBefore` and its `estimatedTokensAfter` are both read from its estimate
 *    of the whole context: `estimateProjectedContextTokens` counts the projected system
 *    message and the tool schemas beside the messages, and `estimateTokens` adds the
 *    `toolsAdded` schemas at four characters to a token. A cut is a place in the
 *    conversation added since the last compaction, so none of that part is ever taken
 *    out of a chat. Measured on `pzAd05Zlf3Z9` (8 November) — the chat whose notice is
 *    the subject of this fix — the system message its every compaction carries is 255,371
 *    characters in its sections, 249,607 of them the project's own instructions (another
 *    project's whole `AGENTS.md`, read again in full at every turn) beside 5,078 of ten
 *    tool schemas: 65,113 tokens by pi's own count, 50% of the 131,072-token window. So
 *    fact 4's sum gains a term, and it is a term no pair of numbers takes out of it:
 *
 *    `window − keep-free = fixed part + last summary + 2 × keep-recent + head`
 *
 *    A keep chosen without that term is a keep past the point a cut can reach whatever
 *    the chat adds: with 65,113 out of reach, the keep this module names for a 131,072
 *    window, 30,460, counted twice — the last compaction's and this one's — and the
 *    fixed part come past the 98,072 they are asked above on their own, before a document
 *    is put beside them. That is fact 6's state, and it is read of the pair before a chat
 *    gets to it rather than after seven compactions of it. The part is not a model's — it
 *    is a chat's project and a chat's tools — so it is on no row to be read from. It is
 *    known exactly at the compaction that says where it left the chat: that landing, less
 *    what these numbers keep word for word and the document they left beside them, is the
 *    part (`fixedPartOf` below). The plan is asked with it from there (see `planForModel`
 *    's `fixedTokens` and `session-manager.ts`'s `keepCompactionRoom`), and the pair it
 *    writes with the part in the sum is a pair that has a cut to take, which is what makes
 *    the state the person saw stop being what these chats do.
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
 * What the plan cannot do is stop a chain of summaries growing (facts 2 and 5): a
 * merge keeps the document it was given, so the document is what only ever grows,
 * and its room is the model's answer. On this machine's model the answer (16,384)
 * and the document's own length (12,000) leave a head of 8,768 beside one merge's
 * additions — under the document's own length, which is no cut at all (fact 1) — so
 * the pair that cuts well and the chain that fits one answer are not the same pair
 * on this model. What bounds the chain is the bounded ask worked at the document
 * (`session-manager.ts`, `keepCompactionRoom`), asked wherever the document and what
 * the next merge would write about this model's head do not both fit one answer —
 * `mergeAdditionsFor` below, not a length the plan names — and only there: a
 * document inside that room is left as it is, and a head small enough to make the
 * chain fit is a head no compaction would take anything out of. Before that question is
 * asked at all, the room of this compaction is read (fact 6): where it left the chat,
 * against where it was asked above. A chat left at that point wins no room, and the ask
 * is not what answers it — its attempts are.
 *
 * On this machine's model that room is 4,000 tokens of its answer, so the ask is
 * worked at most of these chats' compactions and pays a second summarization each
 * time. That is the honest reading of these measurements, not a cost to hide: the
 * alternative is the pair of notices at every third compaction, which is what the
 * person reported, and a chat whose document is kept short lands further from its
 * wall than one whose document is left to climb to the answer.
 *
 * It is sized for the state the chain settles in, not for the first compaction of a
 * fresh chat: a chat that has never compacted has no last keep and no last document in
 * front of the cut, so its first head is the whole of the trigger less one keep, which is
 * bigger than these numbers name. That first compaction, and the one that follows a
 * summary the ladder bounded in words, are the states the ladder's ask is written for —
 * what the pair is written for is the point a chat is compacted above and where it lands,
 * which is what runs for hours afterwards; the document beside its keep is the bound's,
 * not the pair's, and is what keeps that state inside one answer instead of three merges
 * from its cap.
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
/** The room a plan keeps beside the document it draws: a document at the answer's own length has nothing left to write into (fact 2). The room a *chain* needs beside a document is what one merge writes about the head the pair leaves — `mergeAdditionsFor` below, at fact 5 — and where the two disagree the chain is bounded at the larger room, not the pair shrunk: a head under the document's own length is no cut at all (fact 1). */
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
  /** Where a compaction that works leaves the chat: its keep, the document beside it — and, where this plan was asked with a chat's fixed part, that part beside them (facts 4 and 7). */
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
 * What one merge adds to the document it was given, in tokens: the additions about a
 * head, at the model's own writing length (fact 1's ratio).
 *
 * A merge is not a rewrite (fact 5): it keeps everything in the document it was
 * handed and writes the new head beside it, so the document the next compaction
 * carries is `the document this one left + this`. It is worth its own function
 * because it is the question the chat's document asks — whether the next merge
 * finishes inside one answer — and the answer needs the head this chat's numbers
 * leave beside it, which is not a length any plan names.
 */
export function mergeAdditionsFor(headTokens: number): number {
  return Math.floor(Math.max(0, headTokens) * SUMMARY_OF_HEAD);
}

/**
 * Whether the next merge of a document that long, with a head this long beside it,
 * fits one of the model's answers.
 *
 * False says the document is one merge from the cap: the merge writes more than one
 * answer, pi calls it `generation hit the token cap`, nothing is compacted and the
 * chat hears the pair of notices. That is the moment to bound the document, and the
 * room is this model's answer less what its own writing adds — `jUpqIIxeWIWe` (8
 * November) reached it at the third compaction of a chat that had just started, on
 * the numbers this module writes for this model's window.
 */
export function nextDocumentFitsFor(carriedSummaryTokens: number, headTokens: number, maxTokens: number): boolean {
  return Math.floor(carriedSummaryTokens) + mergeAdditionsFor(headTokens) <= Math.floor(maxTokens);
}

/**
 * What a pair of numbers leaves reachable at the point a chat is asked to compact.
 *
 * This is fact 4 read as an equation: at the threshold a chat's context is its last
 * summary, then its last keep, then the conversation it added since, and the cut keeps
 * the newest keep-recent of that last part. So a head and the document written about
 * it — which the next compaction carries beside it — share what is left of the point
 * they compact above once two keeps, and the part of the chat no compaction reads,
 * are taken out, and the state a chain of these numbers gets to is the largest head
 * that fits under that with its own document beside it. The document takes one of
 * three forms (its floor, half the head, one answer), and the equation for each is
 * closed by a candidate head; the largest candidate that fits is the state.
 *
 * `fixedTokens` is fact 7 — that part of a chat, where it is known. Where it is not it
 * is 0, which is the optimistic reading: a head reached with no fixed part beside it is
 * a head these chats never get, and the pair built from it is a pair that wins no room
 * (see `compactionRoomWonFor`, and `fixedPartOf`, which is where the part stops being
 * unknown).
 */
function reachableAt(keepRecentTokens: number, triggersAtTokens: number, maxTokens: number, fixedTokens = 0): { headTokens: number; carriedSummaryTokens: number } {
  const above = Math.floor(triggersAtTokens) - Math.max(0, Math.floor(fixedTokens)) - 2 * Math.floor(keepRecentTokens);
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
 *
 * `fixedTokens` is a chat's fact 7 — the part of the chat in hand that no compaction
 * reads, where one is known. Every head and every keep here shares the room that part
 * leaves, so the pair is the pair for a chat of that fixed part, and a chat's landing
 * is below the point it is asked above by this construction. Asked without it, as it
 * is at a model's row where no chat has been read yet, it is 0: the pair for a model
 * that has nothing above its conversation. The part is a chat's, not a model's, so it
 * is measured at one chat (`fixedPartOf`) and asked of this from there — the moment a
 * chat's own first landing says the pair written for its model is the wrong pair for it,
 * and the moment this is asked again with what that landing says.
 */
export function planForModel(size: ModelSize, fixedTokens = 0): CompactionPlan | null {
  const window = Math.floor(size.contextWindow);
  const answer = Math.floor(size.maxTokens);
  if (!Number.isFinite(window) || !Number.isFinite(answer) || window <= 0 || answer <= 0) return null;

  const reserve = round1000(clamp(window / RESERVE_OF_WINDOW, RESERVE_MIN, window * RESERVE_MAX_SHARE));
  const triggersAt = window - reserve;
  if (triggersAt <= 0) return null;
  // Fact 7: a chat's instructions and the tools it is offered sit between its start and
  // every point below the window, and no cut is in any of them. What the conversation,
  // the two keeps and the document share is what is left of the point it is asked above
  // once that part is taken out — and a chat whose part is at that point has no room,
  // and no pair of numbers has a head to ask it for.
  const fixed = Math.max(0, Math.floor(fixedTokens));
  const conversationRoom = triggersAt - fixed;
  if (conversationRoom <= 0) return null;

  // A head, and the document written about it, have to share one of the model's answers
  // with room left for the chain's next additions (fact 2, at the plan's own room — a
  // chain that needs more than this is bounded at its document, see `session-manager`
  // 's `keepCompactionRoom`, and shrinking this head further is shrinking a head that
  // the document written about it is bigger than, which is no cut at all: fact 1).
  // The model writes the
  // document it is asked for at up to half the head, so the head that leaves room is
  // twice what is left of the answer's length. Below its floor a model writes at the
  // floor whatever it reads, so a model whose answer cannot hold a document at the
  // floor plus room has no head worth asking it for at all.
  const headWritable = answer >= SUMMARY_FLOOR + SUMMARY_ROOM_TO_GROW ? Math.floor(2 * (answer - SUMMARY_ROOM_TO_GROW)) : 0;

  const wanted = Math.floor(
    clamp(
      Math.min(Math.max(conversationRoom / HEAD_OF_TRIGGER, MIN_HEAD), Math.max(MIN_HEAD, answer * HEAD_OF_ANSWER)),
      Math.max(MIN_HEAD, 1),
      Math.max(MIN_HEAD, Math.min(MAX_HEAD, conversationRoom * HEAD_MAX_SHARE)),
    ),
  );
  const head = Math.floor(Math.min(wanted, headWritable));

  // The keep is the other half of fact 4, with fact 7's term taken out first: the room
  // the conversation gets above the point it is asked, less this head, less the document
  // the model writes about it, less that document again, which the next compaction
  // carries beside the keep. Halved because the keep is counted twice there — the last
  // compaction's, and this one's. A fixed part this big leaves the room a keep of MIN_KEEP
  // in it, which is where the plan stops being worth shrinking further: below this the
  // whole of pi's job is a cut of one message (see `MIN_KEEP`), and the head it still
  // leaves is the answer's own, not a share of the window's.
  const keepRecent = Math.floor((conversationRoom - head - summaryRoomFor(head, answer)) / 2);
  const keep = Math.max(MIN_KEEP, keepRecent);

  const reach = reachableAt(keep, triggersAt, answer, fixed);
  const headTokens = reach.headTokens;
  const carriedSummaryTokens = reach.carriedSummaryTokens;
  const summary = summaryRoomFor(headTokens, answer);
  // Where a compaction that works leaves this chat: the part no compaction reads, its
  // keep, and the document beside them (facts 4 and 7 read at one chat). This is the
  // number a pair is judged by — `compactionRoomWonFor` reads a landing against it.
  const landsAt = fixed + keep + summary;
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
 * What a compaction that worked took out of the chat, and where it left it: pi's own
 * two numbers, read off one report (`compaction_end` carries `tokensBefore`, and an
 * `estimatedTokensAfter` read from its own estimate of the context the chat now has).
 *
 * This is the one question a compaction answers about itself, and the plan never could:
 * the plan says where a chat is *asked*, and these say where it is *left*. Null when a
 * report has neither, which is a pi that predates the field — and an unknown landing is
 * nobody's to call unwon, so the caller that gets null keeps its other answer.
 */
export function landedRoomOf(compactionEnd: any): LandedRoom | null {
  const before = Number(compactionEnd?.result?.tokensBefore);
  const after = Number(compactionEnd?.result?.estimatedTokensAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return { tokensBefore: Math.floor(before), estimatedTokensAfter: Math.floor(after), takenTokens: Math.floor(before) - Math.floor(after) };
}

/** What a compaction left the chat at, and what it took out of it, in one report. */
export interface LandedRoom {
  /** The context the chat had when it was asked: pi's `tokensBefore`. */
  tokensBefore: number;
  /** The context it was left with: pi's `estimatedTokensAfter`. */
  estimatedTokensAfter: number;
  /** The difference — what this compaction took out of the chat. */
  takenTokens: number;
}

/**
 * The part of a chat's context no compaction reads — its instructions and the tools it
 * is offered — read from what one compaction reported.
 *
 * A compaction's landing is this chat's fixed part, the keep its numbers keep word for
 * word, and the document that compaction left beside them (facts 4 and 7 read at one
 * chat), so the landing less the keep and the document is the part. It is the only way
 * the question is answered at all, and the only way it is answered honestly: the part is
 * a chat's own — its project's instructions, the tools that chat is offered — and it is
 * on no model's row to be read from. Zero for a report that names no landing, and zero
 * is the plan read without a fixed part: nothing is claimed about a chat nobody has
 * compacted, and a chat whose landing is inside what its numbers and their document
 * account for gets no claim either.
 */
export function fixedPartOf(landed: LandedRoom | null, keepRecentTokens: number, carriedSummaryTokens: number): number {
  if (!landed) return 0;
  const kept = Number.isFinite(keepRecentTokens) ? Math.floor(keepRecentTokens) : 0;
  const carried = Number.isFinite(carriedSummaryTokens) ? Math.floor(carriedSummaryTokens) : 0;
  return Math.max(0, landed.estimatedTokensAfter - kept - carried);
}

/**
 * Whether a compaction won the room it was asked for: it left the chat below the point
 * it is asked above again.
 *
 * False is the state fact 6 measured seven times in one chat: the chat's last keep, the
 * document beside it and the part of its context no compaction reads — its instructions
 * and its tools — come to more than the point it is asked above, so a turn takes it over
 * again, and the next compaction has only what it just added to take out of. Nothing about
 * a summary went wrong there, and no pair of keep-recent and keep-free numbers the chat
 * runs takes that fixed part out of the way; the next turn asks again whatever this one
 * did. Where the pair was chosen without it, the pair chosen with it is asked for here
 * and written, and the attempts are left running — that is what makes this state stop
 * being what these chats do. The attempts are stopped only where that reading leaves no
 * pair, or leaves the pair the chat is already on, which is the state its own numbers
 * cannot answer: said once, with the two numbers, and with the part that sits above
 * them named, rather than bounding the document and paying a second summarization for
 * each, which is what the chat that was left at the point it was asked above would have
 * done, thirty minutes of it and seven compactions, until the merge stopped in the middle
 * of an answer (see `session-manager.ts`'s `keepCompactionRoom`, and `fixedPartOf`).
 */
export function compactionRoomWonFor(landed: LandedRoom | null, triggersAtTokens: number): boolean {
  if (!landed || !Number.isFinite(triggersAtTokens)) return true;
  return landed.estimatedTokensAfter < Math.floor(triggersAtTokens);
}

/**
 * The stop said where a compaction left the chat at the point it is asked above again —
 * fact 6 read at one chat, and the shape `COMPACT_STOP_NOTICE` is not: nothing went
 * wrong with a summary there, and the same call asked again leaves the chat where it was
 * asked again, so it is not the chat's count of failures that stops it.
 */
export const COMPACT_NO_ROOM_NOTICE = "Auto-compaction is off for this chat because a compaction left it where it was asked again";

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
  /** The part of this chat's context no compaction reads — its instructions and the tools it is offered — where one was known (fact 7). 0 is the pair read without one. */
  fixedPartTokens: number;
  /** What is left of the point it is asked above once that part is taken out: the room its conversation, its two keeps and its document share. */
  conversationRoomTokens: number;
  /** A head bigger than this many answers is written up at more than one of them holds: `HEAD_OF_ANSWER`, the largest head whose document has been seen to fit. */
  headFitsAnswerTokens: number;
  /** The longest document that finishes inside one answer. */
  summaryTokens: number;
  /** Where a compaction that finishes leaves the chat: its keep, the document beside it, and — where the pair was read with a chat's fixed part — that part beside them (facts 4 and 7). */
  landsAtTokens: number;
  /** Tokens of conversation the chat gets before the next one is asked. */
  progressTokens: number;
}

/** Null when nothing is known of the model's size — there is nothing to say about the pair then. */
export function roomShapeFor(size: ModelSize, room: WrittenRoom, fixedTokens = 0): RoomShape | null {
  const contextWindow = Math.floor(size.contextWindow);
  const maxTokens = Math.floor(size.maxTokens);
  if (![contextWindow, maxTokens, room.keepRecentTokens, room.reserveTokens].every(Number.isFinite)) return null;
  const keepRecentTokens = Math.floor(room.keepRecentTokens);
  const reserveTokens = Math.floor(room.reserveTokens);
  const triggersAtTokens = contextWindow - reserveTokens;
  const fixedPartTokens = Math.max(0, Math.floor(Number.isFinite(fixedTokens) ? fixedTokens : 0));
  const reach = reachableAt(keepRecentTokens, triggersAtTokens, maxTokens, fixedPartTokens);
  const headTokens = reach.headTokens;
  const carriedSummaryTokens = reach.carriedSummaryTokens;
  const summaryTokens = summaryRoomFor(headTokens, maxTokens);
  const landsAtTokens = fixedPartTokens + keepRecentTokens + summaryTokens;
  return {
    contextWindow,
    maxTokens,
    keepRecentTokens,
    reserveTokens,
    triggersAtTokens,
    fixedPartTokens,
    conversationRoomTokens: triggersAtTokens - fixedPartTokens,
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
  | "head-too-small"
  /** The part of the chat its instructions and tools make, which no compaction reads, is at the point it is asked above: a cut is out of reach whatever the numbers keep, and the chat fills its window from here. */
  | "fixed-part-at-the-point";

/** Read a shape as a fault. Null for a shape whose compaction works, and for one there is no shape for. */
export function roomFaultFor(shape: RoomShape | null): RoomFault | null {
  if (!shape) return null;
  if (shape.triggersAtTokens <= 0) return "keeps-free-the-whole-window";
  if (shape.keepRecentTokens >= shape.triggersAtTokens) return "keeps-past-its-point";
  // Asked before `nothing-left-to-cut`, which is the same shape read of the keeps alone:
  // where the fixed part is known and the room beside it is under two keeps and a token
  // of conversation, it is that part, and not the pair, that leaves nothing to take out
  // — the words say which (fact 7).
  if (shape.fixedPartTokens > 0 && shape.conversationRoomTokens < 2 * MIN_KEEP + MINIMUM_PROGRESS) return "fixed-part-at-the-point";
  if (shape.headTokens <= 0) return "nothing-left-to-cut";
  if (shape.triggersAtPercent >= CONTEXT_AT_WALL_PERCENT) return "compacts-at-the-wall";
  if (shape.headTokens > shape.maxTokens * HEAD_OF_ANSWER) return "summary-wont-fit";
  if (shape.carriedSummaryTokens >= shape.maxTokens) return "walks-to-the-cap";
  if (shape.headTokens < shape.summaryWantedTokens) return "head-too-small";
  return null;
}
