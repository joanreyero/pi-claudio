# Workflow packages for pi-claudio: pi-extensible-workflows vs pi-ultracode

Evaluated 2026-10-19 on Pi 1.3.0 (model `github-copilot/claude-fable-5.1:medium`, cwd `~/Work/pi-claudio`; the package was still called pi-ember at the time, paths below use the current name).
Candidates: **pi-extensible-workflows 6.2.2** (vekexasia, 247★) and **pi-ultracode 0.11.0** (ekil1100, 5★).
Both register a tool named `workflow`, so they were never loaded together: ultracode ran as
`pi --no-extensions -e …/ultracode.ts -e …/pi-claudio/extensions/claudio/index.ts --ultracode`, pi-extensible-workflows as plain `pi`.
Numbers come from `pi -p --mode json` event streams (main-agent usage) plus each package's own run accounting (children).

## Recommendation

**Keep shipping/recommending pi-extensible-workflows.** Do not install pi-ultracode.

- Both produced equally good T1 reviews (all spot-checked findings are real bugs), at the same cost (~$4.5–4.8) and wall time (~5 min).
- pi-extensible-workflows is the maintained, documented, widely used one (247★, 52 releases, 6 contributors, docs site, 8 bundled slash commands, subagents tools, Trajectory viewer, catalog functions). ultracode is a one-person project (5★, 50 commits by one author) with 16.7k lines of TS and a 65 MB dependency tree (`effect`, `js-beautify`).
- ultracode adds **~22 k characters (~5.5 k tokens) of policy prose to every system prompt** when enabled (33.9 k chars vs 11.8 k) — a permanent per-turn tax for depth/effort rules the model mostly ignored (it picked `:high` for all children anyway).
- ultracode's tool calls render as `● Task(…)` under pi-claudio (no `name` arg), its mode indicator is invisible in pi-claudio's footer, and its F6 browser is a fullscreen overlay that bleeds the underlying conversation at the edges. pi-extensible-workflows renders as `● Task(claudio-bug-review)` with a live `├ review X · running` tree and an inline, non-fullscreen `/workflow` browser.
- Nothing in ultracode is worth borrowing as code. The *idea* of depth modes is sensible, but it's a prompt — see "Ideas worth borrowing" at the end.

Caveat for pi-extensible-workflows: the first `workflow` launch failed in **3 of 3** attempts (model misuses the script API: unavailable tool `grep`, unavailable tool `workflow_result`, `parallel` values not functions). It always self-recovered within one turn (+~10–30 s, +$0.05), but it is the single biggest UX wart.

## Comparison table

