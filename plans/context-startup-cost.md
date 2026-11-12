# Why a BlastRunHero chat opens at a third full, and what was changed

Asked of a new session for the `BlastRunHero` project: the context pill read
**33%** before anything had been asked of the chat. Break the startup context
down, say what is holding it, and fix it.

Measured on session `uFMAT6GNpERO` (workspace `g:/work/git/BlastRunHero`, model
`strata/qwen3.8-flash-next-gyro-gyro-m`, window **204,800 tokens**), started
2026-07-29 14:42. The same shape is in every one of the 22 chats of that project.

## What was sent, part by part

pi builds the system prompt from named sections; each was measured as it is
handed to the model, and counted pi's own way — four characters to a token, which
is the estimator its context percentage is worked out from.

| Part | Sent as | Characters | Tokens | Of the window |
| --- | --- | --- | --- | --- |
| **project_context** | the project's knowledge base | **254,434** | **63,609** | **31.1%** |
| skills | the skills list | 2,672 | 668 | 0.33% |
| docs | where pi's docs live | 1,254 | 314 | 0.15% |
| rules | the portal's rules | 726 | 182 | 0.09% |
| addendum | the portal's skills folder | 379 | 95 | 0.05% |
| tools | the tools paragraph | 324 | 81 | 0.04% |
| preamble | the "you are an expert" line | 126 | 32 | 0.02% |
| cwd | the working folder | 37 | 10 | 0.00% |
| **opening prompt** | | **259,976** | **64,994** | **31.7%** |
| the message asked | | 1,658 | 415 | 0.20% |
| **what pi counts at the start** | prompt + conversation | | **65,403** | **31.9%** |
| what the provider counted | its first answer | | **68,883** | **33.6%** |

The provider's figure is the one the pill turns into 33%: it is the same content
plus the **tool declarations** — five tools, whose schemas go in the request with
the prompt but are not part of what pi counts — and the model's own tokenizer,
which reads pi's chars/4 estimate as roughly 5% smaller than the truth.

Inside `project_context`:

| | Characters |
| --- | --- |
| `g:\work\git\BlastRunHero\AGENTS.md` | **254,261** read as text (256,599 bytes on disk; ≈ 63,600 tokens) |
| pi's `<project_instructions>` wrapper | ~173 |
| everything else in the section | nil — this file is the section |

One file, on its own inside that section. Nothing else is loaded with it: no
`.pi/` folder in the project, and no `AGENTS.md` or `CLAUDE.md` above it. The
portal's own agent folder contributes 424 characters of its own file.

## What is consuming it

`BlastRunHero/AGENTS.md` is 1,539 lines and 254,261 characters — a knowledge base
the agent has been writing into: 81 headings, from editor chrome to physics to
level export, plus three full source files pasted in (`ui.ts` 20,003 characters,
`export.ts` 16,028, `world.ts` 17,318). It is **97.8% of the chat's opening
prompt**, and the chat is one question long: the conversation is 49 tokens.

Three things follow from that, which is why the number does not go away on its
own:

- **It is spent again on every turn.** The prompt is rebuilt for each request, so
  a chat at 33% pays 64k tokens each time, whatever it says.
- **Compaction cannot recover it.** pi's compaction summarises the conversation;
  the prompt is not in what it takes out, and its own estimate excludes it from
  the room a summary may use. Nothing a chat does with its history frees that.
- **It grows.** The agent writes what it learns into the file — that is what the
  portal tells it to do — and pi's `loadProjectContextFiles` reads each file
  whole with no size limit, and the portal handed whatever it read straight into
  the system prompt. A project that keeps working eventually opens no chat at all
  in one window: 64k tokens of prompt against a 64k model leaves nothing for a
  conversation, and against this 204,800-token model it is a third gone before
  the first question.

## What was changed

The portal now holds **each context file** to a cap, and says what it left out.

- `core/server/src/pi/context-budget.ts` — the cap, its setting, and the cut. A
  file over the cap is read to a line boundary, and a note is left in its place
  naming the size of the whole, the line the reading stopped at, and the headings
  past it, with the hint to `read` what it needs. The file on disk is untouched;
  a chat that wants a section reads it, which is what the note is for. A file
  that is one enormous line is cut mid-line rather than at its header, so the
  room the cap allows is kept rather than lost.
