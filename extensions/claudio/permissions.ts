/**
 * permissions.ts — permission modes and prompts (inspired by Claude Code).
 *
 * Modes: default | acceptEdits | plan | bypassPermissions (cycled with shift+tab, see setupPermissions).
 * The current mode lives on the shared bus (bus.ts, key "permissionMode").
 *
 * - default:      ask before bash (unless a safe read-only command), edit, write, destructive extension tools
 * - acceptEdits:  auto-approve edit/write, still ask for bash
 * - plan:         block every mutating tool (plan-mode reason), let read-only run
 * - bypass:       approve everything
 *
 * "Don't ask again for <prefix> commands in <cwd>" is remembered for the session and persisted per cwd in
 * `~/.pi/agent/claudio/permissions.json` (see shared.ts `stateDir`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { shiftTabIsFree } from "./setup.ts";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	ANSI,
	BG,
	PERMISSION_MODE_CYCLE,
	type PermissionMode,
	bold,
	bus,
	cyclePermissionMode,
	dim,
	fg,
	getPermissionMode,
	setPermissionMode,
	dialogInnerWidth,
	dialogLines,
	shortenPath,
	stateDir,
	stripAnsi,
	tildify,
} from "./shared.ts";

// ───────────────────────────── colors (palette from shared.ts) ─────────────────────────────

// `FG` / `BG` resolve against the active Pi theme at access time: read them where you render.
const BG_RESET = ANSI.bgReset;
const perm = (s: string) => fg("permission", s);

const errorText = (s: string) => fg("error", s);

// ───────────────────────────── reason texts sent to the model ─────────────────────────────

const REJECTED_REASON =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const PLAN_MODE_HINT =
	"\n\nYou are in plan mode: only read-only tools are available. Research and present a plan to the user; the user must leave plan mode (shift+tab) before you can make changes.";

// ───────────────────────────── tool classification ─────────────────────────────

/** Tools that never mutate anything, regardless of annotations. */
const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"tool_search",
	"workflow_status",
	"workflow_catalog",
	"subagents_inspect",
]);

/** Shell-ish built-ins that need a command classifier. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Safe read-only commands (first word) that never need a prompt. */
const SAFE_COMMANDS = new Set([
	"ls", "cat", "rg", "grep", "egrep", "fgrep", "find", "fd", "pwd", "echo", "printf", "which", "whereis", "type",
	"head", "tail", "wc", "less", "more", "sort", "uniq", "cut", "tr", "diff", "cmp", "file", "stat", "du", "df",
	"tree", "env", "printenv", "uname", "whoami", "id", "date", "cal", "uptime", "ps", "free", "true", "false",
	"test", "[", "basename", "dirname", "realpath", "readlink", "md5sum", "sha256sum", "awk", "sed", "jq", "yq",
	"column", "nl", "tac", "rev", "xxd", "od", "hexdump", "strings", "tput", "locale", "hostname", "nproc", "lsb_release",
]);
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame", "describe", "ls-files", "shortlog", "tag", "stash list", "config --get"]);
const SAFE_CARGO_NPM = new Set(["npm ls", "npm list", "npm view", "npm outdated", "pnpm ls", "pnpm list", "yarn list", "cargo tree", "cargo metadata", "go version", "go env", "node --version", "python --version", "bun --version"]);

