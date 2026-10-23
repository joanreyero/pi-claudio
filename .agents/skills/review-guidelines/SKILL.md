---
name: review-guidelines
description: How a change to pi-claudio is reviewed. Load it to review a pull request to this repository, to self-review before opening one, or to write a change that will pass review. This is the project's part of the review; the method (direction, correctness, security, mergeability; adversarial, security and simplification passes) is the reviewer's own.
---

# Reviewing a change to pi-claudio

pi-claudio is a pi package that makes pi look and feel like Claude Code: one
extension (`extensions/claudio/`, one module per concern), a theme
(`themes/claudio.json`) and two scripts (`scripts/pr-watch`, `scripts/pi-snap.sh`).
There is no build step: pi loads the TypeScript directly, so what is merged is
what every user runs after `pi update`. A change usually touches one module,
the docs that describe it, and sometimes the theme or `/claudio setup`.

## What every change keeps true

- **It reproduces Claude Code.** A new or changed surface matches Claude Code's
  shape and wording; a deliberate difference is named in the PR. Nothing is
  added that Claude Code does not have without a reason.
- **No build step, no `dependencies`.** `@earendil-works/pi-*` and `typebox`
  stay `peerDependencies`; nothing else is imported except node builtins. No
  `node_modules` inside the package.
- **One module per concern** (the table in `docs/DEV.md`), each exporting
  `setupXxx(pi)`; per-module state stays module-local; cross-module state goes
  through the bus in `shared.ts`; `index.ts`'s setup order and its comment
  agree with the change.
- **Colours are roles, not values.** Every colour goes through `shared.ts`
  (`fg(...)`, `FG`/`BG`) or a `Theme` in hand, resolved at render time, never
  cached at module load. A new role is added to `ROLE_SOURCE`, to
  `themes/claudio.json` and to the role table in the README.
- **TUI discipline.** TUI-only calls are guarded (`ctx.hasUI` /
  `ctx.mode === "tui"`); no timers start at module load (start in
  `session_start`/`agent_start`, clear in `agent_end`/`session_shutdown`); every
  rendered line fits the width (`truncateToWidth`, `visibleWidth`,
  `wrapTextWithAnsi`); console output never lands in the prompt box.
- **State lives in `~/.pi/agent/claudio/`**, never in the package directory;
  background logs under `$TMPDIR/pi-claudio/`.
- **`/claudio setup` merges.** It adds its keys and keeps the user's others,
  sets `theme` only when unset, and `/claudio status` reports what it applied.
  Uninstall instructions in the README still undo everything it writes.
- **The permission gate stays safe by default.** A command is "safe" only when
  every piece of it is an allowlisted read-only command with no redirect or
  substitution; MCP tools without `readOnlyHint` stay destructive; auto-accepted
  edits stay inside the working directories.
- **Docs move with the code.** `README.md` for anything a user sees, `docs/DEV.md`
  for modules, conventions and verified pi API facts (with the pi version).

## The test gate

There is no CI and no test suite. The reviewer runs what `docs/DEV.md` documents,
from the checkout under review (the typecheck project is set up once as that
file says, with its `include` pointing at the checkout):

```bash
cd ~/.cache/pi-typecheck && npx tsc -p tsconfig.json     # must print nothing and exit 0
cd /tmp && pi -p --no-session "say hi"                   # the extension loads
scripts/pi-snap.sh -w 100 -h 40 -t 30 "read /etc/hostname and reply in 3 words"   # no load error on the startup screen
```

And, depending on the change: the theme check (`pi --use-theme dark` and
`light`) for anything that renders, the wake test for `background.ts`, the PR
test (or a dry run of `scripts/pr-watch`) for `pr.ts`. A check that cannot run
from the reviewer's machine is stated as not checked, never assumed.

## Consumers to read

- `README.md`: features, Configuration, Permission modes, Themes (the role
  table), Known limitations and Uninstall are promises to users; a change to
  behaviour, a key, a setting or a limitation changes the matching section.
- `docs/DEV.md`: the module table, conventions and pi API notes.
- `setup.ts` and the README's Configuration section when a setting, keybinding
  or the workflow package changes; the Uninstall section must still reverse it.
- `themes/claudio.json` and `shared.ts`'s `ROLE_SOURCE` when a colour role
  changes; the bundled theme must still produce Claude Code's colours.
- `scripts/pr-watch` and `pr.ts` together: the script holds all PR logic, the
  extension only starts it and renders.
- `tools.ts` when a tool is added or renamed: it must get a renderer, and the
  `agents.ts` tool-name map if Claude Code has an equivalent.
- pi-extensible-workflows: `workflows.ts` and `agents.ts` depend on its events
  and registry; `docs/workflows-eval.md` records why that package.

## Out of scope for a review here

- Pi's own limits, listed under "Known limitations" in the README and in
  `docs/DEV.md`: not findings unless the change claims to fix them.
- A user's local pi configuration, themes or packages beyond what
  `/claudio setup` writes.
- The behaviour of pi-extensible-workflows, herdr or gh themselves; a change
  here is reviewed for how it uses them.