| | pi-extensible-workflows 6.2.2 | pi-ultracode 0.11.0 |
|---|---|---|
| **Repo / stars / forks / open issues** | vekexasia, 247★, 28 forks, 18 issues | ekil1100, 5★, 4 forks, 1 issue |
| **Bus factor** | 6 contributors (863 + 14 + 3 + 2 + 2 commits) | 1 contributor (50 commits) |
| **Releases** | 52 versions since 2026-07-17; last 6.2.2 on 2026-10-14; ~2/week in Oct | 21 versions since 2026-07-14; last 0.11.0 on 2026-10-13 |
| **Pi version floor** | current Pi (uses `createLocalPiSession`, extension hooks) | Pi ≥ 0.99.1 (peers `>=0.99.1`); **no deprecation warnings on 1.3.0**; `--ultracode` flag via `registerFlag` works |
| **Install footprint** | 7.8 MB in `~/.pi/agent/npm` (deps: `acorn`, `minimatch` only) | +64 MB (deps: `effect` ^4, `acorn`, `js-beautify`; 20 packages). `pi install npm:pi-ultracode` works in 1.3 s (devEngines pin to npm 11.19.0 is not enforced for a dependency; it *does* block a plain `npm i` inside the package) |
| **Code size** | 19.6 k lines TS (core + starter + subagents + trajectory), shipped as `dist/` ESM | 16.7 k lines TS loaded as source (`extensions/ultracode.ts` → `src/`) |
| **System-prompt cost when active** | +~1.3 k chars (tool description line) + 168-line skill loaded on demand | **+22 k chars every turn** (`rules` grows 1.5 k→13 k, plus `ultracode` 8.7 k and `ultracode_effort` 4.3 k sections) |
| **API: fan-out** | `parallel(name, {key: () => …})`, `pipeline(name, items, stages)`, `agent()`, `agent.create()` persistent handles, `prompt()` interpolation, `phase()`, `log()`, `shell()`, `tools.<name>()`, `evidence()`, `withWorktree()` | `parallel([thunks])`, `pipeline(items, …stages)`, `agent()`, nested `workflow(name)`, `phase()`, `log()`, `args`, `cwd`. No shell, no direct tool calls, no persistent handles, no prompt helper |
| **Worktrees** | `withWorktree(name, cb)` named scopes, shared or per-branch | `isolation: "worktree"` per agent; patch-based integration, conflicts saved for manual recovery |
| **Structured output** | `outputSchema` on any agent; one repair prompt | `schema` (bounded JSON-Schema subset, 2 MiB cap) |
| **Budgets** | `tokens / costUsd / durationMs / agentLaunches` soft+hard; `budget_exhausted` → `workflow_resume` with approval flow | `maxAgents` admission cap only; "token and cost data are reported, not enforced" |
| **Retry / resume** | `workflow_retry` (replay journal into child run), `workflow_resume`, `agent({retries})`, `workflow_status`, `workflow_stop`, `workflow_respond` | `resumeFromRunId` (immutable script replay by structural identity); `/workflows abort`; no per-agent retries |
| **Subagent tools** | `subagents_run/inspect/steer/stop/retry` (durable, background) | none (relies on `pi-subagents` coexisting) |
| **Catalog / reusable functions** | `workflow_catalog`, registered functions (`reviewLoop` bundled), `scriptPath`, model aliases, extension template | saved `*.workflow.js` in `.pi/ultracode/workflows` or `~/.pi/ultracode/workflows`; one example |
| **Prompt templates** | `/scout /parallel-scout /oracle /council /review /parallel-review /review-loop /deep-research` | none |
| **Depth / effort policy** | none (model decides; skill says "use ordinary tools for work one agent can finish") | `/ultracode auto\|focused\|standard\|deep\|off\|status`, child-effort suffix heuristics, optional Jev classifier |
| **Observability** | `/workflow` picker (inline), background widget box above footer, Trajectory browser UI (local WebSocket server), follow-up `[workflow]` messages | `/workflows` + **F6** fullscreen overlay with runs list, per-agent transcript, usage, effort; `~/.pi/ultracode-runs/*` journals |
| **Security / network** | No external calls. Spawns a **detached Trajectory server on 127.0.0.1:7432** that outlives Pi (one was 12 h old). Optional explicit share via `gh gist create`. | No `fetch`/`http` in source. Default effort selector is `typesafe/jev-latest`; it is only used if Pi has the `typesafe` provider configured (`getAvailableOfType("classifier","typesafe")`). This machine has no typesafe model/credential → **no request was made, nothing left the machine**. If you *did* have a TYPESAFE key, child prompts + workflow meta/args would go to api.typesafe.ai. No telemetry. |
| **State left behind** | child sessions written flat into `~/.pi/agent/sessions/` (3–4 files per run); `~/.pi/workflows/projects/<proj>/…` | `~/.pi/ultracode-runs/<proj>/<session>/…` (288 KB for one run) |
| **pi-claudio rendering** | `● Task(claudio-bug-review)` with live `├ label · running` tree, `Done`/`Workflow cancelled`; `/workflow` browser is inline and respects the footer | `● Task(…)` (no `name` arg → fallback), tree without `· running` (ultracode uses `status` not `state`); footer mode pill not shown (pi-claudio's footer doesn't render `ctx.ui.setStatus`); F6 overlay bleeds edges |
| **Docs** | docs site (developers, subagents, Herdr, roles, extensions), 168-line SKILL.md loaded by the model, CHANGELOG | long README (EN + zh-CN), `types/workflow.d.ts`; very prose-heavy, policy-focused |

## Measured numbers

### T1 — "workflow with 3 parallel agents, review background.ts / permissions.ts / rewind.ts, top 5 with file:line"

