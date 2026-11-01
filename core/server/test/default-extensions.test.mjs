import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePi, inProcessHome } from "./server-harness.mjs";

/**
 * The extensions a portal starts with: extensions/defaults.json names folders
 * of the portal's own, each installed once with `pi install <folder>` and an
 * ordinary package from then on. pi is a stand-in that keeps what was
 * installed in a file, and fails to install a folder named "broken" while
 * there is a file "failing" beside it.
 */
const home = inProcessHome("default-extensions-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const state = path.join(home, "installed.txt");
writeFileSync(state, "");
const settingsFile = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(settingsFile, JSON.stringify({ packages: [] }));

// The stand-in for pi, in the shape the machine runs: a shell script on the unixes, a batch file on Windows (see fakePi).
fakePi(
  bin,
  `const fs = require("node:fs");
const state = ${JSON.stringify(state)};
const settings = ${JSON.stringify(settingsFile)};
const args = process.argv.slice(2);
const read = () => fs.readFileSync(state, "utf8").split("\\n").filter(Boolean);
if (args[0] === "list") {
  process.stdout.write("User packages:\\n");
  for (const dir of read()) process.stdout.write("  " + dir + "\\n    " + dir + "\\n");
} else if (args[0] === "install") {
  const spec = args[1] ?? "";
  const fails = (name, pattern) => fs.existsSync(name) && pattern.test(spec);
  if (fails(${JSON.stringify(path.join(home, "failing"))}, /broken/)) {
    process.stderr.write("npm error: could not install " + spec + "\\n");
    process.exit(1);
  }
  if (fails(${JSON.stringify(path.join(home, "failing-themes"))}, /[\\/](themes|theme-.*)$/)) {
    process.stderr.write("npm error: could not install " + spec + "\\n");
    process.exit(1);
  }
  fs.appendFileSync(state, spec + "\\n");
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  s.packages.push(spec);
  fs.writeFileSync(settings, JSON.stringify(s));
}
`,
);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

/** A folder of extensions, each a package by these names, and the list a fresh portal installs. */
function shipped(names, defaults) {
  const dir = path.join(home, `shipped-${Math.random().toString(36).slice(2)}`);
  for (const [folder, name] of Object.entries(names)) {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify(defaults));
  return dir;
}

const installedNow = () => readFileSync(state, "utf8").split("\n").filter(Boolean);
/** Takes a package out, as `pi remove` does: from pi's list and its settings. */
function removed(dir) {
  writeFileSync(state, installedNow().filter((d) => d !== dir).map((d) => `${d}\n`).join(""));
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  settings.packages = settings.packages.filter((d) => d !== dir);
  writeFileSync(settingsFile, JSON.stringify(settings));
}

const { defaultExtensions, installDefaultExtensions, replaceRetiredExtensions } = await import("../dist/default-extensions.js");
const { extensionStash, setExtensionStash } = await import("../dist/db.js");

test("what the list names is installed once, from its folder, and one removed is not put back", async () => {
  const dir = shipped({ terminal: "pithagoras-terminal", git: "pithagoras-git" }, ["terminal", "git"]);
  assert.deepEqual(await installDefaultExtensions(dir), ["terminal", "git"]);
  assert.deepEqual(installedNow(), [path.join(dir, "terminal"), path.join(dir, "git")]);

  assert.deepEqual(await installDefaultExtensions(dir), [], "a second start installs nothing again");
  removed(path.join(dir, "git"));
  assert.deepEqual(await installDefaultExtensions(dir), [], "removed by hand, it stays removed");
  assert.deepEqual(installedNow(), [path.join(dir, "terminal")]);
});

test("a package the list adds later is installed on the next start, and one installed already under its name is left as it is", async () => {
  removed(installedNow()[0]);
  const dir = shipped({ terminal: "pithagoras-terminal", files: "pithagoras-files" }, ["terminal"]);
  // Someone's own copy of Files, installed before the portal's list named it.
  const own = shipped({ files: "pithagoras-files" }, []);
  writeFileSync(state, `${path.join(own, "files")}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [path.join(own, "files")] }));
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify(["terminal", "files"]));
  assert.deepEqual(await installDefaultExtensions(dir), [], "Terminal was installed once already, from the first test's folder of the same name");
  assert.deepEqual(installedNow(), [path.join(own, "files")], "the portal's Files is not pushed in beside someone's own");
});

test("an install that fails is tried again on the next start, and the rest still go in", async () => {
  const dir = shipped({ broken: "pithagoras-broken", notes: "pithagoras-notes" }, ["broken", "notes"]);
  writeFileSync(path.join(home, "failing"), "");
  assert.deepEqual(await installDefaultExtensions(dir), ["notes"]);
  assert.ok(!installedNow().includes(path.join(dir, "broken")));
  rmSync(path.join(home, "failing"));
  assert.deepEqual(await installDefaultExtensions(dir), ["broken"], "the next start installs it");
  assert.deepEqual(await installDefaultExtensions(dir), []);
});

test("the list names only folders of the portal's own that hold a package", () => {
  const dir = shipped({ terminal: "pithagoras-terminal" }, ["terminal", "../outside", ".hidden", "missing", 3, null, "terminal/../terminal"]);
  assert.deepEqual(defaultExtensions(dir).map((ext) => ext.folder), ["terminal"]);
  assert.deepEqual(defaultExtensions(path.join(home, "no-such-folder")), []);
  assert.ok(!existsSync(path.join(home, "outside")));
});

test("PORTAL_DEFAULT_EXTENSIONS=off installs none of them, and leaves them to be installed once it is on", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  process.env.PORTAL_DEFAULT_EXTENSIONS = "off";
  try {
    assert.deepEqual(await installDefaultExtensions(dir), []);
    assert.ok(!installedNow().includes(path.join(dir, "themes")));
  } finally {
    delete process.env.PORTAL_DEFAULT_EXTENSIONS;
  }
  assert.deepEqual(await installDefaultExtensions(dir), ["themes"], "nothing was recorded as installed while it was off");
});

test("Dusk and Warm, which are themes of the themes package now, are taken out of pi's list and the person keeps the theme", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const oldFolder = (folder) => path.join(home, "image", "extensions", folder);
  const dusk = oldFolder("theme-dusk");
  // The state an older portal left: the folders are gone, the entries are there, and so is what the portal kept for one.
  const own = shipped({ "theme-dusk": "somebody-elses-dusk" }, []);
  const ownDusk = path.join(own, "theme-dusk");
  writeFileSync(state, `${dusk}\n${ownDusk}\n`);
  writeFileSync(settingsFile, JSON.stringify({ theme: "x", packages: [dusk, ownDusk, { source: oldFolder("theme-warm"), themes: [] }, "npm:other-package"] }));
  setExtensionStash({ [dusk]: { source: dusk }, "npm:other-package": { source: "npm:other-package" } });

  assert.deepEqual(await replaceRetiredExtensions(dir), [dusk, oldFolder("theme-warm")]);
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.packages, [ownDusk, "npm:other-package", path.join(dir, "themes")], "a folder of that name that is there is someone's own");
  assert.equal(settings.theme, "x", "the rest of the file is as it was");
  assert.deepEqual(Object.keys(extensionStash()), ["npm:other-package"], "what was kept for the package that is gone goes with it");

  assert.deepEqual(await replaceRetiredExtensions(dir), [], "nothing is left to take out the next time");
  assert.deepEqual(installedNow().filter((d) => d === path.join(dir, "themes")), [path.join(dir, "themes")], "installed once");
});

test("the theme package is not installed in place of Dusk where it is installed already or where Dusk was switched off", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const gone = path.join(home, "image", "extensions");
  writeFileSync(state, `${path.join(dir, "themes")}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [path.join(dir, "themes"), path.join(gone, "theme-dusk")] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-dusk")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);

  writeFileSync(state, "");
  writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: path.join(gone, "theme-warm"), extensions: [], skills: [], prompts: [], themes: [] }] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-warm")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [], "it was off, so the person has no use for the replacement");
  assert.deepEqual(installedNow(), []);
});

