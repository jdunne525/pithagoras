/**
 * Which model failures the transcript should hear about.
 *
 * A failed model call closes its turn as an assistant message with stopReason
 * "error" and no text, and pi emits nothing else for it — without a notice the
 * transcript shows a prompt answered by silence. But pi recovers from many of
 * these on its own: a busy or overloaded provider is retried, and a prompt too
 * long for the context window is compacted and sent again. Those must not show
 * up as errors, so a failure is only reported once pi has given up on it.
 *
 * pi says so in two places. agent_end carries `willRetry`, which covers the
 * retry loop, and an overflow is decided afterwards by compaction_end. The
 * notice is therefore held until the next run starts or the session settles,
 * by which point both have had their say.
 */
import { runAway } from "./compaction-ladder.js";

export class ModelErrors {
  /** A failure pi has not recovered from, waiting to be reported. */
  private pending = new Map<string, string>();
  /** Retries pi has made for the turn in progress. */
  private retries = new Map<string, number>();

  /**
   * Feeds one pi event through. Returns the text of a notice to record, before
   * the event itself, when a failure has turned out to be final.
   */
  take(sessionId: string, msg: any): string | undefined {
    switch (msg?.type) {
      case "auto_retry_start":
        if (typeof msg.attempt === "number") this.retries.set(sessionId, msg.attempt);
        return undefined;

      // Retried to success, given up on, or cancelled during the backoff. A
      // final failure has already been noted at its agent_end, and a cancelled
      // retry is the user's own Stop, not a failure.
      case "auto_retry_end":
        this.retries.delete(sessionId);
        return undefined;

      case "agent_end": {
        const last = lastAssistant(msg.messages);
        if (last?.stopReason !== "error" || msg.willRetry === true) return undefined;
        // A request pi stopped is not a model's failure: the model was not asked
        // again and refused nothing, the run ended because one of the portal's
        // asks worked through the chat (a compaction, or the person's Stop).
        // Said as a model's failure, that line reads as the chat's own trouble
        // beside a compaction it was asked room in.
        if (runAway(last.errorMessage)) return undefined;
        const why = last.errorMessage || "the model failed to answer.";
        const n = this.retries.get(sessionId) ?? 0;
        this.pending.set(
          sessionId,
          n > 0 ? `Still failing after ${n} ${n === 1 ? "retry" : "retries"}: ${why}` : `Model error: ${why}`
        );
        return undefined;
      }

      // An overflow is not retried but compacted and sent again. Whether that
      // is happening is only known here.
      case "compaction_end": {
        const failed = this.pending.get(sessionId);
        if (msg.reason !== "overflow" || !failed) return undefined;
        if (msg.willRetry === true) this.pending.delete(sessionId);
        else if (msg.errorMessage) this.pending.set(sessionId, `${failed} — ${msg.errorMessage}`);
        return undefined;
      }

      // A new run means the last one's failure stood: a retry or an overflow
      // recovery would have said otherwise by now. The retry count carries on,
      // since the new run may be the retry itself.
      case "agent_start":
        return this.flush(sessionId);

      // The end of the work, retries and all.
      case "agent_settled": {
        const text = this.flush(sessionId);
        this.retries.delete(sessionId);
        return text;
      }
    }
    return undefined;
  }

