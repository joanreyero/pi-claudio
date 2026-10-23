/**
 * chrome.ts — the "chrome": welcome header, prompt box (editor), footer hint line
 * and the "?" shortcuts panel. Layout inspired by Claude Code's UI.
 *
 * Reads from the shared bus (shared.ts): `permissionMode`, `backgroundTaskCount`, `workflowCount`, `dialog`.
 * Nothing here changes height while idle or working: the footer is always one row.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, VERSION } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	formatTokens,
	actions,
	bashBorder,
	bold,
	bus,
	claudio,
	dim,
	fg,
	permissionModePill,
	PLACEHOLDER_EXAMPLES,
	shortenPath,
	warning,
} from "./shared.ts";

// ---------------------------------------------------------------------------------------------
// Module-local state shared between editor, footer and the "?" panel
// ---------------------------------------------------------------------------------------------
const local = {
	editorText: "",
	running: false,
	/** The transcript has at least one message (Pi adds its own blank row below the header while it is empty). */
	hasMessages: false,
	helpShown: false,
	/** Time of the last lone Escape on an empty prompt (Esc Esc within 500 ms opens Rewind). */
	lastEscape: 0,
	requestRender: () => {},
	setHelpWidget: (_show: boolean) => {},
};

/** ↓ on an empty prompt: the background tasks; the workflows only when no task runs (the footer names `/workflow`). */
function openBackground(): boolean {
	const tasks = bus.get("backgroundTaskCount") > 0 && actions.openTasks;
	const workflows = bus.get("workflowCount") > 0 && actions.openWorkflows;
	const open = tasks || workflows;
	if (!open) return false;
	open();
	return true;
}

function isBashMode(text: string): boolean {
	return text.trimStart().startsWith("!");
}

function isWorking(): boolean {
	return local.running;
}

function toggleHelp(show = !local.helpShown): void {
	local.helpShown = show;
	local.setHelpWidget(show);
	local.requestRender();
}

// ---------------------------------------------------------------------------------------------
// 1. Header (+ compact fallback for short terminals)
// ---------------------------------------------------------------------------------------------
const TIPS = [
	"Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode",
	"Tip: Use /compact when the conversation gets long to free up context",
	"Tip: Press ctrl+o to expand tool output and see the full transcript",
	"Tip: Type ! to run a shell command, @ to reference a file, / for commands",
	"Tip: Press esc twice to rewind to a previous message",
	"Tip: Use ctrl+b to move a long-running command to the background",
];

function modelDisplayName(ctx: ExtensionContext): string {
	const name = ctx.model?.name ?? ctx.model?.id ?? "unknown model";
	return name;
}

