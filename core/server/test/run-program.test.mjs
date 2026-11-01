import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePi, scratch } from "./server-harness.mjs";
import { programInvocation, programOnPath } from "../dist/run-program.js";
import { PiMissingError, runPi } from "../dist/api/pi-cli.js";

// Windows and the rest of the world run a command differently; only there is the call made through cmd.exe.
const WINDOWS = process.platform === "win32";

/**
 * Shelling out to a program named on PATH — pi for packages and extensions, npm for installs — is a Windows problem of
 * its own: those commands are batch files, Node will not spawn a batch file by itself, and `cmd.exe` is fussy about the
 * quotes it is given. A program in a folder named with a space, and an argument with a space in it, are the two shapes
 * the quoting has to carry — both are checked here, as is Node being told to leave the line it is given alone.
 */

const home = scratch("run-program-");
const asked = path.join(home, "asked.jsonl");
const plainBin = path.join(home, "bin");
const spacedBin = path.join(home, "a bin with a space");

// A pi that notes the arguments it was given, answers `list` as the real one does, and fails when asked to.
fakePi(
  plainBin,
  `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify(args) + "\\n");
if (args[0] === "list") process.stdout.write("User packages:\\n  npm:run-program\\n    " + \${pkg});
if (args[0] === "fail") { process.stderr.write("pi said no\\n"); process.exit(3); }
`.replaceAll("\${pkg}", JSON.stringify(path.join(home, "pkg"))),
);
fakePi(spacedBin, `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "list") process.stdout.write("User packages:\\n  npm:run-program-spaced\\n");
`);
mkdirSync(path.join(home, "pkg"), { recursive: true });

const PATH_WAS = process.env.PATH;
const PI_BIN_WAS = process.env.PI_BIN;
const putOnPath = (dir) => (process.env.PATH = `${dir}${path.delimiter}${PATH_WAS}`);
const lastAsked = () => JSON.parse(readFileSync(asked, "utf8").split("\n").filter(Boolean).at(-1));
const quoted = (text) => `"${text}"`;

const clean = () => {
  delete process.env.PI_BIN;
  process.env.PATH = PATH_WAS;
};
test.beforeEach(clean);
test.after(clean);

test("the pi on PATH answers to its own name", async () => {
  putOnPath(plainBin);
  const { stdout } = await runPi(["list"]);
  assert.match(stdout, /npm:run-program\b/);
});

test("an argument with a space in it arrives as the one argument it was", async () => {
  putOnPath(plainBin);
  await runPi(["install", "npm:a package 1.2.3"]);
  assert.deepEqual(lastAsked(), ["install", "npm:a package 1.2.3"]);
});

test("what cmd.exe takes for its own reaches the program as itself", async () => {
  putOnPath(plainBin);
  const tricky = "a&b|c<d>e^f%h!i";
  await runPi(["asked", tricky]);
  assert.deepEqual(lastAsked(), ["asked", tricky]);
});

test("a pi in a folder named with a space is found and run", async () => {
  putOnPath(spacedBin);
  const { stdout } = await runPi(["list"]);
  assert.match(stdout, /npm:run-program-spaced/);
});

test("PI_BIN may name a folder with a space in it", async () => {
  process.env.PI_BIN = path.join(spacedBin, "pi");
  const { stdout } = await runPi(["list"]);
  assert.match(stdout, /npm:run-program-spaced/);
});

test("a pi that ran and failed is the caller's news, not a missing command", async () => {
  putOnPath(plainBin);
  await assert.rejects(runPi(["fail"]), (e) => {
    assert.ok(!(e instanceof PiMissingError), String(e));
    assert.equal(e.code, 3);
    assert.match(String(e.stderr ?? e.message), /pi said no/);
    return true;
  });
});

test("a PI_BIN that is not there is explained, not the raw spawn error", async () => {
  process.env.PI_BIN = path.join(home, "nowhere", "pi");
  await assert.rejects(runPi(["list"]), (e) => {
    assert.ok(e instanceof PiMissingError, String(e));
    return true;
  });
});

/**
 * The call itself, as it is handed to Node: on Windows a batch file goes through cmd.exe with the whole call inside one
 * pair of quotes, and Node told to hand that line on untouched. Left to itself, Node turns the inner quotes into \" and
 * cmd.exe then looks for a program whose name begins and ends with a quote, and finds none — which is what a portal on a
 * Windows checkout saw, and not one extension of its own would start.
 */
test("a batch file is run through cmd.exe, with the call quoted whole", { skip: !WINDOWS }, () => {
  const file = path.join(spacedBin, "pi.cmd");
  assert.ok(programOnPath(file)?.ext === ".cmd", `${file} is not seen as a batch file`);
  const call = programInvocation(file, ["list", "a b"]);
  assert.equal(path.basename(call.command).toLowerCase(), "cmd.exe");
  assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(call.args[3], quoted(quoted(file) + " list " + quoted("a b")));
  assert.equal(call.windowsVerbatimArguments, true);
});

test("a program Windows can run by itself is spawned as itself", { skip: !WINDOWS }, () => {
  const git = programOnPath("git");
  assert.ok(git?.ext === ".exe", "git.exe is not on PATH for this test");
  const call = programInvocation("git", ["--version"]);
  assert.equal(call.command, git.file);
  assert.deepEqual(call.args, ["--version"]);
  assert.equal(call.windowsVerbatimArguments, undefined);
});

test("nothing answers to the name, so the call is left as it was named", () => {
  const call = programInvocation("nothing-named-like-this-anywhere", ["list"]);
  assert.equal(call.command, "nothing-named-like-this-anywhere");
  assert.deepEqual(call.args, ["list"]);
  assert.equal(call.windowsVerbatimArguments, undefined);
});
