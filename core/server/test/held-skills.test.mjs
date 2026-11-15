import { test } from "node:test";
import assert from "node:assert/strict";
import { holdInstructionSkills, rewritesInstructions } from "../dist/pi/held-skills.js";

// pi gathers the skills an installed package ships, so a package's skill sits in the
// prompt of every portal chat. `pi-init`'s `init` says "Initialize or update AGENTS.md",
// which a run takes up on its own: BlastRunHero's AGENTS.md is that skill's template
// ("PROJECT KNOWLEDGE BASE", OVERVIEW / STRUCTURE / COMMANDS / NOTES), added on 15
// August and grown to 254,261 characters before it was cleared. A rewrite of what every
// chat reads is held to the person's own call — pi keeps a skill marked
// `disableModelInvocation` out of the prompt and reachable as `/skill:<name>`.

const set = (...skills) => ({ skills, diagnostics: [] });

test("a skill offered as a rewrite of the folder's instructions is held", () => {
  const held = holdInstructionSkills(
    set({ name: "init", description: "Initialize or update AGENTS.md. Guides the agent to generate a context file." }),
  );
  assert.equal(held.skills[0].disableModelInvocation, true, "held from being picked on its own");
  assert.equal(held.skills[0].name, "init", "the skill itself is untouched otherwise");
  assert.deepEqual(held.diagnostics, [], "and nothing is reported against it");
});

test("a skill for a CLAUDE.md or a knowledge base is held too", () => {
  for (const description of [
    "Use when the folder needs a CLAUDE.md written from the code.",
    "Use when refreshing the project knowledge base.",
    "Use when the instructions file has gone stale.",
  ]) {
    assert.equal(rewritesInstructions({ name: "some-skill", description }), true, description);
  }
});

test("an ordinary skill is left as it was", () => {
  const tests = { name: "check-server-tests", description: "Use when checking server changes with tests." };
  const sync = { name: "sync-levels", description: "Use when level text changes: run sync-level-text.py." };
  const held = holdInstructionSkills(set(tests, sync));
  assert.deepEqual(held.skills, [tests, sync], "nothing is marked, and the list is the same objects");
});

test("a skill already marked by its own frontmatter is left alone", () => {
  const own = { name: "cut-a-release", description: "Use when cutting a release: bump, tag, push.", disableModelInvocation: true };
  const held = holdInstructionSkills(set(own));
  assert.equal(held.skills[0], own, "the same object, not a copy");
});

test("a skill that reads the instructions file is not held", () => {
  // Mentioning the file is not offering to write it: a skill that explains the folder
  // or checks something in it stays available to the model.
  const held = holdInstructionSkills(set({ name: "read-the-guide", description: "Use when answering questions about the README and the plans." }));
  assert.equal(held.skills[0].disableModelInvocation, undefined);
});
