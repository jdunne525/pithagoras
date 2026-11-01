import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { programInvocation } from "../run-program.js";
import { piCli } from "../pi/package.js";

/**
 * Package-style management (extensions, skills, prompts, themes, MCP adapters)
 * goes through the pi CLI rather than the RPC protocol, so these callers shell out.
 *
 * `pi` on PATH is asked for first: it is the one the person installed and keeps
 * up to date, and a test's stand-in for pi is found there too. When nothing on
 * PATH answers, the pi of the portal's own package is run with this same Node,
 * which is how the portal uses pi through the SDK and needs no PATH at all — a
 * portal started by a service, a scheduled task or `start.ps1` often has the npm
 * global bin out of reach. Where neither is there, the missing CLI surfaces as a
 * `PiMissingError`: an explanation, not the raw `spawn pi ENOENT`.
 */
const execFileAsync = promisify(execFile);

export interface PiResult {
  stdout: string;
  stderr: string;
}

/** Thrown when the pi CLI cannot be found, i.e. nothing that answers to `pi` could be spawned. */
export class PiMissingError extends Error {}

/**
 * An error from spawning, said of the program rather than of anything the program did: no such program (`ENOENT`),
 * a batch file Node will not spawn by itself (`EINVAL`), a file Node may not run (`EACCES`, `ENOEXEC` — a shell
 * script named `pi` in a Windows checkout, where only the extensions Windows knows are run).
 */
function spawnNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "EINVAL" || code === "EACCES" || code === "ENOEXEC";
}

/**
 * What `cmd.exe` says when the program it was told to run is not there: it answers 1 with a line naming what it looked
 * for, which is the same news as `ENOENT` of the unixes. A portal started by a service or a scheduled task has a PATH of
 * its own, and the npm global folder where `pi.cmd` is may not be in it.
 */
function notAProgram(e: { code?: unknown; stderr?: unknown }): boolean {
  const text = String(e.stderr ?? "");
  return (
    e.code === 1 &&
    /is not recognized as an internal|is not recognized|cannot find the path specified|is not an internal or external/i.test(text)
  );
}

const text = (r: { stdout: unknown; stderr: unknown }): PiResult => ({
  // execFile's types allow a Buffer when no encoding is fixed; always hand back text so
  // callers never have to think about it.
  stdout: String(r.stdout ?? ""),
  stderr: String(r.stderr ?? ""),
});

/** Run the pi CLI with arguments kept as an array — never a shell string. */
export async function runPi(
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<PiResult> {
  const explicit = process.env.PI_BIN?.trim();
  const fromPath = programInvocation(explicit || "pi", args);
  try {
    return text(await execFileAsync(fromPath.command, fromPath.args, { ...opts, windowsVerbatimArguments: fromPath.windowsVerbatimArguments }));
  } catch (e) {
    // A pi that ran and failed is the caller's news, not a missing CLI.
    if (!spawnNotFound(e) && !notAProgram(e as { code?: unknown; stderr?: unknown })) throw e;
    if (explicit) throw new PiMissingError(`The pi command named by PI_BIN (${explicit}) could not be run.`);
  }

  // Nothing on PATH answers: this package's own pi, run by this Node.
  const cli = piCli();
  if (!cli) {
    throw new PiMissingError(
      "The pi command could not be found here. Install @earendil-works/pi-coding-agent so it is on your PATH, then restart the portal.",
    );
  }
  try {
    return text(await execFileAsync(process.execPath, [cli, ...args], opts));
  } catch (e) {
    if (spawnNotFound(e)) throw new PiMissingError(`The pi of ${cli} could not be run.`);
    throw e;
  }
}