| | pi-extensible-workflows | pi-ultracode (auto) |
|---|---|---|
| Wall time (whole `pi -p` run) | **312.5 s** (incl. failed 1st launch + skill read) | **299.5 s** |
| Workflow run duration | 262 s (4 agents: 3 reviewers ~226–240 s each, summariser 21 s) | 257 s (3 reviewers 168 / 213 / 257 s; parent synthesised) |
| Truly parallel? | yes — 3 reviewers started within 20 ms | yes — 3 reviewers started within 21 ms |
| Main-agent turns / tool calls | 5 turns, 5 calls (read skill, ls, catalog, workflow ✗, workflow ✓) | 4 turns, 3 calls (ls, workflow ✓, sed spot-check) |
| Main-agent tokens / cost | 81.5 k ctx tokens (69 k cache read), $0.32 | 81.9 k ctx tokens (56 k cache read), $0.44 |
| Children cost | $1.44 + $1.38 + $1.47 + $0.21 = **$4.51** (~1.57 M tokens incl. cache reads) | $1.19 + $1.30 + $1.58 = **$4.07** (~1.6 M tokens incl. cache reads) |
| **Total cost** | **$4.83** | **$4.51** |
| Child model/effort | inherited `claude-fable-5.1:medium` | parent chose `:high` for all three (despite 13 k chars of "don't over-escalate" rules) |
| Errors / retries | 1st launch failed: *"The workflow requested the unavailable tool grep"* → model fixed selector, relaunched. 0 agent retries. | none |
| Hangs | none | none |
| Repo modified? | no (`git status` clean) | no (`git status` clean) |

Result quality — spot-checked against source, all real:

| Finding | wf | uc | Verified |
|---|---|---|---|
| `permissions.ts:100` `isSafeCommand` splits on `\|\|`,`\|`,`&&`,`;`,`\n` but not single `&`; `<(…)` not rejected → `ls & rm -rf ~` is "safe" | #2 | #1 | ✅ regex at L96/L100 |
| `permissions.ts:628-629` "don't ask again" prefix (`commandPrefix` = first word) approves any later compound command starting with that word | #1 | #4 | ✅ L122-128, L628-629 |
| `permissions.ts:83` `SAFE_COMMANDS` contains `env`, `find`(-exec/-delete), `fd`(-x), `awk`(system), `sort -o`; `git branch -D`/`tag -d`/`remote remove` "safe" | #3 | #2 | ✅ |
| `rewind.ts:419-434` "both": `restoreFiles` runs before cancellable `navigateTree`, `dropTurns` unconditional → cancelled rewind still resets files and deletes checkpoints | #4 | (idle-race variant, #5) | ✅ |
| `background.ts:210` wake-log `createWriteStream` has no `error` listener → ENOSPC crashes Pi | #5 | mention | ✅ |
| `background.ts:622` ctrl+b snapshot replaces `output` without rebasing `readOffset` (unlike `appendOutput` L170-174) → `bash_output` returns empty forever after truncation | — | #3 | ✅ **uc-only, genuinely subtle** |

Both lists are high quality; ultracode's structured-output schema (`line/severity/title/evidence`) + parent synthesis produced one extra subtle finding, pi-extensible-workflows' 4th "summarize" agent produced better-ranked, more actionable prose. Not a meaningful difference.

### T2 — "What does scripts/pr-watch print when CI fails? Answer in 3 lines."

| | pi-extensible-workflows | pi-ultracode (auto) |
|---|---|---|
| Wall | 10.3 s | 9.6 s |
| Turns / tool calls | 2 / 1 (`bash` grep) | 2 / 1 (`bash` grep) |
| Over-orchestration? | **no** — no workflow/subagent | **no** — no workflow |
| Context tokens | 22.4 k | 32.8 k (+10 k from ultracode prompt sections) |
| Cost (warm cache) | $0.041 | $0.035 (first cold run $0.233 because of a 16.9 k cache write) |
| Answer | correct (CHECKS line, CHECK_FAILED + `\| ` log tail, DONE ci failed) | correct, same content |

Neither package makes the main agent over-orchestrate on a trivial task. pi-extensible-workflows' SKILL.md says "Use ordinary tools for work one agent can finish"; ultracode says the same at ten times the length.

## T3 — TUI under pi-claudio (120×45 tmux)

### pi-extensible-workflows, T1 in flight

```
● Task(catalog)
  ⎿  Done

● Task(claudio-bug-review)
  ⎿  The workflow requested the unavailable tool workflow_result.

● workflow_result is injected automatically; I'll drop it from the selector.

● Task(claudio-bug-review)
  ⎿  ├ review background.ts · running
     ├ review permissions.ts · running
     ├ review rewind.ts · running
     └ Running…

· Puttering… (49s · ↓ 3.2k tokens · thinking)
────────────────────────────────────────────────────────────────────────
> Try "edit LICENSE to..."
────────────────────────────────────────────────────────────────────────
  esc to interrupt        ↑10 ↓2.4k $0.345 1.8%/1m · ⏵⏵ bypass permissions on (shift+tab to cycle)
```