test("the start takes the entries out before it installs what the list names, also with the defaults off", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const dusk = path.join(home, "image", "extensions", "theme-dusk");
  writeFileSync(state, `${dusk}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify([]));
  process.env.PORTAL_DEFAULT_EXTENSIONS = "off";
  try {
    assert.deepEqual(await installDefaultExtensions(dir), []);
  } finally {
    delete process.env.PORTAL_DEFAULT_EXTENSIONS;
  }
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);
});

test("the theme package installed and switched off is switched on where Dusk was in use, and stays off where Dusk was off too", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const gone = path.join(home, "image", "extensions");
  const themes = path.join(dir, "themes");
  const off = { source: themes, extensions: [], skills: [], prompts: [], themes: [] };
  writeFileSync(state, `${themes}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [off, path.join(gone, "theme-dusk")] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-dusk")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [themes], "on, as an entry the switch writes");
  assert.deepEqual(installedNow(), [themes], "not installed again");

  writeFileSync(settingsFile, JSON.stringify({ packages: [off, { source: path.join(gone, "theme-warm"), extensions: [], skills: [], prompts: [], themes: [] }] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-warm")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [off], "both off: left as the person had them");
});

test("an install of the theme package that fails leaves the entries in, and the next start installs it and takes them out", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const dusk = path.join(home, "image", "extensions", "theme-dusk");
  writeFileSync(state, "");
  writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));
  setExtensionStash({ [dusk]: { source: dusk } });
  writeFileSync(path.join(home, "failing-themes"), "");
  await assert.rejects(replaceRetiredExtensions(dir), /could not install/);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [dusk], "nothing was taken out");
  assert.deepEqual(Object.keys(extensionStash()), [dusk]);
  // The start itself says so and goes on.
  assert.deepEqual(await installDefaultExtensions(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [dusk]);

  rmSync(path.join(home, "failing-themes"));
  assert.deepEqual(await installDefaultExtensions(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);
  assert.deepEqual(Object.keys(extensionStash()), []);
});
