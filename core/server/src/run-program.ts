import { statSync } from "node:fs";
import path from "node:path";

/**
 * How to spawn a program named on PATH.
 *
 * On unix, the commands npm and pi install are executable files with no suffix, and spawning the name finds them.
 * Windows runs no file whose extension its loader does not know, and Node will not spawn a batch file by itself
 * (since Node 21: EINVAL), so there a name is looked for among the extensions Windows would try, in the folders of
 * PATH; a batch file found is run through cmd.exe, which is what runs it, and the file itself is named to cmd.exe,
 * with the arguments after it. A name given in full, with the extension written out, is taken as it is written when
 * Windows runs that extension by itself.
 */

const BATCH = new Set([".cmd", ".bat"]);

/** How a call is made: what to spawn, with what arguments, and how Node is to pass them on. */
export interface ProgramCall {
  command: string;
  args: string[];
  /** Set where the portal built the command line itself and Node must hand it on untouched (`cmd.exe` on Windows). */
  windowsVerbatimArguments?: boolean;
}

/** The extensions Windows adds to a name when it looks for a program, as the machine is set up to try them. */
const extensions = () => {
  const fromEnv = (process.env.PATHEXT || "")
    .split(";")
    .map((ext) => ext.toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [".com", ".exe", ".bat", ".cmd"];
};

/** An argument as `cmd` is to see it: in quotes when it holds a space, or a character `cmd` would take for its own. */
const quoted = (arg: string): string => (/[\s&|<>^()!%"`]/.test(arg) ? `"${arg}"` : arg);

/** A file, and not a folder that answers to the name. */
const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Where a name really is, with the extension Windows found it by; undefined when nothing on PATH answers. */
export function programOnPath(name: string): { file: string; ext: string } | undefined {
  const direct = name.includes("/") || name.includes("\\");
  const folders = direct ? ["" as string] : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // A name given with an extension Windows runs by itself — a whole path to npm.cmd, as PI_BIN names pi — is that file,
  // with its own extension. A name given without one is looked for among the extensions Windows would add, as its
  // loader would: npm's `pi` is a shell script a Windows machine cannot run, and next to it lies the `pi.cmd` it can.
  const own = direct ? path.extname(name).toLowerCase() : "";
  const runsItself = own === ".exe" || own === ".com" || BATCH.has(own);
  for (const dir of folders) {
    const exact = path.join(dir, name);
    if (runsItself && isFile(exact)) return { file: exact, ext: own };
    for (const ext of extensions()) {
      const file = path.join(dir, name + ext);
      if (isFile(file)) return { file, ext };
    }
    if (!direct && isFile(name)) return { file: name, ext: "" };
  }
  return undefined;
}

export function programInvocation(command: string, args: string[]): ProgramCall {
  if (process.platform !== "win32") return { command, args };
  const found = programOnPath(command);
  if (!found) return { command, args };
  if (!BATCH.has(found.ext)) return { command: found.file, args };
  // /d: do not change the drive with a letter alone, /s: a quoted command is taken whole, /c: run what follows.
  // `cmd` takes the outer pair of quotes off a /c line, so the whole call is put inside one pair, and the program and
  // any argument with a space in it inside their own — npm, in a folder named with a space, stays one program.
  // Node is told to leave that line alone: its own escaping of arguments turns the quotes into \" and `cmd` then
  // looks for a program whose name starts and ends with a quote, and finds none.
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${[quoted(found.file), ...args.map(quoted)].join(" ")}"`], windowsVerbatimArguments: true };
}