Esc → `⎿  Workflow cancelled` + `Error: The operation was aborted.` within ~1 s; run is marked `stopped`. `/workflow` afterwards:

```
 Workflows

 → ✗ claudio-bug-review  stopped  review  3/3 agents $0.88 runtime=52s
   Model aliases
   Close
```

Background launch (`foreground: false`) shows the package's own widget **between the prompt box and the footer** — no overlap with pi-claudio's chrome, and completion arrives as a `[workflow]` follow-up:

```
> Try "fix lint errors"
────────────────────────────────────────────────────────────────────────
╭ Workflow ────────────────────────────────────────────────────────────╮
│ ⣯ [running] hello-bg                              366t · $0.20 · 00:09 │
│   ╰─ ⣯ unphased                                           366t · $0.20 │
│     ├─ ✓ claude-fable-5.1          claude-fable-5.1:medium · 173t · $0.10 · 00:06 │
│     ╰─ ⣯ claude-fable-5.1          claude-fable-5.1:medium · 193t · $0.10 · 00:09 │
╰──────────────────────────────────────────────────────────────────────╯
  ? for shortcuts      ↑18 ↓1.3k $0.114 1.3%/1m · ⏵⏵ bypass permissions on
…
✓ hello-bg 565t · $0.22 · 00:13 · completed
[workflow]
Workflow hello-bg completed: {"agentA":"36…","agentB":"36…"}
```

`/workflow` → run → tree view is inline (not fullscreen) with run actions (open script, delete, copy path/ID):

```
Tree                                       | Selected workflow: hello-bg
→ ▾ Workflow · ✓                           | Run ID: 8b927c89-…
  ▾ Unassigned · ✓                         | Status: completed
    ▾ count-lines · ✓                      | agents completed=2 running=0 failed=0
      ▾ a · ✓                              | Run actions
        • claude-fable-5.1 · ✓             | → Open script in editor
```

Warts: agent nodes show the model name when no `label` is given; child sessions land in `~/.pi/agent/sessions/` root; the `/workflow` picker in a fresh `--no-session` session shows no runs (runs are per session); typing `/workflows` (plural) autocompletes to the *skill* and queues a steering message — pi-claudio's slash menu prefers `skill:pi-extensible-workflows` over the `/workflow` command.

### pi-ultracode, T1 in flight

```
● Files are present. Running the workflow: three independent reviewers, one file each,
with structured output so I can merge deterministically.

● Task(…)
  ⎿  ├ review background.ts
     ├ review permissions.ts
     ├ review rewind.ts
     └ Running…

· Crafting… (49s · ↓ 1.2k tokens · running tool for 30s)
────────────────────────────────────────────────────────────────────────
> Try "write a test for LICENSE"
────────────────────────────────────────────────────────────────────────
  esc to interrupt         ↑6 ↓1.2k $0.076 1.8%/1m · ⏵⏵ bypass permissions on (shift+tab to cycle)
```

- `Task(…)`: ultracode's `workflow` call has no `name`/`description` arg (the name lives in `export const meta` inside `script`), so pi-claudio's `taskLabel` falls back to `…`. Fixable in `tools.ts` by regex-extracting `meta.name` from `script`, but only if we adopted it.
- Agent rows lack `· running` because ultracode's agents expose `status` (pi-claudio reads `state`).
- Footer: ultracode calls `ctx.ui.setStatus("ultracode", …)`; pi-claudio's `ClaudioFooter` doesn't render extension statuses, so the configured mode is invisible (only `/ultracode status` tells you: `ultracode · auto — Adaptive depth…`).

F6 / `/workflows` opens a **fullscreen overlay** (left: runs/agents with model·effort·turns; right: live child transcript with code it is reading). Rich, but the conversation bleeds at both edges and the pi-claudio footer is covered:

```
> Us│─ Review files ─                      │cache read 161k · cache write 38k                │ugs
(one│  ● #1 review background.ts           │options: requested claude-fable-5.1 • high · structured output
    │  claude-fable-5.1 • high · 1t · 1u ·…│running · current: turn 10 streaming
    │  ● #2 review permissions.ts          │
✻ Th│  claude-fable-5.1 • high · 1t · 1u ·…│                  summaryDetails = extensionSummary.details;
    │> ● #3 review rewind.ts               │── Turn 9 ────────
● Ba│  claude-fable-5.1 • high · 9t · 9u ·…│✓ bash: command · <1s                             │mb…)
  Ch│Esc runs/close                        │  oldLeafId,
…
    │                                      │↑↓/PgUp/Dn scroll · End follow · p prompt · Tab tasks · Esc back
    ╰──────────────────────────────────────┴───────────────────────────────────────────────────╯
```