/** True when every pipeline segment is an allowlisted read-only command and nothing redirects to a file. */
export function isSafeCommand(command: string): boolean {
	const text = command.trim();
	if (!text) return true;
	if (/[`]|\$\(/.test(text)) return false; // command substitution could hide anything
	// redirections to files (allow 2>&1 and >/dev/null)
	const noSafeRedirect = text.replace(/2>&1/g, "").replace(/[12]?>>?\s*\/dev\/null/g, "");
	if (/(^|[^<])>/.test(noSafeRedirect)) return false;
	const segments = noSafeRedirect.split(/\|\|?|&&|;|\n/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	for (const seg of segments) {
		// strip leading env assignments like FOO=bar cmd
		const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
		const first = words[0] ?? "";
		const firstTwo = `${first} ${words[1] ?? ""}`.trim();
		const firstThree = `${firstTwo} ${words[2] ?? ""}`.trim();
		if (SAFE_COMMANDS.has(first)) {
			if ((first === "sed" || first === "awk") && /\s-i\b/.test(seg)) return false; // in-place edits
			continue;
		}
		if (first === "git" && (SAFE_GIT_SUBCOMMANDS.has(words[1] ?? "") || SAFE_GIT_SUBCOMMANDS.has(`${words[1]} ${words[2]}`))) continue;
		if (SAFE_CARGO_NPM.has(firstTwo) || SAFE_CARGO_NPM.has(firstThree)) continue;
		return false;
	}
	return true;
}

const MULTI_WORD_PREFIX = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "kubectl", "pip", "pip3", "go", "make", "systemctl", "gh", "uv", "poetry", "mise"]);

/** Command prefix used by "don't ask again for <prefix> commands" (first word, or two for git/npm/…). */
export function commandPrefix(command: string): string {
	const words = command.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
	const first = words[0] ?? "";
	const second = words[1];
	if (MULTI_WORD_PREFIX.has(first) && second && !second.startsWith("-")) return `${first} ${second}`;
	return first;
}

type ToolKind = "readonly" | "shell" | "edit" | "write" | "destructive" | "other";

function classifyTool(pi: ExtensionAPI, event: ToolCallEvent): ToolKind {
	const name = event.toolName;
	if (READ_ONLY_TOOLS.has(name)) return "readonly";
	if (SHELL_TOOLS.has(name)) return "shell";
	if (name === "edit") return "edit";
	if (name === "write") return "write";
	const hints = pi.getAllTools().find((t) => t.name === name)?.annotations;
	if (hints?.readOnlyHint) return "readonly";
	if (hints?.destructiveHint === true) return "destructive";
	// MCP tools without annotations default to destructive (same as Claude Code asking for MCP tools)
	if (hints === undefined && name.startsWith("mcp__")) return "destructive";
	return "other";
}

// ───────────────────────────── persistence ─────────────────────────────

interface PersistedState {
	version: 1;
	projects: Record<string, { allowedBashPrefixes: string[] }>;
}

const STATE_FILE = join(stateDir(), "permissions.json");

let persisted: PersistedState | undefined;

function loadPersisted(): PersistedState {
	if (persisted) return persisted;
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<PersistedState>;
		persisted = { version: 1, projects: raw.projects ?? {} };
	} catch {
		persisted = { version: 1, projects: {} };
	}
	return persisted;
}

function savePersisted(): void {
	if (!persisted) return;
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(persisted, null, 2)}\n`);
	} catch {
		// best effort
	}
}

function isPrefixAllowed(cwd: string, prefix: string): boolean {
	return loadPersisted().projects[cwd]?.allowedBashPrefixes.includes(prefix) ?? false;
}

function allowPrefix(cwd: string, prefix: string): void {
	const state = loadPersisted();
	const project = (state.projects[cwd] ??= { allowedBashPrefixes: [] });
	if (!project.allowedBashPrefixes.includes(prefix)) project.allowedBashPrefixes.push(prefix);
	savePersisted();
}

// ───────────────────────────── helpers ─────────────────────────────

function displayPath(path: string, cwd: string): string {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") ? rel : tildify(abs);
}

