# pi-claudio

pi-claudio makes [pi](https://pi.dev) look and feel exactly like Claude Code.

```
✻ pi v1.3.0
  ~/my-project

  Tip: Press esc twice to rewind to a previous message

> run the tests and fix what fails

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

- **Claude-style transcript** — `●` rows for every tool (`Read`, `Skill` for a `SKILL.md` read, `Bash`, `Update` with a coloured diff, `Write`, `Search`, `List`, `Task`, MCP, generic), `⎿` result previews with `… +N lines`, **ctrl+o** to expand, the gerund spinner (`✻ Noodling…`), elapsed time and token count.
- **Prompt box and footer** — session cost, context usage, permission pill, background-task count; a matching dark theme.
- **Permission modes** — **shift+tab** cycles `bypass permissions` (default) ↔ `plan`; `/permissions default` turns on the ask-before dialogs for shell, edit, write and MCP tools, with "don't ask again for `<prefix>` commands in `<cwd>`". `/add-dir <path>` adds working directories where edits are auto-accepted in `acceptEdits` mode.
- **AskUserQuestion** — the model asks you 1–4 multiple-choice questions in a dialog (`ask_user_question`), with tabs, multi-select and free text.
- **Background commands that wake the agent** — `bash` with `run_in_background` / `wake: true`, `bash_output`, `kill_shell`, **ctrl+b**, `/tasks`. Wakes inject new output and start a turn: no polling (after [pi-bgwatch](https://github.com/josep-reyero/pi-bgwatch)).
- **Wait for PRs** — `pr_watch` wakes the agent when CI finishes or fails, a review or comment lands, or the PR merges; `pr_status` is a snapshot.
- **Esc Esc rewind** — pick an earlier message and restore the conversation, the files (per-turn checkpoints before every edit/write), or both.
- **Todo list** — `todo_write` rendered as `● Update Todos` with a `☒`/`☐` checklist; the in-progress item replaces the spinner verb.
- **`?` shortcuts panel**, MCP tool rendering (`● <server> · <tool>(args)`), and **workflows** (`● Task(name)` with a live agent tree) via [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows), installed by `/claudio setup` — why that one: [docs/workflows-eval.md](docs/workflows-eval.md).
- **Herdr** — inside a [herdr](https://herdr.dev) pane, a permission prompt or AskUserQuestion marks the agent **blocked** in herdr's sidebar, and the pane gets one model-written name per session (see [Herdr](#herdr)).
- **Claude Code agents in workflows** — `agent(prompt, { agentType: "name" })` loads `.claude/agents/<name>.md` (project, user or `<plugin>:<name>`): prompt, tools and model from the file (see [Claude Code agents](#claude-code-agents-agenttype)).
- **Follows your Pi theme**: every colour (bullets, spinner, diffs, dialogs, footer pill) is resolved from the active Pi theme (`/settings` → Theme: `system`, `dark`, `light`, `light/dark` or a custom one), so pi-claudio works on light terminals too. The bundled **`claudio`** theme reproduces Claude Code's exact dark palette.

No build step: pi loads the TypeScript directly.

## Install

```bash
pi install git:github.com/joanreyero/pi-claudio
pi
```

Then inside pi:

```
/claudio setup
```

It merges the recommended settings and keybindings into your config (other keys are kept), sets `theme` to `light/claudio` only if you have not chosen one yet (Pi's `light` theme on light terminals, the bundled Claude Code palette on dark ones), installs `npm:pi-extensible-workflows` if missing, and asks you to `/reload`. `/claudio status` shows what is applied.

## Configuration

`/claudio setup` writes to `~/.pi/agent/settings.json`:

```json
{
  "tuiMode": "regular",
  "outputPad": 0,
  "quietStartup": true,
  "hideThinkingBlock": true,
  "doubleEscapeAction": "none"
}
```

(`regular` = scrollback transcript, `outputPad: 0` puts `●` in column 0, `quietStartup` lets pi-claudio draw the header, `doubleEscapeAction: none` frees Esc Esc for rewind.)

plus `"theme": "light/claudio"` when `theme` is not set yet (an existing choice such as `"dark"` or `"system"` is left alone).

and to `~/.pi/agent/keybindings.json`:

```json
{
  "app.interrupt": "escape",
  "app.tools.expand": "ctrl+o",
  "app.thinking.cycle": "alt+t"
}
```

`app.thinking.cycle` moves to alt+t so shift+tab can cycle permission modes. If you see a `ctrl+b` conflict with `tui.editor.cursorLeft`, add `"tui.editor.cursorLeft": ["left"]`.

Everything pi-claudio persists (allow-lists, file checkpoints) lives in `~/.pi/agent/claudio/`, never inside the package directory.

## Themes

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

## Permission modes

| Mode | Behaviour |
|---|---|
| `bypassPermissions` (default) | Everything runs. Footer: `⏵⏵ bypass permissions on`. |
| `plan` | Only read-only tools run; the model is told to present a plan. Footer: `⏸ plan mode on`. |
| `default` | Ask before shell commands (except safe read-only ones), edits, writes, destructive/MCP tools. |
| `acceptEdits` | Like `default`, but edits and writes inside the working directories (cwd and `/add-dir` directories) are auto-approved. |

shift+tab cycles `bypassPermissions ↔ plan`; `/permissions default`, `/permissions acceptEdits` and `/plan` select the others.

```
● Bash(ls | tee out.txt)

────────────────────────────────────────────────────────────────────────────────
 Bash command

   ls | tee out.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for tee commands in ~/my-project
   3. No, and tell me what to do differently (esc)
```

### Working directories: `/add-dir`

`/add-dir <path>` adds a directory to the session (Claude Code's `/add-dir`). Edits and writes there are auto-approved in `acceptEdits` mode, the model is told about it in the system prompt, and its `AGENTS.md` / `CLAUDE.md` is loaded as project context like the cwd's own. `/add-dir` alone lists the working directories. The list is stored in the session, so `/resume` keeps it. When an edit lands outside every working directory, the dialog's second option is **Yes, and allow edits in `<dir>` during this session**, which adds that directory and switches to `acceptEdits`.

A command is "safe" (never asked) only when every piece of it — across `|`, `&&`, `||`, `;`, `&` and newlines — is an allowlisted read-only command and there is no redirect or command substitution. "Don't ask again" likewise covers a later command only when every piece is safe or approved.

## AskUserQuestion

`ask_user_question` lets the model stop and ask you to decide (1–4 questions, 2–4 options each, optional multi-select). Keys: `1`–`9`, `↑`/`↓`, enter, space to toggle, `←`/`→` between questions, esc to cancel. The last option is always "Type something else."

```
● Asking question

────────────────────────────────────────────────────────────────────────────────
 Question 1 of 2
  Database   Auth

 Which database should the service use?

 ❯ 1. Postgres
      Recommended: already used by the API
   2. SQLite
      Simplest for a single-node deployment
   3. Type something else.
```

```
● Asked question
  ⎿  Database → Postgres
     Auth     → Sessions
```

## Background commands that wake the agent

`bash` takes `run_in_background` and `wake: true` (implies background). The agent is **woken** — a message is injected and a turn starts — with each batch of new output and when the command exits. The model starts the command, ends its turn, and acts when woken.

| `bash` param | Meaning |
|---|---|
| `wake` | Wake the agent on new output and on exit. |
| `wake_pattern` | Regex; only matching lines wake the agent. Every line still goes to the log. |
| `wake_debounce_ms` | Batch window before a wake (default 3000; 0 = one wake per line). |
| `title` | Short name shown in wakes and in `/tasks` (defaults to the command). |

```
● Bash(for i in 1 2 3; do echo tick $i; sleep 4; done)
  ⎿  Running in the background · wakes on output and exit · ticker (down to manage)

● ticker · output
  ⎿  tick 1

● Got tick 1 from the ticker. Waiting for the rest.
…
● ticker · exited 0
```

Wakes are `bg-wake` messages delivered as follow-ups, so one that arrives mid-turn queues instead of interrupting. At most 200 lines per wake; the rest is counted and pointed at the log under `$TMPDIR/pi-claudio/<pid>/<task>/`. `bash_output` reads new output, `kill_shell` stops a task (its exit wakes the agent once more), **ctrl+b** moves a running foreground command to the background, `/tasks` (or `↓` on an empty prompt) lists them.

The batching logic follows [pi-bgwatch](https://github.com/josep-reyero/pi-bgwatch) by Josep Reyero (MIT), folded into the existing `bash` tool instead of a separate one.

## PR watching

`scripts/pr-watch` (python3 + `gh`) polls a pull request and prints one line per change:

```
CHECKS head=008aff7 ok=0 failing=0 pending=2
CHECK_FAILED build https://github.com/o/r/actions/runs/123/job/456
REVIEW alice CHANGES_REQUESTED Please split this up
COMMENT bob src/foo.ts:42 nit: rename foo
DECISION APPROVED
STATE merged
DONE ci passed
```

`pr-watch [--repo owner/name] [--pr N] [--interval 60] [--until first_event|ci_done|review|merged] [--log-failed] [--include-self]`. Two tools wrap it: **`pr_watch`** starts it as a wake task (`● PR Watch(#2 · every 15s)`, wakes as `● PR #2 · output`), and **`pr_status`** is an immediate `gh` snapshot (`● PR Status(#2)`). The model is told to offer `pr_watch` after `gh pr create`.

```
> watch PR 2, interval 15s, until ci_done

● PR Watch(#2 · every 15s)
  ⎿  Watching acme/widgets#2 every 15s until ci done (task 1d6a8c)

● PR #2 · exited 0
  ⎿  CHECKS head=008aff7 ok=2 failing=0 pending=0
     DONE ci passed

● CI passed on PR #2: 2/2 checks green.
```

Requires the GitHub CLI (`gh auth login`) and python3.

## Rewind

Esc Esc on an empty prompt (or `/rewind`) opens a picker of your earlier messages. Choose to restore the **conversation**, the **code** (files are checkpointed before every edit/write, per turn, under `~/.pi/agent/claudio/checkpoints/`), or **both**. Nothing is written until the choice is confirmed; cancelling leaves files and history untouched.

## MCP

Pi's MCP support is built in; pi-claudio only renders the calls. Add servers with `pi mcp add <name> --url <url>` or in `~/.pi/agent/mcp.json`, sign in with `/mcp`. Tools are named `mcp__<server>__<tool>`; with `direct` exposure they appear as:

```
● slack · slack_search_users(keywords: ["ana"], …)
  ⎿  {"results":"# Search Results …
```

MCP tools without `readOnlyHint` are treated as destructive by the permission gate (they prompt in `default`/`acceptEdits`).

## Herdr

[Herdr](https://herdr.dev) shows every agent pane as working, blocked or idle. Its Pi integration (`herdr integration install pi`) reports working/idle from pi's lifecycle, but only switches to **blocked** when an extension emits `herdr:blocked` on `pi.events`, and nothing in pi does by default. pi-claudio emits it while a permission prompt or an AskUserQuestion dialog is open, so the sidebar tells you which Pi is waiting for an answer. It also **names the pane**, once per session: the first prompt's first words at once, then a 3–5 word title the current model writes from that prompt (one tiny request), which is also stored as the Pi session name (shown by `/resume`; a resumed session keeps its pane name; a session named with `/name` uses that). The name describes what the session is for and never changes with the current step — the status dot already shows activity. Needs both: herdr's Pi integration and pi running inside a herdr pane (`HERDR_ENV=1`); elsewhere the module does nothing.

## Workflows

Claude Code's `Task` fan-out (parallel sub-agents, pipelines, reviews) comes from [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows). `/claudio setup` installs it; don't install a second workflow package (they register the same `workflow` tool). It was picked over pi-ultracode on equal review quality and cost, with a much smaller install and system-prompt footprint — numbers in [docs/workflows-eval.md](docs/workflows-eval.md).

```
● Task(bug-review)
  ⎿  ├ review background.ts · running
     ├ review permissions.ts · running
     ├ summarize · pending
     └ Running…
```

`/workflow` opens the inline run browser; the bundled `/review`, `/parallel-review`, `/council`, `/scout`, `/deep-research` templates and the `subagents_*` tools work unchanged.

### Claude Code agents (`agentType`)

Claude Code's subagents are Markdown files with frontmatter — `.claude/agents/<name>.md` in the project, `~/.claude/agents/<name>.md` for the user, `<plugin>:<name>` from an installed plugin's `agents/` directory — and its Workflow scripts launch them with `agent(prompt, { agentType: "<name>" })`. pi-claudio makes that option work in pi-extensible-workflows: when a workflow `agent()` (or `agent.create()`, or a nested child) passes `agentType`, the agent file is found with Claude Code's precedence, its body is appended to the system prompt, its `tools:` list narrows the pi tools (`Bash` → `bash`/`bash_output`/`kill_shell`, `Read` → `read`, `Edit`/`MultiEdit` → `edit`, `Write` → `write`, `Glob` → `find`/`ls`, `Grep` → `grep`, `TodoWrite` → `todo_write`, `AskUserQuestion` → `ask_user_question`, `mcp__*` unchanged; tools pi does not have are dropped), `disallowedTools:` adds exclusions, `model: <alias>` applies when a workflow model alias of that name exists (`sonnet`/`opus`/`haiku` are otherwise inherited from the parent), and the agent is labelled after the file. The agent files stay the single source of truth for both Claude Code and pi. An unknown `agentType` fails the launch with the paths that were searched; project agents need project trust.

```js
const review = await agent(prompt("Review the branch in {wt}", { wt }), {
  agentType: "mktgos-reviewer",          // .claude/agents/mktgos-reviewer.md
  outputSchema: REVIEW_SCHEMA,
});
const general = await agent("Keyword: branch. Review it.", {
  agentType: "lfx-skills:lfx-general-code-reviewer", // an installed Claude Code plugin's agent
});
```

The other differences between Claude Code's Workflow API and pi's stay in the script: `parallel(name, { key: fn })` instead of `parallel([fn])`, `outputSchema` instead of `schema`, `phase("Name")` instead of a `phase:` option, and no two concurrent `agent()` calls from the same call site outside `parallel`/`pipeline`.

### Workflow tips

Habits from the eval that cost nothing per turn — paste into your `AGENTS.md`:

```markdown
- Pick the smallest depth that verifies the key claim: `focused` = check it yourself, no agents;
  `standard` = independent dimensions or competing hypotheses → fan out, then verify disputed claims;
  `deep` = interacting invariants → independent evidence plus a counterexample.
- Before launching agents, `log('analysis-depth: <level> — <reason>')` so the choice shows in the Task tree.
- Reviewers return structured output (`{ file, line, severity, title, evidence }`) and the parent
  synthesises the lists itself instead of spawning a summariser agent.
- Set effort per child with the model suffix: reviewers and judges `':high'`, mechanical children `':low'`.
```

## Known limitations

From pi's extension API; not changeable from a package:

- **User message echo** is pi's component: a 3-row block with the `userMessageBg` background.
- **`Error: The operation was aborted.`** appears after Esc while a tool runs.
- **Assistant messages starting with a fence, list or table** get the `●` on its own line above the block.
- **ctrl+o** also shows pi's own `Tool output: expanded/collapsed` notice.
- **`!` shell mode** output uses pi's built-in component, not the `●`/`⎿` shape.
- **shift+tab** is reserved by pi for `app.thinking.cycle` until `/claudio setup` rebinds it.
- The running tool bullet is steady orange (no blink).

## Uninstall

```bash
pi remove git:github.com/joanreyero/pi-claudio
```

Then, if `"theme"` in `~/.pi/agent/settings.json` is `"claudio"` or `"light/claudio"`, set it to another theme or remove it, and, if you want pi's defaults back, remove the keys listed under [Configuration](#configuration). State in `~/.pi/agent/claudio/` can be deleted.

## Development

See [docs/DEV.md](docs/DEV.md) for the module layout, pi API notes and the typecheck / tmux snapshot harness.

## License

MIT © Joan Reyero