Esc inside the overlay goes "back" first (two Escs to close). Esc on the main screen aborts cleanly:

```
● Task(…)
  ⎿  Workflow ember_file_review was aborted (runId: wf_mvf72p0e-1-aa3e33b9383c)

 Warning: Workflow ember_file_review was aborted

Error: The operation was aborted.
```

`/workflows` in a fresh session: `No workflow runs in this session yet.` (runs are per session here too, despite the on-disk journal).

## Other observations

- **Ultracode's Jev classifier without credentials**: `src/jev.ts` only calls `runtime.classify` after `getAvailableOfType("classifier", "typesafe")` returns the model; `pi --list-models typesafe` → "No models matching", so the selector silently fell back to the parent-chosen suffix. Verified no network code in `src/` (`fetch`/`http`/`net`/`WebSocket` absent). The risk is only for users who *do* have a `TYPESAFE_API_KEY` in Pi: then every batch of child prompts (full task text, workflow meta, args) is sent to api.typesafe.ai by default — opt-out, not opt-in. That alone is a reason not to recommend it by default.
- **Ultracode's `workflow` tool is `model-only` exposure and hidden unless a mode is on** (`/ultracode` or `--ultracode`); off by default after install — users would have to learn the switch.
- **pi-extensible-workflows' Trajectory server** is a long-lived background `node` process on loopback (`127.0.0.1:7432`, lock in `~/.pi/agent/pi-extensible-workflows/`). Harmless but worth knowing; `pi config` can disable `dist/trajectory/index.js` if unwanted.
- **Robustness**: pi-extensible-workflows' first-launch failure rate was 3/3 in this session (tool selector typos, `parallel` value shape). Causes are model-side misreads of the skill, and the error messages are precise enough that the model self-corrects. Worth an upstream issue suggesting the launch validator accept `grep/find/ls` as harmless unknowns or that the skill call out "never list `workflow_result` in `tools`".
- Neither package touched the repo in any run (`git status` clean after each).

## Ideas worth borrowing from ultracode (as prompt/skill text, not code)

1. **Depth modes as a one-paragraph rubric** — `focused / standard / deep` defined by *what evidence is required*, not by agent count. Ultracode's version is 22 k chars; the useful core is ~8 lines: *"Pick the smallest depth that lets you verify the key claim: focused = check it directly yourself; standard = independent dimensions or competing hypotheses → fan out and verify disputed claims; deep = interacting invariants → independent evidence + counterexample. Risk keywords and file counts don't raise depth; missing evidence does."* This would fit as a short section in a pi-claudio prompt template (e.g. `/review` wrapper) or AGENTS.md, and costs nothing per turn.
2. **`log('analysis-depth: <level> — <reason>')` before launching agents** — a cheap, auditable habit that shows up in the Task tree. Could be a one-liner in the workflow skill guidance.
3. **Structured reviewer output** (`line / severity / title / evidence` schema) + parent-side synthesis instead of a 4th summariser agent — ultracode did this by default and saved ~$0.20 and 20 s. pi-extensible-workflows supports `outputSchema` already; a `/review` prompt template could prescribe it.
4. **Per-child effort suffix** (`model: ':high'`) — pi-extensible-workflows already supports `alias[:thinking]`; worth mentioning in a skill so reviewers get `:high` while mechanical children stay `:low`.

Not worth borrowing: the Jev classifier, the `effect`-based runtime, the fullscreen overlay, the 13 k-char rule block.

## Housekeeping (state after this eval)

- `pi list` → `npm:pi-extensible-workflows`, `git:github.com/joanreyero/pi-claudio` only; pi-ultracode was installed for 1 s to measure footprint and removed; `~/.pi/agent/npm` reinstalled with `npm install --omit=dev --omit=peer` (same 5 packages, 7.8 MB).
- Removed eval artefacts: `~/.pi/ultracode-runs/`, `~/.pi/workflows/projects/pi-claudio-2fa541081645/`, the 9 child session files these runs wrote to `~/.pi/agent/sessions/`.
- `git status` in pi-claudio: only `docs/workflows-eval.md` new. Raw logs: `/tmp/ultracode-eval/{runs,tui}/`.
