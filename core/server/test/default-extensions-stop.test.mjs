import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePi, freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * A portal that stops while it is installing what it starts with (extensions/defaults.json) lets the install going on
 * finish before it exits, and begins no other: pi is writing its settings, and with the portal gone it would go on
 * writing them alone, into a folder that may be on its way out; and the rest of the list, one after the other, ran past
 * the ten seconds docker waits before it kills. pi here is a stand-in that takes two seconds over each install and
 * notes when it starts and ends one.
 */
const home = testHome("default-extensions-stop-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const noted = path.join(home, "pi-installs.txt");
// The stand-in for pi, in the shape the machine runs (see fakePi): each install takes two seconds and says when it
// began and ended.
fakePi(
  bin,
  `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "list") process.stdout.write("User packages:\\n");
if (args[0] === "install") {
  fs.appendFileSync(${JSON.stringify(noted)}, "start " + args[1] + "\\n");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(pause, 0, 0, 2000);
  fs.appendFileSync(${JSON.stringify(noted)}, "end " + args[1] + "\\n");
}
`,
);

test("a portal stopped while it installs what it starts with exits only once the install has ended", async () => {
  const { child } = await startServer(serverEnv(home, await freePort(), { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORTAL_DEFAULT_EXTENSIONS: "on" }));
  // An install is going on.
  for (let i = 0; !(existsSync(noted) && readFileSync(noted, "utf8").includes("start")); i++) {
    assert.ok(i < 200, "the portal never began installing what it starts with");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  await once(child, "exit");
  const lines = readFileSync(noted, "utf8").trim().split("\n");
  const started = lines.filter((line) => line.startsWith("start ")).map((line) => line.slice(6));
  const ended = lines.filter((line) => line.startsWith("end ")).map((line) => line.slice(4));
  assert.deepEqual(ended, started, "every install that began had ended when the portal exited");
  assert.ok(started.length < 4, `no install began once the portal was stopping: ${started.join(", ")}`);
});