function padRightTo(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

// ───────────────────────────── diff rendering ─────────────────────────────

interface DiffRow {
	kind: "+" | "-" | " " | "gap";
	lineNo: string;
	content: string;
}

function parseDiffRows(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let offset = 0; // Pi numbers context rows with old numbers; Claude shows new numbers (adds − removes so far)
	for (const line of diff.split("\n")) {
		if (!line) continue;
		const m = /^([+\- ])(\s*\d*)\s(.*)$/.exec(line);
		if (!m) continue;
		const sign = m[1] as "+" | "-" | " ";
		const rawNo = (m[2] ?? "").trim();
		const content = (m[3] ?? "").replace(/\t/g, "   ");
		if (!rawNo && content.trim() === "...") {
			rows.push({ kind: "gap", lineNo: "", content: "" });
			continue;
		}
		if (sign === "+") offset++;
		else if (sign === "-") offset--;
		const lineNo = sign === " " && rawNo ? String(Number(rawNo) + offset) : rawNo;
		rows.push({ kind: sign, lineNo, content });
	}
	return rows;
}

function commonPrefixLen(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}
function commonSuffixLen(a: string, b: string, max: number): number {
	let i = 0;
	while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return i;
}

/** Highlight the changed middle part when exactly one `-` row faces one `+` row. */
function wordHighlight(removed: string, added: string): [string, string] {
	const max = Math.min(removed.length, added.length);
	const pre = commonPrefixLen(removed, added);
	const suf = commonSuffixLen(removed, added, max - pre);
	if (pre + suf === 0) return [removed, added];
	const mark = (s: string, bg: string, back: string) =>
		s.slice(0, pre) + bg + s.slice(pre, s.length - suf) + back + s.slice(s.length - suf);
	return [mark(removed, BG.diffRemovedWord, BG.diffRemoved), mark(added, BG.diffAddedWord, BG.diffAdded)];
}

/** Render diff rows as `  <lineno> <marker>  <code>` lines with Claude's background colors, each exactly `width` cells. */
export function renderClaudioDiff(diff: string, width: number, maxRows = 24): string[] {
	const rows = parseDiffRows(diff);
	const shown = rows.slice(0, maxRows);
	const gutter = Math.max(1, ...shown.map((r) => r.lineNo.length));
	const out: string[] = [];
	// `width` is the box interior (columns - 4); Claude paints the diff `columns - 12` wide.
	const rowWidth = Math.max(10, width - 8);
	for (let i = 0; i < shown.length; i++) {
		const row = shown[i]!;
		if (row.kind === "gap") {
			out.push(`  ${dim("…")}`);
			continue;
		}
		let content = row.content;
		if (row.kind === "-" && shown[i + 1]?.kind === "+" && shown[i - 1]?.kind !== "-" && shown[i + 2]?.kind !== "+") {
			const [r, a] = wordHighlight(row.content, shown[i + 1]!.content);
			content = r;
			shown[i + 1] = { ...shown[i + 1]!, content: a };
		}
		const gutterText = row.lineNo.padStart(gutter);
		const body = `${gutterText} ${row.kind}  ${content}`;
		if (row.kind === " ") {
			out.push(`  ${dim(gutterText)} ${row.kind}  ${truncateToWidth(content, Math.max(1, rowWidth - gutter - 4), "…")}`);
		} else {
			const bg = row.kind === "+" ? BG.diffAdded : BG.diffRemoved;
			out.push(`  ${bg}${padRightTo(body, rowWidth)}${BG_RESET}`);
		}
	}
	if (rows.length > shown.length) out.push(`  ${dim(`… +${rows.length - shown.length} lines`)}`);
	return out;
}

// ───────────────────────────── preview builders ─────────────────────────────

/**
 * `Yes, and don't ask again for <prefix> commands in <cwd>` — the cwd is `~`-abbreviated and then
 * shortened on path segments (`~/…/deep/dir`) so the label fits `maxWidth` (never below 24 cells for the path).
 */
function dontAskAgainLabel(prefix: string, cwd: string, maxWidth: number): string {
	const head = `Yes, and don't ask again for ${prefix} commands in `;
	const room = Math.max(24, maxWidth - visibleWidth(head));
	return `Yes, and don't ask again for ${bold(prefix)} commands in ${bold(shortenPath(cwd, room))}`;
}

interface DialogSpec {
	title: string;
	subtitle?: string;
	/** Body lines for the given inner width (may contain ANSI, must each fit). */
	body: (innerWidth: number) => string[];
	question: string;
	/** Option 2 label (ANSI allowed); a function receives the max label width so long cwds can be shortened. */
	option2: string | ((maxWidth: number) => string);
	/** Option 3 label without the trailing bold "(esc)". */
	option3?: string;
}

function readFileOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Apply exact-text edits sequentially (preview only; the real tool does fuzzy matching). */
function previewEdits(content: string, edits: { oldText: string; newText: string }[]): string | undefined {
	let out = content;
	for (const e of edits) {
		let idx = out.indexOf(e.oldText);
		if (idx < 0) {
			// relaxed: ignore trailing whitespace differences per line
			const norm = (s: string) => s.replace(/[ \t]+$/gm, "");
			const normOut = norm(out);
			idx = normOut.indexOf(norm(e.oldText));
			if (idx < 0) return undefined;
			out = normOut.slice(0, idx) + e.newText + normOut.slice(idx + norm(e.oldText).length);
			continue;
		}
		out = out.slice(0, idx) + e.newText + out.slice(idx + e.oldText.length);
	}
	return out;
}

function bashSpec(command: string, description: string | undefined, cwd: string): DialogSpec {
	const prefix = commandPrefix(command);
	return {
		title: "Bash command",
		body: (w) => {
			const lines: string[] = [];
			// Long commands are clipped with `…` rather than wrapped (one row per command line).
			for (const l of command.split("\n").slice(0, 12)) lines.push(`  ${truncateToWidth(l, Math.max(10, w - 2), "…")}`);
			if (command.split("\n").length > 12) lines.push(`  ${dim("…")}`);
			if (description) for (const wl of wrapTextWithAnsi(description, Math.max(10, w - 2))) lines.push(`  ${dim(wl)}`);
			return lines;
		},
		question: "Do you want to proceed?",
		option2: (max) => dontAskAgainLabel(prefix, cwd, max),
	};
}

function editSpec(path: string, edits: { oldText: string; newText: string }[], cwd: string): DialogSpec {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const name = basename(abs);
	const old = readFileOrUndefined(abs);
	const next = old === undefined ? undefined : previewEdits(old, edits);
	const diff = old !== undefined && next !== undefined ? generateDiffString(old, next).diff : undefined;
	return {
		title: "Edit file",
		subtitle: displayPath(path, cwd),
		body: (w) => {
			if (diff) return renderClaudioDiff(diff, w);
			if (old === undefined) return [errorText("  File not found")];
			const lines: string[] = [];
			for (const e of edits.slice(0, 3)) {
				for (const l of e.oldText.split("\n").slice(0, 6)) lines.push(`  ${BG.diffRemoved}${padRightTo(`-  ${l}`, Math.max(10, w - 2))}${BG_RESET}`);
				for (const l of e.newText.split("\n").slice(0, 6)) lines.push(`  ${BG.diffAdded}${padRightTo(`+  ${l}`, Math.max(10, w - 2))}${BG_RESET}`);
			}
			lines.push(`  ${dim("(exact match not found in file — preview approximate)")}`);
			return lines;
		},
		question: `Do you want to make this edit to ${bold(name)}?`,
		option2: "Yes, allow all edits during this session (shift+tab)",
	};
}

function writeSpec(path: string, content: string, cwd: string): DialogSpec {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const name = basename(abs);
	const exists = existsSync(abs);
	const old = exists ? readFileOrUndefined(abs) : undefined;
	const diff = old !== undefined ? generateDiffString(old, content).diff : generateDiffString("", content).diff;
	return {
		title: exists ? "Overwrite file" : "Create file",
		subtitle: displayPath(path, cwd),
		body: (w) => renderClaudioDiff(diff, w),
		question: `Do you want to ${exists ? "overwrite" : "create"} ${bold(name)}?`,
		option2: "Yes, allow all edits during this session (shift+tab)",
	};
}

function formatParam(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
	const s = JSON.stringify(value) ?? String(value);
	return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function genericSpec(toolName: string, input: Record<string, unknown>, cwd: string): DialogSpec {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
	const display = mcp ? `${mcp[1]} · ${mcp[2]} (MCP)` : toolName;
	return {
		title: "Tool use",
		body: (w) => {
			const lines = [`  ${display}`];
			const params = Object.entries(input).map(([k, v]) => `${k}: ${formatParam(v)}`).join(", ");
			if (params) for (const wl of wrapTextWithAnsi(params, Math.max(10, w - 2)).slice(0, 6)) lines.push(`  ${dim(wl)}`);
			return lines;
		},
		question: "Do you want to proceed?",
		option2: (max) => dontAskAgainLabel(display, cwd, max),
	};
}

// ───────────────────────────── dialog component ─────────────────────────────

type Choice = "yes" | "always" | "no";
interface Decision {
	choice: Choice;
	feedback?: string;
}

class PermissionDialog implements Component, Focusable {
	focused = false;
	private selected = 0;
	private feedbackMode = false;
	private feedback = "";

	constructor(
		private readonly spec: DialogSpec,
		private readonly done: (d: Decision) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done({ choice: "no" });
		if (this.feedbackMode) {
			if (matchesKey(data, "enter")) {
				const text = this.feedback.trim();
				return this.done(text ? { choice: "no", feedback: text } : { choice: "no" });
			}
			if (matchesKey(data, "backspace")) {
				this.feedback = this.feedback.slice(0, -1);
				return;
			}
			if (matchesKey(data, "up")) {
				this.feedbackMode = false;
				this.selected = 1;
				return;
			}
			if (data.length > 0 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) this.feedback += data;
			return;
		}
		if (matchesKey(data, "up")) this.selected = (this.selected + 2) % 3;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % 3;
		else if (matchesKey(data, "enter")) this.choose(this.selected);
		else if (data === "1" || data === "2" || data === "3") this.choose(Number(data) - 1);
	}

	private choose(index: number): void {
		if (index === 0) return this.done({ choice: "yes" });
		if (index === 1) return this.done({ choice: "always" });
		this.selected = 2;
		this.feedbackMode = true; // let the user type what to do differently; enter submits, esc skips
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = dialogInnerWidth(width);
		const body: string[] = [""];
		for (const b of this.spec.body(inner)) body.push(b);
		body.push("");
		body.push(this.spec.question);
		const option2 = typeof this.spec.option2 === "function" ? this.spec.option2(Math.max(24, inner - 5)) : this.spec.option2;
		const labels = [
			"Yes",
			option2,
			`${this.spec.option3 ?? "No, and tell me what to do differently"} ${bold("(esc)")}`,
		];
		labels.forEach((label, i) => {
			const sel = i === this.selected;
			let text: string;
			if (i === 2 && this.feedbackMode) {
				const marker = this.focused ? CURSOR_MARKER : "";
				const placeholder = "and tell me what to do differently";
				// Empty: the cursor sits on the first placeholder character (like the prompt placeholder).
				const typed = this.feedback
					? `${this.feedback}${marker}${renderFakeCursor(" ")}`
					: `${marker}${renderFakeCursor(placeholder.charAt(0))}${dim(placeholder.slice(1))}`;
				text = `${perm("❯ 3. No, ")}${typed}`;
			} else if (sel) {
				text = perm(`❯ ${i + 1}. ${label}`);
			} else {
				text = `  ${i + 1}. ${label}`;
			}
			body.push(text);
		});
		return dialogLines(width, "permission", this.spec.title, this.spec.subtitle, body);
	}
}

// ───────────────────────────── /permissions, /plan ─────────────────────────────

const ALL_MODES: readonly PermissionMode[] = [...new Set<PermissionMode>([...PERMISSION_MODE_CYCLE, "bypassPermissions"])];

const MODE_LABEL: Record<PermissionMode, string> = {
	default: "manual mode",
	acceptEdits: "accept edits",
	plan: "plan mode",
	bypassPermissions: "bypass permissions",
};

function parseMode(arg: string): PermissionMode | undefined {
	const a = arg.trim().toLowerCase().replace(/[\s_-]/g, "");
	if (!a) return undefined;
	if (["default", "manual", "normal", "off"].includes(a)) return "default";
	if (["acceptedits", "accept", "edits", "autoaccept"].includes(a)) return "acceptEdits";
	if (["plan", "planmode"].includes(a)) return "plan";
	if (["bypass", "bypasspermissions", "dangerouslyskippermissions", "skip"].includes(a)) return "bypassPermissions";
	return undefined;
}

// ───────────────────────────── setup ─────────────────────────────

export function setupPermissions(pi: ExtensionAPI): void {
	const sessionBashPrefixes = new Set<string>();
	let dialogChain: Promise<unknown> = Promise.resolve();

	// Plan mode: tell the model why mutating tools are unavailable.
	pi.on("before_agent_start", (event) => {
		if (getPermissionMode() !== "plan") return undefined;
		return { systemPrompt: event.systemPrompt + PLAN_MODE_HINT };
	});

	// shift+tab: Pi reserves it for app.thinking.cycle; registering while reserved is skipped with a startup
	// warning, so only register when keybindings.json freed it (`/claudio setup` does that). Until then
	// /permissions + /plan remain as fallbacks.
	if (shiftTabIsFree()) {
		pi.registerShortcut("shift+tab", {
			description: "Cycle permission mode",
			handler: () => {
				cyclePermissionMode();
			},
		});
	}

	pi.registerCommand("permissions", {
		description: "Show or set the permission mode (default | acceptEdits | plan | bypassPermissions)",
		getArgumentCompletions: (prefix: string) =>
			ALL_MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
		handler: async (args, ctx) => {
			const requested = parseMode(args);
			if (args.trim() && !requested) {
				ctx.ui.notify(`Unknown mode "${args.trim()}". Use default, acceptEdits, plan or bypassPermissions.`, "warning");
				return;
			}
			const mode = requested ?? cyclePermissionMode();
			if (requested) setPermissionMode(requested);
			ctx.ui.notify(`Permission mode: ${MODE_LABEL[mode]}`, "info");
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			const next: PermissionMode = getPermissionMode() === "plan" ? "bypassPermissions" : "plan";
			setPermissionMode(next);
			ctx.ui.notify(next === "plan" ? "Plan mode on" : "Plan mode off", "info");
		},
	});

	const ask = (ctx: ExtensionContext, toolCallId: string, spec: DialogSpec): Promise<Decision> => {
		const run = async (): Promise<Decision> => {
			if (ctx.mode === "tui") {
				bus.set("dialog", { kind: "permission", toolCallId });
				try {
					return await ctx.ui.custom<Decision>((_tui, _theme, _kb, done) => new PermissionDialog(spec, done), { overlay: false });
				} finally {
					bus.set("dialog", null);
				}
			}
			// RPC: plain select with the same labels
			const strip = stripAnsi;
			const option2 = typeof spec.option2 === "function" ? spec.option2(70) : spec.option2;
			const labels = ["Yes", strip(option2), "No, and tell me what to do differently"];
			const picked = await ctx.ui.select(`${spec.title}\n\n${spec.body(70).map(strip).join("\n")}\n\n${strip(spec.question)}`, labels);
			if (picked === labels[0]) return { choice: "yes" };
			if (picked === labels[1]) return { choice: "always" };
			return { choice: "no" };
		};
		const next = dialogChain.then(run, run);
		dialogChain = next.catch(() => undefined);
		return next;
	};

	// A rejection ends the turn: the transcript shows `Interrupted · What should I do
	// instead?` and control returns to the prompt (`terminate: true` stops the agent after this tool
	// batch). Typed feedback is sent as the next user message once the agent is idle, so the model
	// sees the rejected tool result and the feedback together.
	const deny = (ctx: ExtensionContext, feedback?: string): ToolCallEventResult => {
		if (ctx.hasUI && feedback) {
			const send = (tries: number) => {
				if (ctx.isIdle() || tries <= 0) pi.sendUserMessage(feedback);
				else setTimeout(() => send(tries - 1), 100);
			};
			setTimeout(() => send(50), 100);
		}
		return {
			block: true,
			terminate: true,
			reason: feedback ? `${REJECTED_REASON}\n\nThe user said: ${feedback}` : REJECTED_REASON,
		};
	};

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const mode = getPermissionMode();
		if (mode === "bypassPermissions") return undefined;
		const kind = classifyTool(pi, event);
		if (kind === "readonly" || kind === "other") return undefined;
		const input = event.input as Record<string, unknown>;
		const cwd = ctx.cwd;

		if (kind === "shell") {
			const command = String(input.command ?? "");
			if (isSafeCommand(command)) return undefined;
			if (mode === "plan") return { block: true, reason: `Cannot call ${event.toolName === "bash" ? "Bash" : event.toolName} while in plan mode.${PLAN_MODE_HINT}` };
			const prefix = commandPrefix(command);
			if (sessionBashPrefixes.has(prefix) || isPrefixAllowed(cwd, prefix)) return undefined;
			if (!ctx.hasUI) return undefined; // print/json mode: approve
			const description = typeof input.description === "string" ? input.description : undefined;
			const decision = await ask(ctx, event.toolCallId, bashSpec(command, description, cwd));
			if (decision.choice === "always") {
				sessionBashPrefixes.add(prefix);
				allowPrefix(cwd, prefix);
			}
			return decision.choice === "no" ? deny(ctx, decision.feedback) : undefined;
		}

		if (kind === "edit" || kind === "write") {
			const path = String(input.path ?? "");
			if (mode === "plan") return { block: true, reason: `Cannot write to ${displayPath(path, cwd)} while in plan mode.${PLAN_MODE_HINT}` };
			if (mode === "acceptEdits") return undefined;
			if (!ctx.hasUI) return undefined;
			const spec =
				kind === "edit"
					? editSpec(path, Array.isArray(input.edits) ? (input.edits as { oldText: string; newText: string }[]) : [], cwd)
					: writeSpec(path, String(input.content ?? ""), cwd);
			const decision = await ask(ctx, event.toolCallId, spec);
			if (decision.choice === "always") setPermissionMode("acceptEdits");
			return decision.choice === "no" ? deny(ctx, decision.feedback) : undefined;
		}

		// destructive extension / MCP tool
		if (mode === "plan") return { block: true, reason: `Cannot call ${event.toolName} while in plan mode.${PLAN_MODE_HINT}` };
		const key = `tool:${event.toolName}`;
		if (sessionBashPrefixes.has(key) || isPrefixAllowed(cwd, key)) return undefined;
		if (!ctx.hasUI) return undefined;
		const decision = await ask(ctx, event.toolCallId, genericSpec(event.toolName, input, cwd));
		if (decision.choice === "always") {
			sessionBashPrefixes.add(key);
			allowPrefix(cwd, key);
		}
		return decision.choice === "no" ? deny(ctx, decision.feedback) : undefined;
	});
}