- `core/server/src/pi/sdk-client.ts` — the hold is applied where the portal hands
  pi its context files, and the breakdown of a chat's context is read back out of
  pi's built prompt.
- `core/server/src/pi/builtins.ts` — **`/context`**, which says where a chat's
  context goes: the prompt section by section, the files inside it with what each
  was held to, the tools declared to the model, and the conversation.
- `core/server/src/session-manager.ts` — one line in the chat, at the moment its
  pi read the file, naming what was left out and the room it saved. Said once per
  chat, and again only where what was left out changed.
- `core/server/src/server.ts` — `GET /api/sessions/:id/context` and
  `PUT /api/context-cap`; `GET /api/settings` carries `contextCap`. Changing the
  number reloads the open chats, and one that is working takes it at its next
  step.
- The pages: **Where it goes** on the context card, and **Each context file** in
  Settings → Defaults, found by the settings search.
- Docs: `/context` under commands, *What a chat starts with* under sessions, the
  field under models' defaults, and both routes in the API reference.

### Effect, on the chat this was measured on

| | Before | After (cap 12,000) |
| --- | --- | --- |
| `AGENTS.md` handed to the model | 63,566 tokens | 12,233 tokens, lines 1–601 of 1,539 |
| opening prompt | 64,951 tokens | 13,619 tokens |
| share of the 204,800-token window | **31.7%** | **6.6%** |

What the chat keeps is the top of the file — the overview, the structure, the
commands — and the names of the 60 headings past where it stopped, 16 of them
listed in the prompt and 44 said to exist. What it no longer carries is the tail of the
knowledge base, which it can read when a task asks for it.

### The number

12,000 tokens per file, the portal's own, in Settings → Defaults — `0` reads
whole files, and an empty field goes back to 12,000. It is 6% of a 200k window
and 19% of a 64k one; pi leaves 20,000 tokens of a conversation untouched when it
compacts, so anything past that is not instructions a chat can follow, it is a
library it happens to be sitting beside.

## Other ways this could be taken down, and why they were not the one

- **Split the project's file** (`AGENTS.md` overview + sections it reads, with the
  pasted source files moved out). It is the real fix for BlastRunHero and every
  project whose agent writes whole files into its knowledge base, and it belongs
  to that project, not to the portal. The portal's hold is what stops the same
  thing happening to a project nobody stops to tidy.
- **Trim the portal's own sections.** `skills` is 668 tokens, `docs` 314, `rules`
  182 — together 1.2% of the window. Not where the 31% came from.
- **The tool declarations**, ~3,480 tokens over pi's own estimate. They are pi's,
  and the portal already switches tools off per chat; nothing to change here.
- **A larger window for the model**, or the portal's window default lowered. Both
  only move the percentage: the prompt is still 64k tokens on every turn.
- **Compaction tuning.** Irrelevant to this: compaction takes out the conversation
  and cannot touch the prompt.

## Checked

- `core/server/test/context-cap.test.mjs` — the cap's setting and its bounds, the
  cut at a line, the note's contents, one enormous line, the notice, a chat that
  has answered nothing reporting what its prompt carries, and a real chat whose
  prompt carries the top of the file and the map of the rest but not the rest,
  read back through `/context`. 10 tests, passing.
- `tests/context-window.test.mts` — the field's parser, including `0` as whole
  files and the portal's bounds.
- The portal's German (`core/web/src/locales/de.ts`) has every text added; the
  two failures in `tests/i18n.test.mts` are already there on this branch — entries
  for `TaskWorkspace.tsx`, `App.tsx` and `settings-search.ts` keys predating this
  change, and the terminal extension's — and the list is identical with and
  without the change apart from the line numbers those same keys moved to.
- The rest is as the machine leaves it: `context-file-links.test.mjs` fails on
  symlink rights here, as it does without the change; `check:boundaries`, the web
  build and the root tests named above pass.
