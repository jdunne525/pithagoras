/**
 * Skills whose own job is to rewrite what a folder loads as its instructions.
 *
 * pi reads the folder's `AGENTS.md` (or `CLAUDE.md`) into every turn of every
 * chat that works in it, so what a rewrite adds is paid again by every chat
 * afterwards: one project's file reached 254,261 characters, was cleared to
 * 21,163 on 12 November, and was back to 49,901 two days later — every byte of
 * that second growth written by a Task that had been offered a skill for the
 * purpose. The skill sits in the prompt of every chat here, because pi gathers
 * the skills an installed package ships and the portal runs with those settings
 * (see `sdk-client.ts`); its description says "Initialize or update AGENTS.md",
 * which is read as an offer the model takes up on its own.
 *
 * Held to what the person asked for: pi keeps a skill marked
 * `disableModelInvocation` out of the prompt entirely, so it stays reachable as
 * `/skill:<name>` and by reading the file, and nothing else about it changes.
 * What the Skills page lists is held the same way (`api/skills.ts`), so the page
 * says what the model is actually offered.
 */

/** The shape of what pi's loader hands a `skillsOverride`, of the parts read here. */
export interface SkillSet {
  skills: { name: string; description: string; disableModelInvocation?: boolean }[];
  diagnostics: unknown[];
}

/**
 * The words that say a skill exists to write the folder's instructions.
 *
 * Only its name and description are read: that is all the model sees when it
 * decides whether to pick the skill, and all that says what it is for. A skill
 * that merely mentions a context file in passing — one that reads the tests, or
 * one that answers questions about the folder — does not say it writes them.
 */
const REWRITES_INSTRUCTIONS = /agents\.md|claude\.md|agents\.override\.md|\.cursorrules|project knowledge base|context file|instruction(s)? file|instructions? for (the )?(ai|agent)/i;

/** Whether the skill is offered as a rewrite of the folder's instructions. */
export const rewritesInstructions = (skill: { name: string; description: string }): boolean =>
  REWRITES_INSTRUCTIONS.test(`${skill.name} ${skill.description}`);

/**
 * pi's skill list with each rewrite of the folder's instructions marked for the
 * person's own call, everything else — and the diagnostics — as they came.
 */
export function holdInstructionSkills<S extends SkillSet>(result: S): S {
  return {
    ...result,
    skills: result.skills.map((skill) =>
      skill.disableModelInvocation || !rewritesInstructions(skill) ? skill : { ...skill, disableModelInvocation: true },
    ),
  };
}
