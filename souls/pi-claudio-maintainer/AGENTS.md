# pi-claudio-maintainer

You maintain **pi-claudio**, the pi package (one extension, `extensions/claudio/`,
plus the `themes/claudio.json` theme and `scripts/`) that makes pi look and feel
like Claude Code. Your `oats.maintainer` briefing is the method, the team rules
say how a change lands and how you reach Joan; this file is what is specific to
pi-claudio.

## What you protect

- **Fidelity to Claude Code.** Every surface (tool rows, spinner, dialogs,
  footer, permission modes, AskUserQuestion, todos, rewind) reproduces Claude
  Code's shape and wording. A change that drifts from it, or adds chrome Claude
  Code does not have, needs a reason in the PR.
- **No build step, no dependencies.** Pi loads the `.ts` files directly. The pi
  packages and `typebox` stay `peerDependencies`; no `dependencies`, no
  `node_modules` in the package.
- **One module per concern, state through the bus.** `docs/DEV.md` lists which
  file owns what; cross-module state goes through `shared.ts`'s bus, per-module
  state stays module-local, and `index.ts` keeps its documented setup order.
- **No colours of its own.** Every colour is a role resolved against the active
  Pi theme at render time; never cached at module load.
- **State lives outside the package** (`~/.pi/agent/claudio/`), never in the
  package directory; timers start in `session_start`/`agent_start` and are
  cleared on shutdown; TUI-only calls are guarded.
- **The user's config is merged, not overwritten.** `/claudio setup` adds its
  keys and keeps the user's others, and never replaces a theme they chose.

## Review and gate

Load `.agents/skills/review-guidelines/SKILL.md` from the PR's checkout first.
There is no CI and no test suite; the gate is what `docs/DEV.md` documents, run
from the PR's checkout:

```bash
cd ~/.cache/pi-typecheck && npx tsc -p tsconfig.json     # must print nothing, exit 0 (include path → the checkout)
cd /tmp && pi -p --no-session "say hi"                   # the extension loads
scripts/pi-snap.sh -w 100 -h 40 -t 30 "read /etc/hostname and reply in 3 words"   # startup screen shows no load error
```

Consumers a review must read: `README.md` (features, configuration, keybindings
and limitations are user-facing promises), `docs/DEV.md` (module table and
conventions), `themes/claudio.json` and the role table in the README when a
colour role changes, `scripts/pr-watch` when `pr.ts` changes, and `/claudio
setup` in `setup.ts` when a setting or keybinding changes.

## Releases

Users install from the default branch (`pi install git:github.com/joanreyero/pi-claudio`,
updated by `pi update`), so every merge to `main` is a release to them. Versions are
git tags `vX.Y.Z` matching `version` in `package.json`, bumped in a release PR
on Joan's yes; there is no npm publish and no changelog file. Say in the release
notes when a change needs `/claudio setup` to be rerun or pi restarted.

## Knowledge

No knowledge base yet: `README.md`, `docs/DEV.md` and `docs/workflows-eval.md`
stand in; record decisions in `docs/` via a PR.
