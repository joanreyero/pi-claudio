# Contributing to pi-claudio

## Set up and test

There is no build step: pi loads the `.ts` files directly. Try a checkout
without installing with `pi -e /path/to/pi-claudio`. Before opening a pull
request run the checks in [docs/DEV.md](docs/DEV.md): the typecheck project
(`npx tsc -p tsconfig.json` must print nothing), the load smoke test
(`pi -p --no-session "say hi"`) and the tmux snapshot (`scripts/pi-snap.sh`),
plus the theme, wake or PR test a change calls for. Keep `README.md` and
`docs/DEV.md` in step with the code.

## Reviews

Every pull request is reviewed against
[`.agents/skills/review-guidelines/SKILL.md`](.agents/skills/review-guidelines/SKILL.md):
what every change keeps true, the test gate, the consumers to read. You can run
the same review yourself before opening a PR by loading that skill in pi, Claude
Code or Codex from a checkout, or just by reading it. The maintainer posts a
verdict on the PR; merges are squash merges by the maintainer.