  /** Drops whatever a previous client left half-told. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.retries.delete(sessionId);
  }

  private flush(sessionId: string): string | undefined {
    const text = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return text;
  }
}

function lastAssistant(messages: unknown): any {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * How long to wait before asking the same chat again after its run ended on an
 * errored answer, or null when asking again answers the same way.
 *
 * A model call that failed closes its turn with `stopReason: "error"`, and pi has
 * already retried the ones it recognises three times over 14 seconds
 * (`retry.enabled`, `retry.maxRetries` 3, `retry.baseDelayMs` 2,000). What is left
 * at the run's end is therefore either a sentence pi does not read as worth
 * retrying, or a provider still saying no after those three. Neither says the Task
 * finished: the turn ended because nothing was there to answer it.
 *
 * Read on this machine, that end is the commonest way an attempt is lost. Of the
 * 417 attempts the portal has recorded, 93 of its failed attempts end on an
 * errored answer: 73 on a provider's 429 (`{"code": 429, … "You exceeded your
 * current quota…"}` over a free-tier Gemini model whose metrics read `limit: 0`),
 * 7 on the local engine dying
 * (`the engine stopped unexpectedly (exit code None); the next request restarts
 * it`), and the rest on `Connection error.`, `Request timed out.`,
 * `connect ECONNREFUSED 127.0.0.1:8888` and `502 Error`. BlastRunHero's
 * `Brutes should shoot a green projectile` Task (c67318ec, 15 November) lost its
 * first three attempts that way, at 03:23:16, 04:38:58 and 05:16:59 — each of the
 * last two in the middle of a `write` — and each was answered by a brand-new
 * session starting the Task again from nothing.
 *
 * The two waits are the two shapes of "not there":
 *
 *  - **a limit that resets**: `Rate limit of 10 requests per minute exceeded.
 *    Please retry your request later.` Its own window is seconds, and pi's 14
 *    seconds of retries land inside it, so the ask is held a further 30 seconds;
 *  - **an engine or a connection gone**: the next request is what starts it back —
 *    the engine's own sentence says so — so 10 seconds is long enough to let a
 *    dying process finish dying.
 *
 * Anything else that failed is asked once more after the shorter wait: a sentence
 * nobody recognises is more often the engine than the ask, and the alternative —
 * throwing the chat's whole context away for a fresh session — costs minutes.
 *
 * Null is said for the failures that answer the same way when asked again: the
 * person's Stop and the portal's own stopped compaction (`runAway`), a model or a
 * key nobody has, a quota or a billing limit spent, a request the context cannot
 * hold. The commonest failure on this machine is of that last kind — 73 attempts
 * on one free-tier Gemini model, its message naming metrics of `limit: 0` — and
 * nothing but a different model or key answers it, which is what the chat's own
 * failure line says. These are also the failures pi refuses to retry, so the two
 * read the same list the same way.
 */
const RATE_LIMIT_WAIT_MS = 30_000;
const ENGINE_WAIT_MS = 10_000;

/** A limit that resets in seconds, and a server saying it is busy. */
const MODEL_WAIT_PATTERN =
  /rate.?limit|too many requests|please retry your request|retry your request later|overloaded|server.?busy|servers? (?:is|are) (?:currently )?busy|currently busy|high demand|at capacity|(?:temporarily |service )?unavailable|\b429\b/i;
/** Asked again, this answers the same way: what the person, or their provider
 *  account, has to change. These are the failures pi itself refuses to retry, plus
 *  the two the portal answers another way: a request the context cannot hold is
 *  compaction's, not a carry-on's, and a model nobody has is said as such. Read as
 *  words rather than as bare status numbers, so a message that merely counts 400
 *  tokens of something is not mistaken for a 400. */
const MODEL_END_PATTERN =
  /insufficient_quota|quota.?exceeded|exceeded.{0,40}quota|out of budget|billing|usage limit|available balance|GoUsageLimitError|FreeUsageLimitError|No API key|No models available|No model selected|unauthorized|forbidden|invalid api key|authentication|exceeds the context|context window|context length|invalid_request_error|not found/i;

export function carryWaitForModelError(errorMessage: unknown): number | null {
  const text = String(errorMessage ?? "");
  // A request stopped is not a model's failure to carry on from: the run ended
  // because of a Stop or of the portal's own ask working through the chat.
  if (!text || runAway(text)) return null;
  // What nothing but a person changes: said in the chat and left as the run's end.
  if (MODEL_END_PATTERN.test(text)) return null;
  if (MODEL_WAIT_PATTERN.test(text)) return RATE_LIMIT_WAIT_MS;
  // The engine or the connection gone — `the engine stopped unexpectedly (exit
  // code None); the next request restarts it`, `Connection error.`,
  // `Request timed out.`, `connect ECONNREFUSED 127.0.0.1:8888` — or a sentence
  // nobody recognises, which is more often that than the ask.
  return ENGINE_WAIT_MS;
}

/**
 * Whether a piece of answer text is a tool call written as words instead of
 * asked for with a tool call.
 *
 * pi reads a tool call out of a provider's structured response, not out of the
 * text of one, so an answer that is nothing but `<tool_call>…</function>` markup
 * asks for nothing and ends the run. The model meant to keep working: 15 November,
 * BlastRunHero's `Brutes should shoot` Task, attempt 4, at 06:04:03 — 53 tokens of
 * markup naming a `build` call, `stopReason: "stop"`, the run ended, the attempt
 * written failed over work mid-flight, and a fifth session begun from nothing.
 *
 * Only markup counts. Text with a sentence of the answer's own beside it is the
 * model talking about a tool call, which is an answer and stays one.
 */
export function toolCallWrittenAsText(text: unknown): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (!/<\s*(?:antml:?s*)?(?:tool_call|tool_use|function\s*=|parameter\s*=|invoke|parameter>|\/?tool_call)/i.test(trimmed)) return false;
  // Strip the tags, the fences and the punctuation between them: what is left is
  // any prose the answer wrote beside the markup.
  const prose = trimmed
    .replace(/```[^`]*```/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\w\s]/g, " ")
    .trim();
  return prose === "";
}

/**
 * pi's texts for a chat that has no model to answer with, said as the portal has it. They end by sending
 * the reader to pi's `/login` and to files inside node_modules, neither of which the portal has: what
 * happens when the provider of the default model was removed (pi then cannot name the model), when
 * none is set up, or when a provider has no key.
 */
export function plainFailure(text: string): string {
  if (/^No API key found for the selected model\b|^No models available\b|^No model selected\b/.test(text)) {
    return "There is no model to answer with: the provider of the model was removed, or none is set up. Pick a model in Settings → Models.";
  }
  const keyless = /^No API key found for ([^\s.]+)\./.exec(text);
  if (keyless) return `${keyless[1]} has no API key. Add one in Settings → Models, or pick another model.`;
  return text;
}
