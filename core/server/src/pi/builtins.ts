import type { ContextBreakdown, PiClient, PiCommand } from "./types.js";
import { piFile } from "./package.js";

/**
 * pi's built-in slash commands are implemented by whichever mode is running,
 * so `session.getCommands()` returns only extensions, templates and skills —
 * the TUI draws its own. The portal has to supply them too.
 *
 * The names and descriptions are read from the SDK's own BUILTIN_SLASH_COMMANDS
 * so they track pi's releases, but that module is not on the package's exports
 * map, so it is resolved by file path rather than a bare specifier.
 *
 * `where` decides who handles a command — the server acts on the session, the
 * client opens a piece of UI. Commands not listed here are TUI concerns
 * (`/quit`, `/hotkeys`, `/trust`, the auth pair) and are left out rather than
 * offered as a menu of things that quietly do nothing.
 */
const PORTAL_SUPPORTED: Record<string, "server" | "client"> = {
  compact: "server",
  session: "server",
  context: "server",
  export: "server",
  reload: "server",
  model: "client",
  settings: "client",
  new: "client",
  clear: "client",
  name: "client",
};

/**
 * What the portal says about the commands it reinterprets. These win over pi's
 * own wording: pi's /clear talks about clearing the context, while here it
 * starts another chat, and the menu must not promise the one that is not done.
 */
const PORTAL_DESCRIPTIONS: Record<string, string> = {
  new: "Start a new chat in this folder",
  clear: "Start a fresh chat in this folder",
  context: "Say where this chat's context goes, part by part",
};

/** Used only if the SDK's internal module moves; keeps `/` working regardless. */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  compact: "Manually compact the session context",
  session: "Show session info and stats",
  context: "Break the context down: prompt, files, tools, conversation",
  export: "Export session (HTML default, or specify path: .html/.jsonl)",
  reload: "Reload extensions, skills, prompts and settings",
  model: "Select model",
  settings: "Open settings",
  new: "Start a new session",
  clear: "Start a fresh chat in this folder",
  name: "Set session display name",
};

export interface BuiltinCommand extends PiCommand {
  where: "server" | "client";
  argumentHint?: string;
  /** Does nothing without an argument, so the menu completes it rather than running it. */
  needsArgument?: boolean;
}

/** `/name` with no name is a command that silently does nothing. */
const NEEDS_ARGUMENT = new Set(["name"]);

let cached: BuiltinCommand[] | undefined;

/** pi's builtins, filtered to the ones the portal actually implements. */
export async function getBuiltinCommands(): Promise<BuiltinCommand[]> {
  if (cached) return cached;

  let sdkCommands: { name: string; description: string; argumentHint?: string }[] = [];
  try {
    const mod: any = await import(piFile("core/slash-commands.js").href);
    sdkCommands = mod.BUILTIN_SLASH_COMMANDS ?? [];
  } catch (e) {
    console.error(`[portal] builtin command list unavailable from SDK: ${(e as Error).message}`);
  }

  const bySdk = new Map(sdkCommands.map((c) => [c.name, c]));
  cached = Object.entries(PORTAL_SUPPORTED).map(([name, where]) => ({
    name,
    description: PORTAL_DESCRIPTIONS[name] ?? bySdk.get(name)?.description ?? FALLBACK_DESCRIPTIONS[name],
    argumentHint: bySdk.get(name)?.argumentHint,
    ...(NEEDS_ARGUMENT.has(name) ? { needsArgument: true } : {}),
    source: "builtin",
    where,
  }));
  return cached;
}

export async function findServerBuiltin(name: string): Promise<BuiltinCommand | undefined> {
  return (await getBuiltinCommands()).find((c) => c.name === name && c.where === "server");
}

/**
 * Why `message` cannot be sent with pictures, or undefined if it can.
 *
 * A portal command acts on the session and never reaches the model, so
 * pictures sent with one would be lost without a word. Asked before anything
 * is done with them, so the refusal reaches someone who can put them back.
 */
export async function picturesRefused(message: string): Promise<string | undefined> {
  const name = /^\/([\w-]+)/.exec(message.trim())?.[1];
  if (name && (await findServerBuiltin(name))) {
    return `/${name} does not take pictures. Send them in a message of their own.`;
  }
  return undefined;
}