function billingLabel(ctx: ExtensionContext): string {
	const provider = String(ctx.model?.provider ?? "");
	if (!provider) return "";
	if (provider === "anthropic") return "Anthropic";
	const known: Record<string, string> = {
		"github-copilot": "GitHub Copilot",
		openai: "OpenAI",
		"openai-codex": "OpenAI Codex",
		"amazon-bedrock": "Amazon Bedrock",
		"google-vertex": "Google Vertex AI",
		google: "Google AI",
		"google-gemini-cli": "Gemini CLI",
		"google-antigravity": "Antigravity",
		"azure-openai-responses": "Azure OpenAI",
		openrouter: "OpenRouter",
		groq: "Groq",
		cerebras: "Cerebras",
		xai: "xAI",
		mistral: "Mistral",
		zai: "Z.AI",
		minimax: "MiniMax",
		huggingface: "Hugging Face",
		vercel: "Vercel AI Gateway",
		opencode: "OpenCode Zen",
		kimi: "Kimi",
	};
	return known[provider] ?? provider.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

class ClaudioHeader implements Component {
	private readonly tip: string;
	constructor(
		private readonly tui: TUI,
		private readonly model: string,
		private readonly billing: string,
		private readonly cwd: string,
	) {
		this.tip = TIPS[Math.floor(Math.random() * TIPS.length)]!;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const version = `v${VERSION}`;
		if (this.tui.terminal.rows < 30) {
			return ["", truncateToWidth(`${claudio("✻")} ${bold("pi")} ${dim(version)}`, width), ""];
		}
		const textMax = Math.max(10, width - 4);
		const modelLine = this.billing ? `${this.model} · ${this.billing}` : this.model;
		const textLines: string[] = [`${claudio("✻")} ${bold("pi")} ${dim(version)}`];
		if (visibleWidth(modelLine) <= textMax) textLines.push(dim(modelLine));
		else textLines.push(dim(truncateToWidth(this.model, textMax)), dim(truncateToWidth(this.billing, textMax)));
		// Deliberate: `~`-abbreviated cwd.
		textLines.push(dim(shortenPath(this.cwd, textMax)));

		const out: string[] = [""];
		for (let i = 0; i < textLines.length; i++) {
			const text = textLines[i] ?? "";
			out.push(truncateToWidth(i === 0 ? text : `  ${text}`, width));
		}
		out.push("", truncateToWidth(`  ${dim(this.tip)}`, width));
		// Pi inserts a blank row after the header while the chat is empty; add ours only once messages exist.
		if (local.hasMessages) out.push("");
		return out;
	}
}

// ---------------------------------------------------------------------------------------------
// 2. Editor — prompt box
// ---------------------------------------------------------------------------------------------
function pickPlaceholder(cwd: string): string {
	let example = PLACEHOLDER_EXAMPLES[Math.floor(Math.random() * PLACEHOLDER_EXAMPLES.length)] ?? "fix lint errors";
	if (example.includes("<file>")) {
		let file: string | undefined;
		try {
			file = readdirSync(cwd).find((f) => {
				if (f.startsWith(".")) return false;
				try {
					return statSync(join(cwd, f)).isFile();
				} catch {
					return false;
				}
			});
		} catch {
			/* unreadable cwd */
		}
		example = file ? example.replace("<file>", file) : "fix lint errors";
	}
	return `Try "${example}"`;
}

class ClaudioEditor extends CustomEditor {
	private readonly placeholder: string;
	private topHidden = 0;

	constructor(tui: TUI, theme: EditorTheme, kb: KeybindingsManager, cwd: string) {
		// No embedWorkingStatus → the spinner row renders in statusContainer above the editor
		super(tui, theme, kb, { paddingX: 2 });
		this.placeholder = pickPlaceholder(cwd);
	}

	/** Keep two cells free for the "> " prefix regardless of the editorPaddingX setting. */
	override setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(2, padding));
	}

	private rule(width: number): string {
		const line = "─".repeat(Math.max(0, width));
		// The rules are bashBorder pink only in `!` mode, otherwise dim default. The permission mode changes the footer pill only, never the border.
		if (isBashMode(this.getText())) return bashBorder(line);
		return dim(fg("promptBorder", line));
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.topHidden = hiddenLineCount;
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
		return this.rule(width);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0) return super.renderBottomBorder(width, hiddenLineCount);
		return this.rule(width);
	}

	override setText(text: string): void {
		super.setText(text);
		local.editorText = this.getText();
	}

	override handleInput(data: string): void {
		const text = this.getText();
		if (data === "?" && text.length === 0 && !this.isShowingAutocomplete()) {
			toggleHelp();
			return;
		}
		if (local.helpShown && matchesKey(data, "escape") && !this.isShowingAutocomplete()) {
			toggleHelp(false);
			return;
		}
		// Esc Esc on an empty, idle prompt opens the Rewind picker (Pi's own double-escape action is set to "none").
		if (matchesKey(data, "escape")) {
			const now = Date.now();
			if (text.length === 0 && !isWorking() && !this.isShowingAutocomplete() && !bus.get("dialog")) {
				if (now - local.lastEscape < 500 && actions.openRewind) {
					local.lastEscape = 0;
					actions.openRewind();
					return;
				}
				local.lastEscape = now;
			} else {
				local.lastEscape = 0;
			}
		}
		// ↓ on an empty prompt opens the background tasks or the workflows — Claude's `↓ to manage`.
		if (matchesKey(data, "down") && text.length === 0 && !this.isShowingAutocomplete() && openBackground()) return;
		super.handleInput(data);
		const after = this.getText();
		if (after !== local.editorText) {
			local.editorText = after;
			local.requestRender();
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 3 || this.topHidden > 0) return lines;
		const text = this.getText();
		if (text.length === 0) {
			const first = this.placeholder.charAt(0);
			const rest = this.placeholder.slice(1);
			const cursor = this.focused ? CURSOR_MARKER + renderFakeCursor(first) : dim(first);
			lines[1] = truncateToWidth(`${dim("> ")}${cursor}${dim(rest)}`, width, "", true);
			return lines;
		}
		const body = lines[1]!.slice(2); // the first two cells are the plain-space left padding
		// The `!` may be wrapped in the cursor marker / fake-cursor escapes when the cursor sits on it.
		// eslint-disable-next-line no-control-regex
		const bang = isBashMode(text) ? /^((?:\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b_pi:fc\x07)*)!/.exec(body) : null;
		if (bang) {
			const prefix = bang[1] ?? "";
			// `!` replaces `>`; the typed `!` occupied the first cell so the rest stays aligned.
			lines[1] = `${prefix}${bashBorder("!")} ${body.slice(bang[0].length)}`;
		} else {
			lines[1] = `> ${body}`;
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------------------------
// 3. Footer
// ---------------------------------------------------------------------------------------------
function modePill(): string {
	const pill = permissionModePill(bus.get("permissionMode"));
	if (!pill) return "";
	return `${fg(pill.color, pill.text)}${dim(" (shift+tab to cycle)")}`;
}

class ClaudioFooter implements Component {
	private readonly unsubscribe: () => void;
	constructor(
		private readonly tui: TUI,
		private readonly ctx: ExtensionContext,
		private readonly data: ReadonlyFooterDataProvider,
		private readonly thinkingLevel: () => string,
	) {
		this.unsubscribe = bus.subscribeAll(() => this.tui.requestRender());
	}
	dispose(): void {
		this.unsubscribe();
	}
	invalidate(): void {}

	private leftHint(): string {
		const text = local.editorText;
		if (bus.get("dialog")) return dim("Esc to cancel");
		if (isBashMode(text)) return bashBorder("! for shell mode");
		// Typing while Claude works: Enter steers (interrupts and sends), like Claude's queued-message hint.
		if (isWorking()) return dim(text.length > 0 ? "enter to interrupt and send" : "esc to interrupt");
		if (this.ctx.ui.getToolsExpanded()) return dim("Showing detailed transcript · ctrl+o to toggle");
		if (text.length > 0) return dim("esc to clear");
		return dim("? for shortcuts");
	}

	private statsCache?: { count: number; model: string | undefined; text: string };

	/** Session usage like Pi's footer: `↑in ↓out $cost · 38.8%/1.0M`. Cached per branch length. */
	private sessionStats(): string {
		const branch = this.ctx.sessionManager.getBranch();
		const model = this.ctx.model?.id;
		if (this.statsCache && this.statsCache.count === branch.length && this.statsCache.model === model) return this.statsCache.text;
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const e of branch) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cost += m.usage.cost.total;
			}
		}
		const parts: string[] = [];
		if (input || output) parts.push(`↑${formatTokens(input)} ↓${formatTokens(output)}`);
		if (cost > 0) parts.push(`$${cost.toFixed(cost < 1 ? 3 : 2)}`);
		const usage = this.ctx.getContextUsage();
		if (usage) {
			const pct = usage.percent == null ? "?" : usage.percent.toFixed(1);
			parts.push(`${pct}%/${formatTokens(usage.contextWindow)}`);
		}
		const text = parts.join(" ");
		this.statsCache = { count: branch.length, model, text };
		return text;
	}

	/** Other extensions' `ctx.ui.setStatus` texts (aweb's connection state, for one), one line each. */
	private statuses(): string[] {
		return [...this.data.getExtensionStatuses().values()]
			.map((s) => s.replace(/[\r\n\t]+/g, " ").trim())
			.filter(Boolean);
	}

	/** The current model and, when the model reasons, its thinking level: `claude-fable-5.1 · high`. */
	private model(): string {
		const id = this.ctx.model?.id;
		if (!id) return "";
		const level = this.ctx.model?.reasoning ? this.thinkingLevel() : "";
		return level && level !== "off" ? `${id} · ${level}` : id;
	}

	private rightItems(): string[] {
		// Leftmost goes first when the row is short: statuses, the usage stats, then the model.
		const items: string[] = [...this.statuses()];
		const stats = this.sessionStats();
		if (stats) items.push(dim(stats));
		const model = this.model();
		if (model) items.push(dim(model));
		const pill = modePill();
		if (pill) items.push(pill);
		const tasks = bus.get("backgroundTaskCount");
		const workflows = bus.get("workflowCount");
		if (workflows > 0) items.push(dim(`${workflows} ${workflows === 1 ? "workflow" : "workflows"} · /workflow to view`));
		if (tasks > 0) items.push(dim(`${tasks} background ${tasks === 1 ? "task" : "tasks"} · ↓ to manage`));
		const usage = this.ctx.getContextUsage();
		if (usage?.percent != null) {
			const left = Math.max(0, Math.round(100 - usage.percent));
			if (left <= 40) {
				const txt = `Context left until auto-compact: ${left}%`;
				items.push(left <= 15 ? warning(txt) : dim(txt));
			}
		}
		return items;
	}

	render(width: number): string[] {
		// The "?" panel replaces the hint line entirely (Claude swaps the footer for the panel).
		if (local.helpShown && !bus.get("dialog")) return [];
		const left = `  ${this.leftHint()}`;
		// While a dialog replaces the prompt, Claude shows only `Esc to cancel` — no pills or counters.
		const items = bus.get("dialog") ? [] : this.rightItems();
		let right = "";
		// Drop items left-to-right until the rest fits next to the hint.
		for (let i = 0; i < items.length; i++) {
			const candidate = items.slice(i).join(dim(" · "));
			if (visibleWidth(left) + 2 + visibleWidth(candidate) <= width) {
				right = candidate;
				break;
			}
		}
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return [truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width)];
	}
}

