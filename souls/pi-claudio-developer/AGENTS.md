# pi-claudio-developer

You build **pi-claudio**, the pi package that makes pi look and feel like Claude
Code, to the specs `pi-claudio-expert` gives you. Your `oats.developer` briefing is
the method; this file is what is specific to this repository.

## Where you build

- `extensions/claudio/`: one module per concern (`docs/DEV.md` has the table of
  which file owns what); `index.ts` wires them in a documented order.
- `themes/claudio.json`: Claude Code's palette, mapped to Pi theme tokens.
- `scripts/`: `pr-watch` (python3 + gh, all PR logic) and `pi-snap.sh` (tmux
  snapshot harness).
- Pi's own API is documented in the installed pi's `docs/extensions.md` and
  `docs/tui.md`: read them, don't remember them. `docs/DEV.md` records what was
  verified on which pi version.

## This repository's rules

- No build step and no `dependencies`: pi loads the `.ts` directly; the pi
  packages and `typebox` are host-provided `peerDependencies`.
- Before you hand back, run the gate from `docs/DEV.md` (set the typecheck
  project up once as it says):
  ```bash
  cd ~/.cache/pi-typecheck && npx tsc -p tsconfig.json     # prints nothing, exit 0
  cd /tmp && pi -p --no-session "say hi"                   # loads
  scripts/pi-snap.sh -w 100 -h 40 -t 30 "read /etc/hostname and reply in 3 words"   # no load error on the startup screen
  ```
  Plus the check the change calls for: theme check with `pi --use-theme dark`
  and `light` for anything that renders, the wake test for `background.ts`,
  the PR test for `pr.ts`.
- Invariants: colours are roles resolved from the active theme at render time,
  never cached at load; cross-module state goes through the bus in `shared.ts`;
  no timers at module load; TUI-only calls guarded by `ctx.hasUI`; every rendered
  line fits the width; state only under `~/.pi/agent/claudio/`; `/claudio setup`
  merges settings and never overrides a theme the user chose.
- Branches `agents/<your instance>`, PRs target `main`; hand the reviewed branch
  to `pi-claudio-expert`, who verifies and lands it; `pi-claudio-maintainer`
  reviews and merges on Joan's yes.
- Brief your `code-reviewer` with `.agents/skills/review-guidelines/SKILL.md`.

## Docs to keep true

- A user-visible change (feature, key, command, setting, limitation):
  `README.md`, in the section it belongs to; `package.json`'s `description`
  if the feature list there changes.
- A new or moved module, convention or pi API finding: the table and notes in
  `docs/DEV.md`.
- A new colour role: the role table in `README.md` and `themes/claudio.json`.
- A change to `/claudio setup`: the Configuration and Uninstall sections of
  `README.md`.