/** Run a server-side builtin, returning the notice to show in the transcript. */
export async function runBuiltin(name: string, args: string, client: PiClient): Promise<string> {
  switch (name) {
    case "compact":
      await client.compact();
      return "Context compacted.";

    case "context": {
      const breakdown = await client.getContextBreakdown?.();
      // A pi in a container is reached over RPC, which answers the whole figure and
      // nothing inside it. Say so, and where else to look, rather than invent parts.
      if (!breakdown) {
        return "This chat's pi runs in a container, which reports how full the chat is and not what its parts weigh. `/session` gives the whole figure; a chat on the portal's own host answers `/context` in full.";
      }
      return contextBreakdownText(breakdown);
    }

    case "reload":
      await client.reload();
      return "Reloaded extensions, skills, prompts and settings.";

    case "session": {
      const [state, stats] = await Promise.all([client.getState(), client.getStats()]);
      return [
        `Model: ${state.model.name}`,
        `Effort: ${state.thinkingLevel}`,
        stats.contextUsage.tokens === null || stats.contextUsage.percent === null
          ? `Context: unknown until the next reply / ${stats.contextUsage.contextWindow.toLocaleString()}`
          : `Context: ${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} (${stats.contextUsage.percent.toFixed(1)}%)`,
        `Tokens: ${stats.tokens.input.toLocaleString()} in, ${stats.tokens.output.toLocaleString()} out`,
        `Cost: $${stats.cost.toFixed(4)}`,
        `Tool calls: ${stats.toolCalls}`,
      ].join("\n");
    }

    case "export": {
      const file = await client.exportSession(args.trim() || undefined);
      return `Exported to ${file}`;
    }

    default:
      throw new Error(`'${name}' is not a server-side command`);
  }
}

/** Numbers as the portal writes them, whatever the host's locale is set to. */
const num = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The breakdown, in the words a person reads in the transcript.
 *
 * Largest part first, and the files under the part they sit in: the question
 * `/context` is asked to is "what is holding my window", and the answer is the
 * first line of it. Every figure is pi's own estimate (four characters to a
 * token), so they add up to the percentage the pill shows rather than to a
 * second guess at the same thing.
 */
export function contextBreakdownText(b: ContextBreakdown): string {
  const window = b.contextWindow;
  const pct = (n: number, of: number) => (of > 0 ? ` (${((n / of) * 100).toFixed(1)}%)` : "");
  const lines: string[] = [];

  lines.push(
    b.tokens === null || b.percent === null
      ? `Context: counted again at the next reply · ${num(window)} tokens in the window`
      : `Context: ${num(b.tokens)} of ${num(window)} tokens (${b.percent.toFixed(1)}%)`,
  );
  // What the provider counted is a different thing from what pi counts, and the
  // gap is the part nobody can see in the pill: the tool declarations.
  if (b.sentTokens) {
    const gap = b.tokens === null ? 0 : b.sentTokens - b.promptTokens - b.historyTokens;
    lines.push(
      `What the provider counted on its last answer: ${num(b.sentTokens)}${gap > 0 ? ` — ${num(gap)} of it is the tool declarations, which pi's figure above leaves out` : ""}`,
    );
  }

  lines.push(`It opens with ${num(b.promptTokens)} tokens${window ? ` (${((b.promptTokens / window) * 100).toFixed(1)}% of the window)` : ""}:`);
  for (const part of b.prompt) lines.push(`  ${part.name} — ${num(part.tokens)} tokens${pct(part.tokens, b.promptTokens)}`);
  // The files are inside the prompt — inside `project_context`, which is only the
  // wrapper — and named under it, because that is where the weight of a chat's
  // opening sits: a project's own file is usually the whole of the first line.
  for (const file of b.files) {
    const cut = file.leftOut;
    lines.push(
      `    ${file.path} — ${num(file.tokens)} tokens${
        cut ? `, of ${num(cut.wholeTokens)}: read to the cap of ${num(cut.cap)} on one context file, and the chat was told what is missing` : ""
      }`,
    );
  }

  const toolNames = b.tools.map((one) => `${one.name} ${num(one.tokens)}`);
  const shown = toolNames.slice(0, 8);
  const rest = b.tools.length - shown.length;
  lines.push(
    `Tools declared to the model: ${num(b.toolTokens)} tokens${window ? ` (${((b.toolTokens / window) * 100).toFixed(1)}%)` : ""} — ${num(b.tools.length)} of them` +
      (shown.length ? ` (${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""})` : ""),
  );

  lines.push(`The conversation: ${num(b.historyTokens)} tokens${window ? ` (${((b.historyTokens / window) * 100).toFixed(1)}%)` : ""}`);
  for (const one of b.history) lines.push(`  ${one.name} — ${num(one.tokens)} tokens`);

  lines.push(
    b.cap > 0
      ? `Each context file is held to ${num(b.cap)} tokens of a chat's prompt — yours to change in Settings → General. What is past it stays in the file, and a chat reads it when it needs it.`
      : "Context files are read whole: the cap is off.",
  );
  return lines.join("\n");
}
