import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePi, inProcessHome } from "./server-harness.mjs";

/**
 * A page that asks for the extensions while the start is still installing the theme package that replaces Dusk is
 * answered once that is done, with the package and its themes in the answer: told sooner, it would find the theme it
 * had chosen gone and give it up. pi is a stand-in whose install waits for a file to appear.
 */
const home = inProcessHome("retired-wait-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const state = path.join(home, "installed.txt");
const release = path.join(home, "release");
const started = path.join(home, "started");
writeFileSync(state, "");
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agentDir, { recursive: true });
const settingsFile = path.join(agentDir, "settings.json");

const shipped = path.join(home, "shipped");
mkdirSync(path.join(shipped, "themes"), { recursive: true });
writeFileSync(
  path.join(shipped, "themes", "package.json"),
  JSON.stringify({ name: "pithagoras-themes", version: "1.0.0", pi: {}, pithagoras: { themes: [{ id: "dusk", name: "Dusk", dark: { accent: "#ff79c6" } }] } }),
);
writeFileSync(path.join(shipped, "defaults.json"), "[]");
const dusk = path.join(home, "image", "extensions", "theme-dusk");
writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));

// The stand-in for pi, in the shape the machine runs (see fakePi): its install waits for a file to appear.
fakePi(
  bin,
  `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "list") {
  process.stdout.write("User packages:\\n");
  for (const dir of fs.readFileSync(${JSON.stringify(state)}, "utf8").split("\\n").filter(Boolean)) {
    process.stdout.write("  " + dir + "\\n    " + dir + "\\n");
  }
} else if (args[0] === "install") {
  fs.writeFileSync(${JSON.stringify(started)}, "");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(pause, 0, 0, 50);
  fs.appendFileSync(${JSON.stringify(state)}, args[1] + "\\n");
  const s = JSON.parse(fs.readFileSync(${JSON.stringify(settingsFile)}, "utf8"));
  s.packages.push(args[1]);
  fs.writeFileSync(${JSON.stringify(settingsFile)}, JSON.stringify(s));
}
`,
);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { default: express } = await import("express");
const { extensionsRouter } = await import("../dist/api/extensions.js");
const { installDefaultExtensions } = await import("../dist/default-extensions.js");
const app = express();
app.use("/api", extensionsRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(() => server.close());

test("the list of extensions is not told while the package that replaces Dusk is being installed", async () => {
  const start = installDefaultExtensions(shipped);
  while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
  let answered = false;
  const asked = fetch(`http://127.0.0.1:${server.address().port}/api/extension-ui`).then(async (res) => {
    answered = true;
    return res.json();
  });
  await new Promise((r) => setTimeout(r, 400));
  const early = answered;
  // Released either way, or the stand-in would wait for ever.
  writeFileSync(release, "");
  assert.equal(early, false, "waits for the install");
  const { extensions } = await asked;
  await start;
  assert.deepEqual(extensions.map((e) => [e.name, e.themes.map((t) => t.id)]), [["pithagoras-themes", ["dusk"]]]);
});
