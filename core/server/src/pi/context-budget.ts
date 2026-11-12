/**
 * How much of what a chat starts with one of its context files may take.
 *
 * pi reads every AGENTS.md or CLAUDE.md from the chat's folder up to the root,
 * whole, and hands the whole of each to the model on every turn of the chat. A
 * project's knowledge base grows — the agent writes what it learned into it —
 * and nothing in pi says no. One project's AGENTS.md reached 254,261 characters,
 * and the chat opened onto it was a third of the way through a 204,800-token
 * window before anyone had asked a question. Compaction cannot help: the prompt
 * is not part of what a compaction takes out, so that third is spent again on
 * every turn.
 *
 * So the portal says no: a file longer than the cap is read to the cap, and what
 * is past it stays in the file. The chat is told what was left out — the size of
 * the whole, where the reading stopped, and the headings it did not get — which
 * is what it needs to go and read one of them with `read`. A chat keeps the map
 * of the book and the top of it instead of the whole book, and spends the room
 * on the conversation, which is the part that grows.
 *
 * The cap is per file, not over the whole prompt: which folders a chat inherits
 * context from is the project's business, and one enormous file is the shape
 * that actually happens.
 */
import { getSetting, putSetting } from "../db.js";

/**
 * pi's own reading of a token: four characters (its `estimateTokens`).
 *
 * The same estimator as the pill's, so the numbers in the breakdown are the
 * numbers the context percentage is made of. It is an estimate — what the
 * provider counted is reported beside it, since they differ.
 */
export const CHARS_PER_TOKEN = 4;

/** A cap under this cannot hold an overview of anything; over this is no cap at all. */
export const CONTEXT_CAP_MIN = 1_000;
export const CONTEXT_CAP_MAX = 200_000;

/**
 * What one context file is held to, unless somebody set a number.
 *
 * pi leaves 20,000 tokens of a conversation untouched when it compacts, so a
 * file longer than that is not instructions to a chat: it is a library the chat
 * happens to be sitting beside. 12,000 tokens is 6% of a 200k window and 19% of
 * a 64k one — enough for an overview, a structure map and the commands, which
 * is what the top of a knowledge base holds.
 */
export const CONTEXT_CAP_DEFAULT = 12_000;

/** The settings row the number lives in; empty is the default above. */
export const CONTEXT_CAP_KEY = "context_cap";

/** A number nobody is holding a file to: whole files are read. */
export const NO_CAP = 0;

/** The headings the note lists, and how long each of them may be to be worth listing. */
const LISTED_SECTIONS = 16;
const SECTION_CHARS = 72;

