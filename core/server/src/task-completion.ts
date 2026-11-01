import { eventsSince } from "./db.js";

/**
 * Completion detection (Phase 4).
 *
 * A Task is only complete when its assistant actually emits the completion
 * promise on its own line. This module answers that question from a Session
 * Manager session's transcript using the existing event store — no new
 * storage is introduced, and the whole thing stays isolated behind three
 * functions so later phases (retry, recovery) can reuse it unchanged.
 */

/** The exact string a Task must emit on its own line to be complete. */
export const COMPLETION_PROMISE = "<PROMISE>THIS TASK IS DONE</PROMISE>";

// The phrase a Task must emit. Case matters: a model that lowercases it has
// not produced the marker we ask for, so the phrase is matched exactly below.
const PROMISE_PHRASE = "THIS TASK IS DONE";
// The tag name, allowed in any case so <PROMISE>, <promise>, <Promise> all
// count while the surrounding phrase stays case-sensitive.
const PROMISE_TAG = "[pP][rR][oO][mM][iI][sS][eE]";

// A single pair of angle-bracket tags around the phrase, where the tag names
// and brackets are matched loosely. Models reliably read <PROMISE> as HTML and
// drop the tags, mangle them into <!-- --> comments, or HTML-entity-encode
// them (&lt;) before emitting. Stray non-letter characters around the wrap
// (fences, whitespace) are tolerated; a neighbouring letter is not, so the
// wrap cannot hide inside a larger token.
const TAG_WRAP = new RegExp(
  `^[^a-zA-Z]*<[^>]*${PROMISE_TAG}>\\s*${PROMISE_PHRASE}\\s*<\\/?[^>]*${PROMISE_TAG}>[^a-zA-Z]*$`
);

// The phrase standing alone, with no tags at all — what a model emits when it
// drops the angle brackets entirely (its most common failure). Still requires
// the phrase on its own line, so it cannot be confused with an inline mention.
const BARE_PHRASE = new RegExp(`^${PROMISE_PHRASE}[.;:]*$`);

/** True if the text emits the completion promise standing alone on one line.
 *
 * The sole discriminator between a real completion and a false one is the
 * standalone-line property. The marker only counts when the phrase stands on
 * its own line — optionally wrapped in (possibly mangled or absent) tags, and
 * optionally followed by trailing punctuation. A mention inside prose, which
 * shares the phrase but never its own line, must NOT count: otherwise an
 * instruction to fail would be marked complete simply because the token
 * appeared. Loosening the tag matching therefore stays safe — it can only ever
 * accept more genuinely-on-their-own-line phrases, never inline ones. */
export function emitsCompletionPromise(text: string): boolean {
  if (!text) return false;
  return text
    .split(/\r?\n/)
    .some((raw) => {
      let line = raw
        .trim()
        .replace(/^(`+|~~~)/, "")
        .replace(/(`+|~~~)$/, "")
        .trim();
      // Normalise the two ways markup gets corrupted before it reaches here:
      // HTML comments models sometimes wrap tags in, and entity encoding of the
      // angle brackets themselves.
      line = line
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/<!--[^]*?-->/g, "");
      return TAG_WRAP.test(line) || BARE_PHRASE.test(line);
    });
}

/** Assistant text pieces in a session's events at or after the given seq. */
function assistantContents(sessionId: string, seq: number): string[] {
  const rows = eventsSince(sessionId, seq, 50000);
  const contents: string[] = [];
  for (const row of rows) {
    if (row.type !== "message_end") continue;
    let payload: any;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    // message_end nests the message under payload.message.
    const msg = payload?.message ?? payload;
    if (!msg || msg.role !== "assistant" || msg.content == null) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") contents.push(c.text);
      }
    } else if (typeof content === "string") {
      contents.push(content);
    }
  }
  return contents;
}

/**
 * Whether the assistant has emitted the completion promise in this session at
 * or after the given event seq. Reads forward only, so a Task already past its
 * starting prompt is never re-satisfied by words written before it.
 */
export function hasCompletedPromiseInSession(sessionId: string, seq = 0): boolean {
  return assistantContents(sessionId, seq).some(emitsCompletionPromise);
}

/**
 * Settle-then-check: wait until the transcript has finished being written, then
 * test for the promise. Guards against the flush race where the final message
 * has not been persisted yet when the run ends — polling before the writer
 * finishes would miss an end-of-turn promise and mislabel a finished Task. The
 * check is bounded so a stalled or absent transcript can never hang.
 */
export async function waitForCompletionPromise(
  sessionId: string,
  seq = 0,
  opts: { delayMs?: number; gapMs?: number; capMs?: number } = {}
): Promise<boolean> {
  const { delayMs = 400, gapMs = 250, capMs = 6000 } = opts;
  const deadline = Date.now() + capMs;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  let found = false;
  for (;;) {
    found = hasCompletedPromiseInSession(sessionId, seq);
    if (found) return true;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
  }
  return found;
}
