# pi-ember

*A warm finish for [pi](https://pi.dev).*

pi-ember is a Pi package that reskins the interactive TUI with a look and feel inspired by Claude Code: `●` tool rows with `⎿` result previews, a whimsical spinner, a permission-mode pill in the footer, background shell tasks, a todo checklist, and Esc Esc rewind with file checkpoints. No build step: Pi loads the TypeScript directly.

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
- **`todo_write`** tool rendered as `● Update Todos` with a `☒`/`☐` checklist; the in-progress item's `activeForm` replaces the spinner verb.
- **Esc Esc rewind** (or `/rewind`): pick an earlier user message and restore the conversation, the code (from per-turn file checkpoints taken before every edit/write), or both.
- **`?`** on an empty prompt shows the shortcuts panel.
- **Footer** with the context hint, session tokens/cost, context usage, permission pill and background-task count.
- **Header** with `✻ pi vX`, model · provider, cwd and a tip.
- **MCP tool calls** render like any other tool: `● <server> · <tool>(args)` with the result preview (see [MCP](#mcp)).
- A matching dark **theme** (`ember`).

## Install

```bash
pi install git:github.com/joanreyero/pi-ember
pi
```

Then, inside pi:

```
/ember setup
```

`/ember setup` merges the recommended settings and keybindings into your personal config (other keys are kept) and asks you to restart or `/reload`. Until it has run, pi-ember shows a one-line hint at startup.

`/ember status` shows which of the recommended values are applied.

## Configuration

`/ember setup` writes:

`~/.pi/agent/settings.json`

```json
{
  "theme": "ember",
  "tuiMode": "regular",
  "outputPad": 0,
  "quietStartup": true,
  "hideThinkingBlock": true,
  "doubleEscapeAction": "none"
}
```

- `tuiMode: regular` — scrollback-style transcript rather than fullscreen.
- `outputPad: 0` — the `●` sits in column 0.
- `quietStartup: true` — pi-ember draws its own header.
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

Everything pi-ember persists (permission allow-lists, file checkpoints) lives in `~/.pi/agent/ember/`, never inside the package directory.

### Permission modes

| Mode | Behaviour |
|---|---|
| `bypassPermissions` (default) | Everything runs. Footer shows `⏵⏵ bypass permissions on`. |
| `plan` | Only read-only tools run; the model is told to present a plan. Footer shows `⏸ plan mode on`. |
| `default` | Ask before shell commands (except safe read-only ones), edits, writes, destructive/MCP tools. |
| `acceptEdits` | Like `default`, but edits/writes are auto-approved. |

shift+tab cycles `bypassPermissions ↔ plan`; `/permissions default` or `/permissions acceptEdits` selects the asking modes.

## MCP

Pi's MCP support is built in; pi-ember only renders the calls. Add servers with `pi mcp add` or by editing `~/.pi/agent/mcp.json`, and inspect/sign in with `/mcp` inside a session (see Pi's `docs/mcp.md`).

Example — the Slack remote server with OAuth (an example only; pi-ember ships no server config):

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

## Uninstall

```bash
pi remove git:github.com/joanreyero/pi-ember
```

Then set `"theme"` in `~/.pi/agent/settings.json` to another theme (e.g. `"dark"`) and, if you want Pi's defaults back, remove the keys listed under [Configuration](#configuration) from `settings.json` and `keybindings.json`. State in `~/.pi/agent/ember/` can be deleted.

## Known limitations

These come from Pi's extension API and cannot be changed from a package:

- **User message echo** is Pi's `UserMessageComponent`: a 3-row block (blank / `> text` / blank) with the `userMessageBg` background; the `>` and wrapped lines use the message text colour.
- **`Error: The operation was aborted.`** appears after Esc while a tool runs — emitted by Pi's assistant message component.
- **Assistant messages starting with a fence, list or table** get the `●` on its own line above the block (the Markdown transformer can only prepend text). Code blocks keep Pi's fence rows.
- **ctrl+o** also shows Pi's own `Tool output: expanded/collapsed` notice.
- **`!` shell mode** output uses Pi's built-in bash execution component, not the `●`/`⎿` shape.
- **shift+tab** is reserved by Pi for `app.thinking.cycle` until `/ember setup` rebinds it; before that use `/permissions` or `/plan`.
- The running tool bullet is steady orange (no blink): tool renderers have no lifecycle hook to stop a timer.

## Development

See [docs/DEV.md](docs/DEV.md) for the module layout, the Pi API notes and the typecheck / tmux snapshot harness.

## License

MIT © Joan Reyero