/** pi's estimate, in tokens, of `chars` of text. */
export function tokensOf(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** Refused rather than clamped: a cap quietly different from the one typed would be found out by a truncated file. */
export function contextCapProblem(tokens: unknown): string | undefined {
  if (Number.isInteger(tokens) && (tokens as number) >= CONTEXT_CAP_MIN && (tokens as number) <= CONTEXT_CAP_MAX) return undefined;
  return `The context file cap must be a whole number between ${CONTEXT_CAP_MIN.toLocaleString("en-US")} and ${CONTEXT_CAP_MAX.toLocaleString("en-US")} tokens`;
}

/** A number nobody set: the default above is what a chat is held to. */
export function storedContextCap(): number | null {
  const saved = getSetting(CONTEXT_CAP_KEY);
  if (saved === undefined || saved === "") return null;
  const n = Number(saved);
  return n === NO_CAP || (Number.isInteger(n) && n >= CONTEXT_CAP_MIN && n <= CONTEXT_CAP_MAX) ? n : null;
}

/**
 * The cap in force for every chat: what was set, else the default, and 0 where
 * somebody asked for whole files. Read each time a chat's prompt is built, so a
 * change lands in the next chat opened — and in this one when it is reloaded.
 */
export function getContextCap(): number {
  const saved = getSetting(CONTEXT_CAP_KEY);
  if (saved === undefined || saved === "") return CONTEXT_CAP_DEFAULT;
  const n = Number(saved);
  if (n === NO_CAP) return NO_CAP;
  return Number.isInteger(n) && n >= CONTEXT_CAP_MIN && n <= CONTEXT_CAP_MAX ? n : CONTEXT_CAP_DEFAULT;
}

/** null hands the number back to the default; 0 reads whole files. */
export function setContextCap(tokens: number | null): void {
  putSetting(CONTEXT_CAP_KEY, tokens === null ? "" : String(tokens));
}

/** What was left out of one file, and how to get it back. */
export interface LeftOut {
  path: string;
  /** The file as pi would weigh it, whole. */
  wholeTokens: number;
  /** What the chat was given, the note about what is missing included. */
  keptTokens: number;
  /** Where the reading stopped, and how long the file is, in lines. */
  keptLines: number;
  totalLines: number;
  /** The headings past the cut, in the order they come, up to a dozen-odd. */
  sections: string[];
  /** Headings past the ones listed, so a chat knows the list is not the whole map. */
  moreSections: number;
  /** The cap that did it, in tokens. */
  cap: number;
}

export interface Held {
  files: { path: string; content: string }[];
  /** One entry per file read to its cap, in the order the chat reads them. */
  leftOut: LeftOut[];
}

/** The lines of a file's remainder that name a section, `#` to `####`. */
function headingsOf(rest: string): string[] {
  const out: string[] = [];
  for (const match of rest.matchAll(/^#{1,4}[ \t]+(.+)$/gm)) {
    const name = match[1].trim();
    if (name) out.push(name.length > SECTION_CHARS ? `${name.slice(0, SECTION_CHARS - 1)}…` : name);
  }
  return out;
}

/**
 * One file read to the cap, with a note saying what is not there.
 *
 * Cut at a line, never mid-line: a note that lands in the middle of a sentence
 * reads as the file's own words. The note is added on top of the cap — it is a
 * few hundred characters, and the number it holds is the reason it is worth
 * spending them.
 */
function holdFile(file: { path: string; content: string }, cap: number): { file: { path: string; content: string }; leftOut?: LeftOut } {
  const budget = cap * CHARS_PER_TOKEN;
  if (file.content.length <= budget) return { file };

  const at = file.content.lastIndexOf("\n", budget);
  // A line that runs past the budget — one long table, one minified block — would
  // otherwise cut the file at its top and lose the very room the cap exists to
  // keep. Past half the budget gone, the cut goes mid-line instead, and the note
  // below says what is missing rather than the file pretending to end there.
  const cut = at > budget * 0.5 ? at : Math.min(budget, file.content.length);
  const head = file.content.slice(0, cut);
  const rest = file.content.slice(cut);
  const lines = file.content.split("\n");
  const keptLines = head.split("\n").length;
  const headings = headingsOf(rest);

  const wholeTokens = tokensOf(file.content.length);
  const capSaid = cap.toLocaleString("en-US");
  const parts = [
    `and ${rest.length.toLocaleString("en-US")} more characters of this file were not loaded: it holds ${file.content.length.toLocaleString("en-US")} characters (about ${wholeTokens.toLocaleString("en-US")} tokens), and one context file is held to ${capSaid} tokens of a chat's prompt.`,
    `What is not here starts at line ${keptLines + 1} of ${lines.length.toLocaleString("en-US")}.`,
  ];
  if (headings.length) parts.push(`The sections past that are: ${headings.slice(0, LISTED_SECTIONS).map((s) => `"${s}"`).join(", ")}${headings.length > LISTED_SECTIONS ? `, and ${headings.length - LISTED_SECTIONS} more` : ""}.`);
  parts.push("Read what you need with the read tool — the path is above, and `offset` is a line number.");

  const note = `[... ${parts.join(" ")}]`;
  return {
    file: { ...file, content: `${head}\n\n${note}\n` },
    leftOut: {
      path: file.path,
      wholeTokens,
      keptTokens: tokensOf(head.length + note.length),
      keptLines,
      totalLines: lines.length,
      sections: headings.slice(0, LISTED_SECTIONS),
      moreSections: Math.max(0, headings.length - LISTED_SECTIONS),
      cap,
    },
  };
}

/**
 * The files a chat is handed, each held to the cap, and what that left out.
 *
 * Files under the cap are passed on untouched, and in the order given: pi's own
 * reading of them is not changed by anything here when there is nothing to cut.
 */
export function capContextFiles(files: { path: string; content: string }[], cap = getContextCap()): Held {
  if (cap <= NO_CAP) return { files, leftOut: [] };
  const leftOut: LeftOut[] = [];
  const held = files.map((file) => {
    const one = holdFile(file, cap);
    if (one.leftOut) leftOut.push(one.leftOut);
    return one.file;
  });
  return { files: held, leftOut };
}

/**
 * The line a chat says when one of its files was read to its cap.
 *
 * The room is the person's to know about: a chat that starts 20% instead of 33%
 * full looks like nothing happened, while a file was left out of it. One line
 * names each file, what it weighs and what the chat got, and where the number is
 * set.
 */
export function cappedNotice(leftOut: LeftOut[]): string {
  const said = leftOut.map((one) => {
    const map = one.sections.length
      ? ` Its remaining sections are named in the prompt, so it can read the one it needs${one.moreSections ? ` (${one.moreSections} more than were named)` : ""}.`
      : "";
    return `${one.path} holds ${one.wholeTokens.toLocaleString("en-US")} tokens and was read to ${one.keptTokens.toLocaleString("en-US")}, from line 1 to ${one.keptLines.toLocaleString("en-US")} of ${one.totalLines.toLocaleString("en-US")}.${map}`;
  });
  return `Context left out of this chat's opening prompt: ${said.join(" ")} Each context file is held to ${leftOut[0]?.cap.toLocaleString("en-US")} tokens, which is yours to change in Settings → General.`;
}
