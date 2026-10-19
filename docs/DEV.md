# pi-ember — developer notes

pi-ember is a single Pi extension (`extensions/ember/index.ts` + modules) plus a theme (`themes/ember.json`). Pi (≥ 1.3) loads the `.ts` files directly via jiti — there is no build step. Imports available at runtime: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox` (host-provided; declared as `peerDependencies`), and node builtins. Do not add `dependencies` for those.

## Modules

| File | Owns |
|---|---|
| `index.ts` | Entry point; calls each `setupXxx(pi)` in dependency order (see the comment there). |
| `shared.ts` | Palette, ANSI helpers, glyphs, verbs, formatting, `stateDir()`, the cross-module state **bus** (`permissionMode`, `backgroundTaskCount`, `currentTodo`, `toolsExpanded`, `dialog`) and `actions` (openTasks/openRewind), `dialogLines()` chrome. Pure: no timers, no side effects. |
| `setup.ts` | `/ember setup` and `/ember status`; the startup hint; `shiftTabIsFree()`. |
| `permissions.ts` | Permission modes, `tool_call` gate, permission dialog, `/permissions`, `/plan`, shift+tab shortcut. Persists allow-lists to `~/.pi/agent/ember/permissions.json`. |
| `background.ts` | Overrides `bash` with `run_in_background` and `wake` / `wake_pattern` / `wake_debounce_ms` / `title` (wake-on-output: debounced batches → `bg-wake` messages with `triggerTurn` + `followUp`, logs under `$TMPDIR/pi-ember/<pid>/<id>/`; after pi-bgwatch by Josep Reyero), adds `bash_output` / `kill_shell`, `/tasks`, ctrl+b (its exit also wakes), the tasks dialog and the `bg-wake` message renderer. Exports `startBackgroundTask` for thin wrappers. |
| `pr.ts` | `pr_watch` (starts `scripts/pr-watch` as a wake task; script path resolved from `import.meta.url` so the git install works) and `pr_status` (a `gh` snapshot). No polling lives in the extension: all PR logic is in the script. |
| `todo.ts` | `todo_write` tool + checklist rendering; publishes `currentTodo`. |
| `tools.ts` | Tool renderers (`registerToolRenderer`, `renderShell: "self"`) for read/bash/edit/write/grep/find/ls/Task/pr_watch/pr_status/generic/MCP. |
| `rewind.ts` | File checkpoints before mutating tool calls (`~/.pi/agent/ember/checkpoints/<session>/<turn>/`), `/rewind` picker. |
| `spinner.ts` | Working indicator widget (`aboveEditor`), token animation, terminal title. |
| `messages.ts` | Markdown transformers (`> ` user prefix, `● ` assistant prefix), hidden thinking label. |
| `chrome.ts` | Header, editor (`CustomEditor` subclass), footer, `?` help panel. |

Conventions: each module exports `setupXxx(pi: ExtensionAPI)`; per-module state stays module-local; cross-module state goes through the bus. Guard TUI-only calls with `ctx.mode === "tui"` / `ctx.hasUI`. Never start timers at module load — start in `session_start`/`agent_start` and clear in `agent_end`/`session_shutdown`. Every rendered line must fit the width (`truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` from pi-tui). Colours use raw truecolor ANSI via `shared.ts` helpers; theme tokens (`theme.fg(...)`) where a token exists.

## Pi API notes (verified on 1.3.0)

- User and assistant message components cannot be replaced. Only (a) theming and (b) `pi.registerMarkdownTransformer((md, ctx) => md)` with `ctx.messageType` `"user" | "assistant" | "assistant-thinking"`. A literal `> ` prefix needs a zero-width space (`"\u200B> "`) so Markdown does not see a blockquote.
- Tool rendering: `pi.registerToolRenderer((toolName, next) => ({ renderShell: "self", renderCall, renderResult }))`. `renderShell: "self"` removes Pi's coloured box. `renderResult` gets `{ expanded, isPartial }` and a ctx with `isError`, `durationMs`, `executionStarted`, `argsComplete`, `cwd`, `outputPad`, `lastComponent`, `invalidate()`. Both renderers run before render, so components build their lines lazily (`LazyLines` in tools.ts).
- Working indicator: we hide Pi's (`ctx.ui.setWorkingVisible(false)`) and draw our own `aboveEditor` widget; `setWidget` once per key so it keeps its slot.
- Collapsed thinking label: `ctx.ui.setHiddenThinkingLabel(...)`.
- Header / footer / editor: `ctx.ui.setHeader`, `setFooter`, `setEditorComponent` with a class extending `CustomEditor` (override `renderTopBorder`/`renderBottomBorder`/`handleInput`/`render`).
- Expand-all state: `ctx.ui.getToolsExpanded()`; the action is `app.tools.expand` (default ctrl+o); `keyText("app.tools.expand")` gives the bound key for hints.
- shift+tab is reserved for `app.thinking.cycle`; `registerShortcut("shift+tab")` is skipped with a warning unless `~/.pi/agent/keybindings.json` rebinds `app.thinking.cycle`. `/ember setup` does that.
- Blocking tool calls: `pi.on("tool_call", ...)` → `{ block: true, reason, terminate?: true }`. `terminate: true` ends the turn cleanly (no abort message). Dialogs: `ctx.ui.custom((tui, theme, kb, done) => Component, { overlay: false })` replaces the editor.
- Reaching a command context from a key handler: `pi.sendUserMessage("/rewind", { expandPromptTemplates: true })` — the only way to get `ctx.navigateTree`. The `/rewind` text does not appear in the transcript.
- MCP tools are named `mcp__<server>__<tool>`; `pi.getAllTools()` exposes their annotations (`readOnlyHint`, `destructiveHint`, …) for the permission gate.
- `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "followUp" })` starts a turn when idle and queues behind the current turn when streaming — the right mode for background wakes. Custom messages render through `pi.registerMessageRenderer(customType, (msg, { expanded, outputPad }, theme) => Component)`; `expanded` follows ctrl+o.
- Package resources: `extensions/<dir>/index.ts` and `themes/*.json` are discovered without a `pi` manifest. Local packages are identified by absolute path; state must never live inside the package dir (`stateDir()` → `~/.pi/agent/ember`).

## Pi limits that remain visible

See "Known limitations" in the README. Also: the running-tool bullet does not blink (no lifecycle hook to stop a timer from `renderCall`), and the collapsed thinking label uses the theme's `thinkingText` colour rather than SGR dim.

## Dev harness

A separate typecheck project keeps the real Pi type packages out of this repo (a `node_modules` inside the package would shadow the host-provided modules at runtime and duplicate classes).

```bash
mkdir -p ~/.cache/pi-typecheck && cd ~/.cache/pi-typecheck
npm init -y >/dev/null
npm i -D typescript @types/node @earendil-works/pi-coding-agent
```

`~/.cache/pi-typecheck/tsconfig.json` — note the `paths` point at the `.d.ts` entry files because this package is `"type": "module"` (directory mappings fail under NodeNext ESM resolution):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "types": ["node"],
    "typeRoots": ["./node_modules/@types"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["./node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["./node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["./node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-agent-core": ["./node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"],
      "typebox": ["./node_modules/typebox/build/index.d.mts"],
      "*": ["./node_modules/*"]
    }
  },
  "include": ["/path/to/pi-ember/extensions/**/*.ts"]
}
```

- Typecheck: `cd ~/.cache/pi-typecheck && npx tsc -p tsconfig.json` (must print nothing, exit 0).
- Load smoke test: `cd /tmp && pi -p --no-session "say hi"`.
- Visual snapshot through tmux (`scripts/pi-snap.sh`): `scripts/pi-snap.sh -w 100 -h 40 -t 30 "read /etc/hostname and reply in 3 words"`. Extension load errors show on the startup screen, so always check the snapshot after edits. Cheap prompts that exercise tools: `read /etc/hostname`, `run ls /tmp | head -3`, `create /tmp/x.txt with 3 lines then edit line 2`. `PI_SNAP_ANSI=1` also saves the coloured pane to `/tmp/pi-snap-ansi.txt`.
- Try the package from a checkout without installing: `pi -e /path/to/pi-ember` (note: the installed package loads too; for tmux tests of the working tree, temporarily symlink `~/.pi/agent/git/github.com/joanreyero/pi-ember` to the checkout).
- Wake test: in tmux ask "run `for i in 1 2 3; do echo tick $i; sleep 4; done` in the background with wake=true" and capture the pane after ~30 s: the `●` row appears at once, then `● <title> · output` / `· exited 0` rows with the agent's replies. PR test: a scratch repo with a trivial workflow, `gh pr create`, then "watch PR N, interval 15s, until ci_done"; `scripts/pr-watch --pr N --interval 10 --until ci_done` can be dry-run directly.