// ---------------------------------------------------------------------------------------------
// 4. "?" shortcuts panel
// ---------------------------------------------------------------------------------------------
const HELP_COLUMNS: readonly (readonly string[])[] = [
	["! for shell mode", "/ for commands", "@ for file paths", "/add-dir for more dirs", "↓ for background tasks", "/workflow for workflows"],
	["double tap esc to clear input", "shift + tab to auto-accept edits", "ctrl + o for verbose output", "ctrl + t to toggle tasks", "esc esc to rewind to a message"],
	[
		"ctrl + _ to undo",
		"ctrl + z to suspend",
		"ctrl + v to paste images",
		"alt + p to switch model",
		"alt + o to toggle fast mode",
		"ctrl + s to stash prompt",
		"ctrl + g to edit in $EDITOR",
		"/keybindings to customize",
	],
];
const HELP_WIDTHS = [24, 35]; // fixed widths, no gap → columns at 2 / 26 / 61

class HelpPanel implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		// Fixed columns 24 / 35; the third column takes the rest and wraps (Claude's auto column).
		const fixed = HELP_WIDTHS.reduce((a, b) => a + b, 0);
		const autoWidth = Math.max(12, width - 2 - fixed);
		const rows = Math.max(...HELP_COLUMNS.map((c) => c.length));
		const out: string[] = [];
		for (let r = 0; r < rows; r++) {
			// Each cell may span several lines (only the auto column wraps).
			const cells = HELP_COLUMNS.map((col, c) => {
				const cell = col[r] ?? "";
				const w = HELP_WIDTHS[c];
				return w === undefined ? wrapTextWithAnsi(cell, autoWidth) : [truncateToWidth(cell, w, "…")];
			});
			const height = Math.max(...cells.map((c) => c.length));
			for (let h = 0; h < height; h++) {
				let line = "  ";
				cells.forEach((cell, c) => {
					const text = cell[h] ?? "";
					const w = HELP_WIDTHS[c];
					line += w === undefined ? text : text.padEnd(w);
				});
				out.push(truncateToWidth(dim(line.trimEnd()), width));
			}
		}
		return out;
	}
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
export function setupChrome(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		local.helpShown = false;
		local.lastEscape = 0;
		local.editorText = "";
		local.hasMessages = ctx.sessionManager.getEntries().some((e) => e.type === "message");
		const model = modelDisplayName(ctx);
		const billing = billingLabel(ctx);
		const cwd = ctx.cwd;

		local.setHelpWidget = (show) =>
			ctx.ui.setWidget("claudio-shortcuts", show ? () => new HelpPanel() : undefined, { placement: "belowEditor" });

		ctx.ui.setHeader((tui) => {
			local.requestRender = () => tui.requestRender();
			return new ClaudioHeader(tui, model, billing, cwd);
		});
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			local.requestRender = () => tui.requestRender();
			return new ClaudioEditor(tui, theme, kb, cwd);
		});
		ctx.ui.setFooter((tui, _theme: Theme, data: ReadonlyFooterDataProvider) => {
			local.requestRender = () => tui.requestRender();
			return new ClaudioFooter(tui, ctx, data, () => pi.getThinkingLevel());
		});
	});

	pi.on("agent_start", (_e, ctx) => {
		local.running = true;
		local.hasMessages = true;
		if (ctx.mode === "tui") local.requestRender();
	});
	pi.on("agent_end", (_e, ctx) => {
		local.running = false;
		if (ctx.mode === "tui") local.requestRender();
	});
}
