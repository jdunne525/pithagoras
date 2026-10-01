import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package-style management (extensions, skills, prompts, themes, MCP adapters)
 * goes through the pi CLI rather than the RPC protocol, so these callers shell
 * out. Rather than trusting `pi` to be on PATH — the portal's own process often
 * starts without the npm global bin in reach, even though pi is clearly
 * installed and used via the SDK — resolve the executable directly from the
 * package that is always here. Only when that fails does it fall back to a bare
 * name, and only then does a missing binary surface (as an explanation, not the
 * raw `spawn pi ENOENT`).
 */
const execFileAsync = promisify(execFile);

export interface PiResult {
  stdout: string;
  stderr: string;
}

/** Thrown when the pi CLI cannot be found, i.e. `ENOENT` from spawning it. */
export class PiMissingError extends Error {}

function spawnNotFound(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return !!err && err.code === "ENOENT" && /spawn/i.test(err.message || "");
}

/**
 * Where to run pi from. Prefers an absolute resolution so it never depends on
 * PATH: an explicit override, else the package's own `bin` entry run through
 * this same Node. Returns null to mean "fall back to a bare `pi` on PATH".
 */
async function resolvePiTarget(): Promise<{ command: string; extra: string[] } | null> {
  const explicit = process.env.PI_BIN?.trim();
  if (explicit) return { command: explicit, extra: [] };

  try {
    const resolved = await import.meta.resolve("@earendil-works/pi-coding-agent");
    // `import.meta.resolve` points at the package's main file (here
    // `…/dist/index.js`), whose directory has no package.json — walk up to the
    // package root so the `bin` entry resolves against the right location.
    const pkgFile = fileURLToPath(resolved);
    let dir = path.dirname(pkgFile);
    while (dir !== path.dirname(dir) && !existsSync(path.join(dir, "package.json"))) {
      dir = path.dirname(dir);
    }
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin && pkg.bin["pi"]) || undefined;
    if (bin) {
      const cli = path.join(dir, bin);
      if (existsSync(cli)) return { command: process.execPath, extra: [cli] };
    }
  } catch {
    // Not present as a dependency here (e.g. a global-only install); fall back.
  }

  return null;
}

/** Run the pi CLI with arguments kept as an array — never a shell string. */
export async function runPi(
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<PiResult> {
  const target = await resolvePiTarget();
  const command = target?.command ?? "pi";
  const prefix = target?.extra ?? [];
  try {
    const r = await execFileAsync(command, [...prefix, ...args], opts);
    // execFile's types allow a Buffer when no encoding is fixed; always hand
    // back text so callers never have to think about it.
    return { stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
  } catch (e) {
    if (spawnNotFound(e)) {
      throw new PiMissingError(
        "The pi command could not be found here. Install @earendil-works/pi-coding-agent so it is on your PATH, then restart the portal.",
      );
    }
    throw e;
  }
}
