# pi-claudio

*Claude Code's look and feel for [pi](https://pi.dev).*

pi-claudio is a Pi package that reskins the interactive TUI with a look and feel inspired by Claude Code: `●` tool rows with `⎿` result previews, a whimsical spinner, a permission-mode pill in the footer, background shell tasks, a todo checklist, Esc Esc rewind with file checkpoints, and Claude Code-style multi-agent workflows (via [pi-extensible-workflows](#workflows)). No build step: Pi loads the TypeScript directly.

```
✻ pi v1.3.0
  Claude Fable 5.1 · GitHub Copilot
  ~/Work

  Tip: Press esc twice to rewind to a previous message

> read /etc/hostname and reply in 3 words

● Read(/etc/hostname)
  ⎿  Read 1 line (ctrl+o to expand)

● Hostname is falcon.

────────────────────────────────────────────────────────────────────────────────
> Try "how do I log an error?"
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts          ↑6 ↓62 $0.064 1.1%/1m · ⏵⏵ bypass permissions on (shift+tab to cycle)
```

While the model works:

```
● Bash(npm test)
  ⎿  Running… 4s
     (ctrl+b to run in background)

✶ Percolating… (12s · ↓ 1.2k tokens · running tool for 4s)
────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────
  esc to interrupt                                   ⏵⏵ bypass permissions on (shift+tab to cycle)
```

## Features

- **`●` tool rows** for every tool: `● Read(src/foo.ts)`, `● Bash(ls)`, `● Update(file)` with a coloured diff, `● Write`, `● Search`, `● List`, `● Task` (pi-extensible-workflows), and a generic fallback for custom and MCP tools. Bullet is orange while running, green on success, red on error. Results sit under `  ⎿  ` with a 3-line preview and `… +N lines (ctrl+o to expand)`.
- **Spinner** with the famous gerund verbs (`✻ Noodling…`, `Percolating…`, …), eased frames, shimmer, elapsed time, token count and `running tool for Ns`. The terminal title flips `◐`/`◑` while working.
- **Permission modes**: `bypass permissions` (default) → `plan` cycled with **shift+tab**; `/permissions <mode>` and `/plan` also work. In `default`/`acceptEdits` modes a dialog asks before shell commands, edits, writes and destructive/MCP tools, with "don't ask again for `<prefix>` commands in `<cwd>`" remembered per project. Plan mode blocks mutating tools and tells the model why.
- **ctrl+o** expands/collapses all tool output.
- **Background tasks**: `bash` gains `run_in_background`; `bash_output` and `kill_shell` tools; **ctrl+b** moves the running foreground command to the background; `/tasks` (alias `/bashes`) opens the task list; `↓` on an empty prompt opens it too. The footer shows `N background tasks`.
- **Background commands that wake the agent**: `bash` with `wake: true` injects new output into the session as it arrives (batched, optionally regex-filtered) and on exit, triggering a turn — see [below](#background-commands-that-wake-the-agent).
- **PR watching**: `pr_watch` wakes the agent when CI finishes or fails, a review or comment lands, or the PR is merged; `pr_status` gives a snapshot — see [PR watching](#pr-watching).
- **`todo_write`** tool rendered as `● Update Todos` with a `☒`/`☐` checklist; the in-progress item's `activeForm` replaces the spinner verb.
- **Esc Esc rewind** (or `/rewind`): pick an earlier user message and restore the conversation, the code (from per-turn file checkpoints taken before every edit/write), or both.
- **`?`** on an empty prompt shows the shortcuts panel.
- **Footer** with the context hint, session tokens/cost, context usage, permission pill and background-task count.
- **Header** with `✻ pi vX`, model · provider, cwd and a tip.
- **MCP tool calls** render like any other tool: `● <server> · <tool>(args)` with the result preview (see [MCP](#mcp)).
- **Workflows**: `/claudio setup` installs [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows); its runs render as `● Task(name)` with a live agent tree — see [Workflows](#workflows).
- **Follows your Pi theme**: every colour (bullets, spinner, diffs, dialogs, footer pill) is resolved from the active Pi theme (`/settings` → Theme: `system`, `dark`, `light`, `light/dark` or a custom one), so pi-claudio works on light terminals too. The bundled **`claudio`** theme reproduces Claude Code's exact dark palette.

## Install

```bash
pi install git:github.com/joanreyero/pi-claudio
pi
```

Then, inside pi:

```
/claudio setup
```

`/claudio setup` merges the recommended settings and keybindings into your personal config (other keys are kept), sets the theme to `light/claudio` only if you have not chosen one yet (Pi's `light` theme on light terminals, the bundled Claude Code palette on dark ones), installs `npm:pi-extensible-workflows` if it is missing (see [Workflows](#workflows)) and asks you to restart or `/reload`. Until it has run, pi-claudio shows a one-line hint at startup.

`/claudio status` shows which of the recommended values are applied and whether the workflow package is installed.

## Configuration

`/claudio setup` writes:

`~/.pi/agent/settings.json`

```json
{
  "tuiMode": "regular",
  "outputPad": 0,
  "quietStartup": true,
  "hideThinkingBlock": true,
  "doubleEscapeAction": "none"
}
```

plus `"theme": "light/claudio"` when `theme` is not set yet (an existing choice such as `"dark"` or `"system"` is left alone).

- `tuiMode: regular` — scrollback-style transcript rather than fullscreen.
- `outputPad: 0` — the `●` sits in column 0.
- `quietStartup: true` — pi-claudio draws its own header.
- `hideThinkingBlock: true` — collapsed thinking shows as `✻ Thinking…`.
- `doubleEscapeAction: none` — frees Esc Esc for the rewind picker.

`~/.pi/agent/keybindings.json`

```json
{
  "app.interrupt": "escape",
  "app.tools.expand": "ctrl+o",
  "app.thinking.cycle": "alt+t"
}
```

`app.thinking.cycle` is moved to alt+t so shift+tab can cycle permission modes. If you also see a `ctrl+b` conflict warning with `tui.editor.cursorLeft`, add `"tui.editor.cursorLeft": ["left"]`.

Everything pi-claudio persists (permission allow-lists, file checkpoints) lives in `~/.pi/agent/claudio/`, never inside the package directory.

### Themes

pi-claudio has no colours of its own: each role in the UI maps to a token of the active Pi theme, so switching themes in `/settings` restyles the whole chrome immediately.

| pi-claudio role | Pi theme token |
|---|---|
| `●` running bullet, `✻` spinner and header, in-progress todo | `accent` (shimmer: `accent` mixed toward `text`) |
| `●` done / failed bullet, `✔` / `✕` | `success` / `error` |
| Permission, tasks and rewind dialogs, selected items | `borderAccent` |
| Footer pill: bypass / plan / accept edits | `error` / `mdLink` / `borderAccent` |
| Prompt box rules | `border` (dim); `bashMode` in `!` shell mode |
| Secondary and subtle text | `muted` / `borderMuted` |
| Diff rows and word highlights | `toolDiffAdded` / `toolDiffRemoved`, tinted toward the theme background (light or dark) |

The bundled `claudio` theme (`themes/claudio.json`) sets those tokens to Claude Code's colours. It is a **dark** theme (white text): on a light terminal use `system`, `light`, or the pair `light/claudio`, which Pi switches by terminal appearance. Copy the file to `~/.pi/agent/themes/` to tweak it (see Pi's `docs/themes.md`).

### Permission modes

| Mode | Behaviour |
|---|---|
| `bypassPermissions` (default) | Everything runs. Footer shows `⏵⏵ bypass permissions on`. |
| `plan` | Only read-only tools run; the model is told to present a plan. Footer shows `⏸ plan mode on`. |
| `default` | Ask before shell commands (except safe read-only ones), edits, writes, destructive/MCP tools. |
| `acceptEdits` | Like `default`, but edits/writes are auto-approved. |

shift+tab cycles `bypassPermissions ↔ plan`; `/permissions default` or `/permissions acceptEdits` selects the asking modes.

## Background commands that wake the agent

The `bash` tool takes `wake: true` (implies `run_in_background`). The command runs in the background and the agent is **woken** — a message is injected into the session and a turn starts — with each batch of new output lines and when the command exits. No polling, no `sleep` loops: the model starts the command, ends its turn, and acts when woken.

| `bash` param | Meaning |
|---|---|
| `wake` | Wake the agent on new output and on exit. |
| `wake_pattern` | Regex; only matching lines wake the agent. Every line still goes to the log. |
| `wake_debounce_ms` | Batch window before a wake (default 3000; 0 = one wake per line). |
| `title` | Short name shown in wakes and in `/tasks` (defaults to the command). |

```
● Bash(for i in 1 2 3; do echo tick $i; sleep 4; done)
  ⎿  Running in the background · wakes on output and exit · ticker (down to manage)

● Started the ticker task in the background. I'll be woken as output arrives and when it exits.

● ticker · output
  ⎿  tick 1

● Got tick 1 from the ticker. Waiting for the rest.
…
● ticker · exited 0
  ⎿  (no output)
```

Each wake is a `bg-wake` message whose text is `<title> output:` + lines (or `<title> exited N.`) followed by `Log: <path>`; it is delivered with `{ triggerTurn: true, deliverAs: "followUp" }`, so a wake that arrives mid-turn queues behind the current turn instead of interrupting it. At most 200 lines per wake; the rest is counted and pointed at the log. Logs live under `$TMPDIR/pi-claudio/<pi pid>/<task id>/` (`command`, `output.log`, `exitcode`) so concurrent pi sessions never share files. Wake tasks appear in `/tasks` (tagged `wake`) and in the footer count; `kill_shell` stops them (the exit wakes the agent once more). Commands moved to the background with **ctrl+b** also wake the agent when they exit.

The design and the batching logic follow [pi-bgwatch](https://github.com/josep-reyero/pi-bgwatch) by Josep Reyero (MIT) — pi-claudio folds the same primitive into its existing background `bash` instead of adding a separate tool.

## PR watching

Built on the wake primitive above. The package ships `scripts/pr-watch` (python3 + `gh`), which polls a pull request every N seconds and prints **one line per change**:

```
CHECKS head=008aff7 ok=0 failing=0 pending=2
CHECK_FAILED build https://github.com/o/r/actions/runs/123/job/456
REVIEW alice CHANGES_REQUESTED Please split this up
COMMENT bob src/foo.ts:42 nit: rename foo
DECISION APPROVED
STATE merged
DONE ci passed
```

`pr-watch [--repo owner/name] [--pr N] [--interval 60] [--until first_event|ci_done|review|merged] [--log-failed] [--include-self]` — the PR is resolved from the current branch when omitted; events are deduplicated by id; your own comments are skipped unless `--include-self`; `--log-failed` appends the last 40 lines of `gh run view --log-failed` under a failed check. It exits 0 with `DONE <reason>` when the `--until` condition is met.

Two tools wrap it:

- **`pr_watch`** (`pr`, `repo`, `interval`, `until`, `log_failed`, `include_self`) starts `pr-watch` through `bash` with `wake: true`, title `PR #N` and a `wake_pattern` for the event lines. Rendered as `● PR Watch(#2 · every 15s)`; the wakes as `● PR #2 · output` / `● PR #2 · exited 0`. The model is told to offer it after `gh pr create`.
- **`pr_status`** (`pr`, `repo`) is an immediate `gh` snapshot: title, state, checks summary with failed-check URLs, reviews, review decision and the latest comments. Rendered as `● PR Status(#2)`.

```
> watch PR 2, interval 15s, until ci_done

● PR Watch(#2 · every 15s)
  ⎿  Watching joanreyero/pi-claudio-scratch#2 every 15s until ci done (task 1d6a8c)

● Watching PR #2 every 15s; I'll report back when CI finishes.

● PR #2 · output
  ⎿  CHECKS head=008aff7 ok=0 failing=0 pending=2

● CI on PR #2 has 2 checks pending, none failed yet. Still watching until they finish.

● PR #2 · exited 0
  ⎿  CHECKS head=008aff7 ok=2 failing=0 pending=0
     DONE ci passed

● CI passed on PR #2: 2/2 checks green. Watcher has stopped.
```

Requires the GitHub CLI (`gh auth login`) and python3.

## MCP

Pi's MCP support is built in; pi-claudio only renders the calls. Add servers with `pi mcp add` or by editing `~/.pi/agent/mcp.json`, and inspect/sign in with `/mcp` inside a session (see Pi's `docs/mcp.md`).

Example — the Slack remote server with OAuth (an example only; pi-claudio ships no server config):

```bash
pi mcp add slack --url https://mcp.slack.com/mcp
```

then in `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "oauth": { "clientId": "1601185624273.8899143856786", "callbackPort": 3118 },
      "description": "Slack workspace: search messages, read channels and threads, send messages"
    }
  }
}
```

Run `/mcp` (or `pi mcp login slack`) to sign in. Tools are named `mcp__<server>__<tool>`; with the default `codemode` exposure the model reaches them from `codemode` scripts, and with `direct` exposure (`"toolExposure": { "slack_search_users": "direct" }`) they show up in the transcript as:

```
● slack · slack_search_users(keywords: ["joan"], …)
  ⎿  {"results":"# Search Results …
```

MCP tools without `readOnlyHint` annotations are treated as destructive by the permission gate (they prompt in `default`/`acceptEdits` mode).

## Workflows

Claude Code's `Task` fan-out (parallel sub-agents, pipelines, reviews) comes from **[pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows)** (vekexasia). `/claudio setup` runs `pi install npm:pi-extensible-workflows` when it is missing; `/claudio status` reports it. Why this one: it won a head-to-head against pi-ultracode on review quality (equal), cost (equal), maintenance (6 contributors, weekly releases vs one author), install footprint (8 MB vs 72 MB) and system-prompt cost (+1.3 k chars vs +22 k chars on every turn) — details and numbers in [docs/workflows-eval.md](docs/workflows-eval.md). Don't install a second workflow package: they register the same `workflow` tool.

How pi-claudio renders a run:

```
● Task(bug-review)
  ⎿  ├ review background.ts · running
     ├ review permissions.ts · running
     ├ summarize · pending
     └ Running…
```

`● Task(<name>)` rows with the live agent tree while it runs, `Done (N tool uses · tokens · time)` / `Workflow cancelled` on exit, and the `[workflow]` follow-up messages as normal `●` rows. `/workflow` opens the package's inline run browser (it respects the footer, no fullscreen overlay); the bundled prompt templates `/review`, `/parallel-review`, `/council`, `/scout`, `/deep-research` and the `subagents_*` tools work unchanged.

### Workflow tips

Four habits borrowed from the eval that cost nothing per turn. Paste into your `AGENTS.md`:

```markdown
## Workflow tips
- Pick the smallest **depth** that lets you verify the key claim: `focused` = check it directly yourself, no agents;
  `standard` = independent dimensions or competing hypotheses → fan out, then verify disputed claims;
  `deep` = interacting invariants → independent evidence plus a counterexample. Risk words and file counts
  don't raise depth; missing evidence does.
- Before launching agents, `log('analysis-depth: <level> — <reason>')` so the choice shows in the Task tree.
- Reviewers return structured output (`outputSchema`: `{ file, line, severity, title, evidence }`) and the
  parent synthesises the lists itself instead of spawning a summariser agent.
- Set effort per child with the model suffix: reviewers and judges `':high'`, mechanical children `':low'`.
```

## Uninstall

```bash
pi remove git:github.com/joanreyero/pi-claudio
```

Then, if `"theme"` in `~/.pi/agent/settings.json` is `"claudio"`, set it to another theme (e.g. `"dark"`) or remove it, and, if you want Pi's defaults back, remove the keys listed under [Configuration](#configuration) from `settings.json` and `keybindings.json`. State in `~/.pi/agent/claudio/` can be deleted.

## Known limitations

These come from Pi's extension API and cannot be changed from a package:

- **User message echo** is Pi's `UserMessageComponent`: a 3-row block (blank / `> text` / blank) with the `userMessageBg` background; the `>` and wrapped lines use the message text colour.
- **`Error: The operation was aborted.`** appears after Esc while a tool runs — emitted by Pi's assistant message component.
- **Assistant messages starting with a fence, list or table** get the `●` on its own line above the block (the Markdown transformer can only prepend text). Code blocks keep Pi's fence rows.
- **ctrl+o** also shows Pi's own `Tool output: expanded/collapsed` notice.
- **`!` shell mode** output uses Pi's built-in bash execution component, not the `●`/`⎿` shape.
- **shift+tab** is reserved by Pi for `app.thinking.cycle` until `/claudio setup` rebinds it; before that use `/permissions` or `/plan`.
- The running tool bullet is steady orange (no blink): tool renderers have no lifecycle hook to stop a timer.

## Development

See [docs/DEV.md](docs/DEV.md) for the module layout, the Pi API notes and the typecheck / tmux snapshot harness.

## License

MIT © Joan Reyero
