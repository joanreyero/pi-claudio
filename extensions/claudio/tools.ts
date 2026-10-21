/**
 * Tool rendering for every tool call in the transcript (● / ⎿ rows inspired by Claude Code).
 *
 * Registers RENDERERS only (`pi.registerToolRenderer` with `renderShell: "self"`); no tool is
 * registered or replaced here. Shape of every row:
 *
 *   ● ToolName(args summary)
 *     ⎿  result summary
 *        extra result lines, indented 5
 *        … +N lines (ctrl+o to expand)
 *
 * Bullet colour: claudio orange while running, success green when done, error red on failure.
 * The bullet is the first character of the call line (after `context.outputPad` spaces).
 *
 * Colours, glyph constants and formatting helpers come from `shared.ts`.
 */
import type {
	AgentToolResult,
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ToolDefinition,
	ToolRenderers,
	ToolRenderResultOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, getReadmePath, highlightCode, keyText } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getCapabilities, getImageDimensions, imageFallback, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AskDetails } from "./ask.ts";
import { ANSI, BG, RESULT_INDENT, bold, bus, dim, fg, formatDuration, formatTokens, moreLines, pluralize as plural, relPath as sharedRelPath } from "./shared.ts";

// ───────────────────────────── Shared helpers ─────────────────────────────

// Colours come from the active Pi theme via shared.ts: `FG`/`BG` are live getters, so they are read
// at render time rather than cached here (a `/settings` theme switch must repaint on the next render).
const BG_RESET = ANSI.bgReset;

const orange = (s: string): string => fg("claudio", s);
const green = (s: string): string => fg("success", s);
const red = (s: string): string => fg("error", s);

// ───────────────────────────── Types ─────────────────────────────

type RenderCtx<TState = unknown> = Parameters<NonNullable<ToolDefinition<any, any, TState>["renderCall"]>>[2] & {
	args: unknown;
	state: TState;
};

type RowStatus = "running" | "ok" | "error";

interface RowState {
	/** Set by renderResult, read lazily by the call row at render time (both renderers run before render). */
	status?: RowStatus;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	/** Call-row argument text learnt from the result (e.g. the PR number resolved from the branch). */
	label?: string;
}

type AnyResult = AgentToolResult<any>;
type Rec = Record<string, unknown>;

const PREVIEW_LINES = 3;
const DIFF_COLLAPSED_LINES = 40;
/** A running row that has not been rendered for this long is considered detached. */
const DETACHED_AFTER_MS = 5000;

// ───────────────────────────── Lazy line component ─────────────────────────────

/** A component whose lines are built at render time, so it can read row state set after the renderer ran. */
class LazyLines implements Component {
	private build: (width: number) => string[] = () => [];
	private cache: { width: number; lines: string[] } | undefined;
	/** Last time Pi asked us to render — lets the partial-result ticker notice a detached component. */
	lastRenderAt = Date.now();

	set(build: (width: number) => string[]): void {
		this.build = build;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		this.lastRenderAt = Date.now();
		if (!this.cache || this.cache.width !== width) {
			this.cache = { width, lines: this.build(Math.max(1, width)) };
		}
		return this.cache.lines;
	}
}

function lazy(ctx: RenderCtx<RowState>): LazyLines {
	return ctx.lastComponent instanceof LazyLines ? ctx.lastComponent : new LazyLines();
}

// ───────────────────────────── Small text helpers ─────────────────────────────

function textOf(result: { content: (TextContent | ImageContent)[] } | undefined, showImages: boolean): string {
	if (!result) return "";
	const text = result.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => (c.text ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, ""))
		.join("\n");
	const images = result.content.filter((c): c is ImageContent => c.type === "image");
	if (images.length === 0 || (getCapabilities().images && showImages)) return text;
	const placeholders = images
		.map((img) => {
			const mime = img.mimeType ?? "image/unknown";
			const dims = img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
			return imageFallback(mime, dims);
		})
		.join("\n");
	return text ? `${text}\n${placeholders}` : placeholders;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? (JSON.stringify(v) ?? "") : String(v);
}

function replaceTabs(s: string): string {
	return s.replace(/\t/g, "   ");
}

function relPath(path: string, cwd: string): string {
	return path ? sharedRelPath(cwd, path) : "";
}

function expandHint(): string {
	return `(${keyText("app.tools.expand")} to expand)`;
}

function moreLinesHint(hidden: number): string {
	return dim(`${moreLines(hidden)} ${expandHint()}`);
}

/** Split lines into shown + hidden count. A 1-line overflow is shown in full (Claude Code behaviour). */
function preview(lines: string[], expanded: boolean, max: number, keep: "start" | "end" = "start"): { shown: string[]; hidden: number } {
	if (expanded || lines.length <= max + 1) return { shown: lines, hidden: 0 };
	return keep === "start" ? { shown: lines.slice(0, max), hidden: lines.length - max } : { shown: lines.slice(-max), hidden: lines.length - max };
}

/** Strip Pi's trailing bracket notice (`\n\n[Showing lines …]`) and return it separately. */
function splitNotice(text: string): { body: string; notice: string | undefined } {
	const m = /\n\n(\[[^\n]*\])\s*$/.exec(text);
	if (!m || m.index === undefined) return { body: text, notice: undefined };
	return { body: text.slice(0, m.index), notice: m[1] };
}

/**
 * True only for Pi's own abort/rejection texts (not for a genuine tool error that merely mentions
 * "aborted"): the whole text is one of the abort sentences, or it is a permission rejection.
 */
function isInterrupted(text: string): boolean {
	const t = text.trim();
	if (/doesn't want to proceed|user rejected/i.test(t)) return true;
	return /^(?:error:\s*)?(?:command aborted|operation aborted|the operation was aborted\.?|request was aborted|aborted|interrupted)\.?$/i.test(t);
}

const INTERRUPTED_LINE = dim("Interrupted · What should I do instead?");

// ───────────────────────────── Row building blocks ─────────────────────────────

function bulletFor(status: RowStatus): string {
	return status === "ok" ? green("●") : status === "error" ? red("●") : orange("●");
}

function statusOf(ctx: RenderCtx<RowState>): RowStatus {
	return ctx.state.status ?? "running";
}

/**
 * The call row: `● Name(args)`. Args are truncated to `width - 2 - len(name) - 2` (min 20).
 * Multi-line args (heredoc commands) continue on following lines indented 2.
 */
/** A command in a call row shows at most 2 lines / 160 chars, then `…`. */
const CALL_MAX_LINES = 2;
const CALL_MAX_CHARS = 160;
export function clipCommand(command: string, maxLines = CALL_MAX_LINES, maxChars = CALL_MAX_CHARS): string {
	let text = command;
	let clipped = false;
	const lines = text.split("\n");
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		clipped = true;
	}
	if (text.length > maxChars) {
		text = text.slice(0, maxChars);
		clipped = true;
	}
	return clipped ? `${text.trimEnd()}…` : text;
}

function callLines(width: number, pad: number, status: RowStatus, name: string, args: string, extra?: string): string[] {
	const padStr = " ".repeat(pad);
	const argLines = clipCommand(args).split("\n");
	const first = argLines[0] ?? "";
	const budget = Math.max(20, width - pad - 2 - visibleWidth(name) - 2);
	const out: string[] = [];
	if (argLines.length === 1) {
		out.push(truncateToWidth(`${padStr}${bulletFor(status)} ${bold(name)}(${truncateToWidth(first, budget, "…")})`, width));
	} else {
		out.push(truncateToWidth(`${padStr}${bulletFor(status)} ${bold(name)}(${truncateToWidth(first, budget, "…")}`, width));
		const rest = argLines.slice(1);
		for (let i = 0; i < rest.length; i++) {
			const tail = i === rest.length - 1 ? ")" : "";
			out.push(truncateToWidth(`${padStr}  ${replaceTabs(rest[i] ?? "")}${tail}`, width, "…"));
		}
	}
	if (extra) out.push(truncateToWidth(`${padStr}  ${dim(extra)}`, width, "…"));
	return out;
}

/**
 * Result rows: first line `  ⎿  text`, continuation lines indented 5. Each logical line is wrapped to
 * the available width with a hanging indent so nothing overflows.
 */
function resultLines(width: number, pad: number, lines: string[], opts: { wrap?: boolean } = {}): string[] {
	const padStr = " ".repeat(pad);
	const firstPrefix = `${padStr}  ${dim("⎿")}  `;
	const contPrefix = `${padStr}${RESULT_INDENT}`;
	const inner = Math.max(10, width - pad - RESULT_INDENT.length);
	const out: string[] = [];
	let first = true;
	for (const line of lines) {
		const pieces = opts.wrap === false ? [truncateToWidth(line, inner, "…")] : wrapTextWithAnsi(line, inner);
		if (pieces.length === 0) pieces.push("");
		for (const piece of pieces) {
			out.push(truncateToWidth(`${first ? firstPrefix : contPrefix}${piece}`, width));
			first = false;
		}
	}
	return out;
}

function errorLines(text: string): string[] {
	const t = text.trim();
	if (!t) return [red("Error")];
	if (isInterrupted(t)) return [INTERRUPTED_LINE];
	return t.split("\n").map((l) => red(l));
}

function withPreview(width: number, pad: number, header: string | undefined, body: string[], expanded: boolean, max = PREVIEW_LINES): string[] {
	const { shown, hidden } = preview(body, expanded, max);
	const lines = header === undefined ? [...shown] : [header, ...shown];
	if (hidden > 0) lines.push(moreLinesHint(hidden));
	return resultLines(width, pad, lines);
}

function markStatus(ctx: RenderCtx<RowState>, options: ToolRenderResultOptions): void {
	ctx.state.status = options.isPartial ? "running" : ctx.isError ? "error" : "ok";
}

function startTimer(ctx: RenderCtx<RowState>): void {
	if (ctx.executionStarted && ctx.state.startedAt === undefined) ctx.state.startedAt = Date.now();
}

/** Keep a 1 s clock ticking while the result is partial; stop it as soon as the result is final. */
function tickWhilePartial(ctx: RenderCtx<RowState>, isPartial: boolean): void {
	if (isPartial && !ctx.state.timer) {
		const t = setInterval(() => {
			// Stop ticking when the component was discarded mid-run (/new, branch switch): nobody renders it anymore.
			const comp = ctx.lastComponent;
			const stale = comp instanceof LazyLines && Date.now() - comp.lastRenderAt > DETACHED_AFTER_MS;
			if (stale) {
				clearInterval(t);
				if (ctx.state.timer === t) ctx.state.timer = undefined;
				return;
			}
			ctx.invalidate();
		}, 1000);
		t.unref?.();
		ctx.state.timer = t;
	}
	if (!isPartial && ctx.state.timer) {
		clearInterval(ctx.state.timer);
		ctx.state.timer = undefined;
	}
	if (!isPartial) permissionClosedAt.delete(ctx.toolCallId);
}

/** When each call's permission dialog closed: that call's running clock excludes the time waiting for the user. */
const permissionClosedAt = new Map<string, number>();
bus.subscribe("dialog", (current, previous) => {
	if (current === null && previous?.kind === "permission") permissionClosedAt.set(previous.toolCallId, Date.now());
});

function elapsed(ctx: RenderCtx<RowState>): string {
	if (ctx.state.startedAt === undefined) return "";
	const approvedAt = permissionClosedAt.get(ctx.toolCallId) ?? 0;
	return formatDuration(Date.now() - Math.max(ctx.state.startedAt, approvedAt));
}


function highlighted(text: string, path: string | undefined): string[] {
	const lang = path ? getLanguageFromPath(path) : undefined;
	try {
		return highlightCode(replaceTabs(text), lang);
	} catch {
		return replaceTabs(text).split("\n");
	}
}

function argsSummary(args: unknown, keys?: string[], rename: Record<string, string> = {}): string {
	if (args == null || typeof args !== "object" || Array.isArray(args)) return str(args);
	const entries = Object.entries(args as Rec).filter(([, v]) => v !== undefined && v !== null && v !== "");
	const ordered = keys ? [...keys.map((k) => entries.find(([key]) => key === k)).filter((e): e is [string, unknown] => !!e), ...entries.filter(([k]) => !keys.includes(k))] : entries;
	return ordered
		.map(([k, v]) => `${rename[k] ?? k}: ${typeof v === "string" ? JSON.stringify(v.replace(/\s+/g, " ")) : (JSON.stringify(v) ?? String(v))}`)
		.join(", ");
}

// ───────────────────────────── Read ─────────────────────────────

// pi has no Skill tool: the model loads a skill by reading its SKILL.md, and pi's own read
// renderer shows that as `[skill] <name>`. Show it as Claude's `● Skill(<name>)` row.
function skillName(path: string): string | undefined {
	const parts = path.split(/[\\/]/);
	if (parts.length < 2 || parts[parts.length - 1] !== "SKILL.md") return undefined;
	return parts[parts.length - 2] || undefined;
}

// pi's read renderer also names two other kinds of read instead of showing a bare path:
// its own docs (`read docs docs/skills.md`) and the instruction files it loads as context
// (`read resource AGENTS.md`). Keep both as their own rows.
const INSTRUCTION_FILES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

function piDocsPath(absolute: string): string | undefined {
	let root: string;
	try {
		root = dirname(getReadmePath());
	} catch {
		return undefined;
	}
	const rel = relative(root, absolute);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	const label = rel.split(sep).join("/");
	return label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/") ? label : undefined;
}

function readRow(path: string, cwd: string): { name: string; args: string } {
	const skill = skillName(path);
	if (skill) return { name: "Skill", args: skill };
	const shown = relPath(path, cwd) || "…";
	if (!path) return { name: "Read", args: shown };
	const absolute = resolve(cwd, path);
	const docs = piDocsPath(absolute);
	if (docs) return { name: "Read pi docs", args: docs };
	if (INSTRUCTION_FILES.has(basename(absolute))) return { name: "Read instructions", args: shown };
	return { name: "Read", args: shown };
}

function readRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const args = (rawArgs ?? {}) as { path?: string };
			startTimer(ctx);
			const c = lazy(ctx);
			const row = readRow(str(args.path), ctx.cwd);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), row.name, row.args));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			const cargs = (ctx.args ?? {}) as { path?: string; offset?: number };
			markStatus(ctx, options);
			const c = lazy(ctx);
			if (options.isPartial) {
				c.set(() => []);
				return c;
			}
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				// Claude's Read reports a missing file as `File does not exist.`
				const lines = /ENOENT|no such file/i.test(raw) ? [red("File does not exist.")] : errorLines(raw);
				c.set((w) => resultLines(w, ctx.outputPad, lines));
				return c;
			}
			const hasImage = result.content.some((b) => b.type === "image");
			if (hasImage) {
				const mime = result.content.find((b): b is ImageContent => b.type === "image")?.mimeType ?? "image";
				c.set((w) => resultLines(w, ctx.outputPad, [`Read image (${mime})`]));
				return c;
			}
			const { body: rawBody, notice } = splitNotice(raw);
			const body = rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody;
			const lines = body === "" ? [] : body.split("\n");
			const n = lines.length;
			const path = str(cargs.path);
			const header = skillName(path) ? "Successfully loaded skill" : `Read ${bold(String(n))} ${n === 1 ? "line" : "lines"}`;
			const offset = typeof cargs.offset === "number" && cargs.offset > 0 ? cargs.offset : 1;
			c.set((w) => {
				if (n === 0) return resultLines(w, ctx.outputPad, [header]);
				if (!options.expanded) return resultLines(w, ctx.outputPad, [`${header} ${dim(expandHint())}`]);
				const code = highlighted(body, path);
				const gutter = String(offset + n - 1).length;
				const out: string[] = [header];
				for (let i = 0; i < code.length; i++) {
					out.push(`${dim(String(offset + i).padStart(gutter))}${dim("→")}${code[i] ?? ""}`);
				}
				if (notice) out.push(dim(notice));
				return resultLines(w, ctx.outputPad, out, { wrap: false });
			});
			return c;
		},
	};
}

// ───────────────────────────── Bash ─────────────────────────────

interface BackgroundDetails {
	id?: string;
	shellId?: string;
	shell_id?: string;
	status?: string;
	exitCode?: number;
	byUser?: boolean;
	wake?: boolean;
	title?: string;
}

function backgroundOf(details: unknown): BackgroundDetails | undefined {
	if (!details || typeof details !== "object") return undefined;
	const bg = (details as Rec).background;
	if (bg === undefined || bg === null || bg === false) return undefined;
	if (typeof bg === "string") return { id: bg };
	if (typeof bg === "object") return bg as BackgroundDetails;
	return {};
}

function bashRenderers(label: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const args = (rawArgs ?? {}) as { command?: string; description?: string };
			startTimer(ctx);
			const c = lazy(ctx);
			const command = str(args.command).trim() || "…";
			const description = typeof args.description === "string" ? args.description.trim() : "";
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), label, command, description || undefined));
			return c;
		},
		renderResult(result: AgentToolResult<(BashToolDetails & { background?: unknown }) | undefined>, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			const c = lazy(ctx);
			const bg = backgroundOf(result.details);
			if (bg) {
				tickWhilePartial(ctx, false);
				const id = bg.id ?? bg.shellId ?? bg.shell_id;
				// Claude: model-started → `(down to manage)`; moved by the user with ctrl+b → shows the id.
				const line =
					bg.status === "completed" || bg.status === "done"
						? "Done"
						: bg.wake
							? `Running in the background · wakes on output and exit${bg.title && bg.title !== str((ctx.args as Rec | undefined)?.command) ? ` · ${bg.title}` : ""} (down to manage)`
							: bg.byUser && id
								? `Command running in background (shell id: ${id})`
								: "Running in the background (down to manage)";
				c.set((w) => resultLines(w, ctx.outputPad, [dim(line)]));
				return c;
			}
			tickWhilePartial(ctx, options.isPartial);
			let text = textOf(result, ctx.showImages);
			// Pull Pi's structural suffixes out of the output.
			let exitCode: number | undefined;
			const exit = /\n*Command exited with code (\d+)\s*$/.exec(text);
			if (exit) {
				exitCode = Number(exit[1]);
				text = text.slice(0, exit.index);
			}
			const aborted = /\n*Command aborted\s*$/.test(text);
			if (aborted) text = text.replace(/\n*Command aborted\s*$/, "");
			const timeout = /\n*(Command timed out after \d+ seconds)\s*$/.exec(text);
			if (timeout) text = text.slice(0, timeout.index);
			const { body, notice } = splitNotice(text);
			const fullOutputPath = result.details?.fullOutputPath;
			const trimmed = body.replace(/\s+$/, "");
			const noOutput = trimmed === "" || trimmed === "(no output)";
			const outLines = noOutput ? [] : trimmed.split("\n").map(replaceTabs);
			// Claude: grep-family exit 1 with no output is "no matches", diff/cmp exit 1 is "files differ" — not errors.
			const firstWord = (str((ctx.args as { command?: string } | undefined)?.command).trim().split(/\s+/)[0] ?? "").replace(/^.*\//, "");
			const softExit1 = exitCode === 1 && noOutput && !options.isPartial
				? /^(grep|rg|egrep|fgrep|findstr)$/.test(firstWord)
					? "No matches found"
					: /^(diff|cmp)$/.test(firstWord)
						? "Files differ"
						: undefined
				: undefined;
			if (softExit1) ctx.state.status = "ok";

			c.set((w) => {
				if (options.isPartial) {
					// Dim `(ctrl+b to run in background)` under the running row
					// (`ctrl+b ctrl+b (twice)` under tmux, where ctrl+b is the prefix key).
					const chord = process.env.TMUX ? "ctrl+b ctrl+b (twice)" : "ctrl+b";
					const hint = dim(`(${chord} to run in background)`);
					if (outLines.length === 0) return resultLines(w, ctx.outputPad, [dim(`Running… ${elapsed(ctx)}`.trim()), hint]);
					// Dim tail first, then `+N lines <elapsed>` (no ellipsis, no expand hint).
					const { shown, hidden } = preview(outLines, options.expanded, PREVIEW_LINES, "end");
					const lines = shown.map((l) => dim(l));
					if (hidden > 0) lines.push(dim(`+${plural(hidden, "line")} ${elapsed(ctx)}`.trim()));
					lines.push(hint);
					return resultLines(w, ctx.outputPad, lines);
				}
				if (softExit1) return resultLines(w, ctx.outputPad, [dim(softExit1)]);
				if (ctx.isError) {
					// A blocked/rejected call has no exit code: Pi puts the deny reason in the output text.
					if (aborted || (exitCode === undefined && isInterrupted(trimmed))) {
						return resultLines(w, ctx.outputPad, [INTERRUPTED_LINE]);
					}
					const lines: string[] = [];
					if (timeout) lines.push(red(timeout[1] ?? "Command timed out"));
					if (outLines.length > 0) {
						const { shown, hidden } = preview(outLines, options.expanded, PREVIEW_LINES);
						shown.forEach((l, i) => lines.push(red(i === 0 && !timeout ? `Error: ${l}` : l)));
						if (hidden > 0) lines.push(moreLinesHint(hidden));
						// Claude prints the exit code only when there is no output to show.
					} else if (exitCode !== undefined) {
						lines.push(dim(`Exit code ${exitCode}`));
					} else if (lines.length === 0) {
						lines.push(red("Error"));
					}
					return resultLines(w, ctx.outputPad, lines);
				}
				if (outLines.length === 0) return resultLines(w, ctx.outputPad, [dim("(No output)")]);
				const { shown, hidden } = preview(outLines, options.expanded, PREVIEW_LINES);
				const lines = [...shown];
				if (hidden > 0) lines.push(moreLinesHint(hidden));
				if (options.expanded && (notice || fullOutputPath)) lines.push(dim(notice ?? `[Full output: ${fullOutputPath}]`));
				return resultLines(w, ctx.outputPad, lines);
			});
			return c;
		},
	};
}

// ───────────────────────────── Edit (Update) ─────────────────────────────

interface DiffRow {
	kind: "add" | "remove" | "context" | "gap";
	lineNo: string;
	text: string;
}

/** Parse Pi's `generateDiffString` output: `<sign><lineNo padded><space><content>` / gap lines ` … ...`. */
function parseDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	// Pi numbers context rows with OLD line numbers; Claude uses NEW numbers for `+` and context rows.
	let offset = 0; // new − old so far (adds − removes)
	for (const raw of diff.replace(/\r/g, "").split("\n")) {
		if (raw === "") continue;
		const m = /^([+\- ])(\s*)(\d*)\s(.*)$/.exec(raw);
		if (!m) {
			rows.push({ kind: "gap", lineNo: "", text: raw.trim() });
			continue;
		}
		const sign = m[1];
		const lineNo = m[3] ?? "";
		const text = m[4] ?? "";
		if (lineNo === "" && sign === " " && text.trim() === "...") {
			rows.push({ kind: "gap", lineNo: "", text: "…" });
			continue;
		}
		if (sign === "+") offset++;
		else if (sign === "-") offset--;
		const shown = sign === " " && lineNo !== "" ? String(Number(lineNo) + offset) : lineNo;
		rows.push({ kind: sign === "+" ? "add" : sign === "-" ? "remove" : "context", lineNo: shown, text: replaceTabs(text) });
	}
	return rows;
}

/** Word-level highlight of the changed middle when one removed line faces one added line. */
function wordHighlight(oldText: string, newText: string): { old: string; new: string } {
	const a = oldText.split(/(\s+)/);
	const b = newText.split(/(\s+)/);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	if (prefix === 0 && suffix === 0) return { old: oldText, new: newText };
	const wrap = (parts: string[], bg: string, rowBg: string): string => {
		const head = parts.slice(0, prefix).join("");
		const mid = parts.slice(prefix, parts.length - suffix).join("");
		const tail = parts.slice(parts.length - suffix).join("");
		return mid ? `${head}${bg}${mid}${rowBg}${tail}` : head + tail;
	};
	return { old: wrap(a, BG.diffRemovedWord, BG.diffRemoved), new: wrap(b, BG.diffAddedWord, BG.diffAdded) };
}

function diffLines(diff: string, innerWidth: number, expanded: boolean): string[] {
	const rows = parseDiff(diff);
	const gutter = Math.max(1, ...rows.map((r) => r.lineNo.length));
	// Apply word highlights to isolated -/+ pairs.
	const texts = rows.map((r) => r.text);
	for (let i = 0; i + 1 < rows.length; i++) {
		const cur = rows[i]!;
		const next = rows[i + 1]!;
		const prevKind = rows[i - 1]?.kind;
		const afterKind = rows[i + 2]?.kind;
		if (cur.kind === "remove" && next.kind === "add" && prevKind !== "remove" && afterKind !== "add") {
			const h = wordHighlight(cur.text, next.text);
			texts[i] = h.old;
			texts[i + 1] = h.new;
		}
	}
	const out: string[] = [];
	const visible = expanded ? rows.length : Math.min(rows.length, DIFF_COLLAPSED_LINES);
	for (let i = 0; i < visible; i++) {
		const row = rows[i]!;
		if (row.kind === "gap") {
			out.push(dim(`${" ".repeat(gutter)}  ${row.text}`));
			continue;
		}
		const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
		const num = row.lineNo.padStart(gutter);
		const content = `${num} ${marker}  ${texts[i] ?? ""}`;
		if (row.kind === "context") {
			out.push(`${dim(num)} ${marker}  ${truncateToWidth(texts[i] ?? "", Math.max(1, innerWidth - gutter - 4), "…")}`);
			continue;
		}
		const bg = row.kind === "add" ? BG.diffAdded : BG.diffRemoved;
		out.push(`${bg}${truncateToWidth(content, innerWidth, "…", true)}${BG_RESET}`);
	}
	if (visible < rows.length) out.push(dim(`… ${plural(rows.length - visible, "more line")} ${expandHint()}`));
	return out;
}

function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of parseDiff(diff)) {
		if (row.kind === "add") added++;
		else if (row.kind === "remove") removed++;
	}
	return { added, removed };
}

function editRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const args = (rawArgs ?? {}) as { path?: string; file_path?: string };
			startTimer(ctx);
			const c = lazy(ctx);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), "Update", relPath(str(args.path ?? args.file_path), ctx.cwd) || "…"));
			return c;
		},
		renderResult(result: AgentToolResult<EditToolDetails | undefined>, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			const cargs = (ctx.args ?? {}) as { path?: string; file_path?: string };
			markStatus(ctx, options);
			const c = lazy(ctx);
			if (options.isPartial) {
				c.set(() => []);
				return c;
			}
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(raw)));
				return c;
			}
			const path = relPath(str(cargs.path ?? cargs.file_path), ctx.cwd);
			const diff = result.details?.diff ?? "";
			const { added, removed } = countDiff(diff);
			const parts = [added > 0 ? plural(added, "addition") : "", removed > 0 ? plural(removed, "removal") : ""].filter(Boolean);
			const header = `Updated ${bold(path)}${parts.length ? ` with ${parts.join(" and ")}` : ""}`;
			c.set((w) => {
				// Claude's diff block (`cY`) is `columns - 12` wide: the bg bar stops 7 cells short of the edge.
				const inner = Math.max(10, w - ctx.outputPad - 13);
				const lines = [header];
				// Diff rows sit one cell further right than the header.
				if (diff) lines.push(...diffLines(diff, inner, options.expanded).map((l) => ` ${l}`));
				else if (raw.trim()) lines.push(dim(raw.trim()));
				return resultLines(w, ctx.outputPad, lines, { wrap: false });
			});
			return c;
		},
	};
}

// ───────────────────────────── Write ─────────────────────────────

function writeRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const args = (rawArgs ?? {}) as { path?: string; file_path?: string };
			startTimer(ctx);
			const c = lazy(ctx);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), "Write", relPath(str(args.path ?? args.file_path), ctx.cwd) || "…"));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			const cargs = (ctx.args ?? {}) as { path?: string; file_path?: string; content?: string };
			markStatus(ctx, options);
			const c = lazy(ctx);
			if (options.isPartial) {
				c.set(() => []);
				return c;
			}
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(raw)));
				return c;
			}
			const rawPath = str(cargs.path ?? cargs.file_path);
			const path = relPath(rawPath, ctx.cwd);
			const content = str(cargs.content);
			const body = content.endsWith("\n") ? content.slice(0, -1) : content;
			const n = body === "" ? 0 : body.split("\n").length;
			const header = `Wrote ${bold(String(n))} ${n === 1 ? "line" : "lines"} to ${bold(path)}`;
			c.set((w) => {
				const code = n === 0 ? [] : highlighted(body, rawPath);
				return withPreview(w, ctx.outputPad, header, code, options.expanded);
			});
			return c;
		},
	};
}

// ───────────────────────────── Grep / Find / Ls ─────────────────────────────

function searchRenderers(kind: "grep" | "find"): ToolRenderers {
	const keys = kind === "grep" ? ["pattern", "glob", "path", "ignoreCase", "literal", "context", "limit"] : ["pattern", "path", "limit"];
	// Pi's parameter names → the Claude tool's names (`Search(pattern: "x", -i: true, head_limit: 20)`).
	const rename: Record<string, string> = kind === "grep" ? { ignoreCase: "-i", context: "-C", limit: "head_limit", literal: "fixed_strings" } : { limit: "head_limit" };
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			startTimer(ctx);
			const c = lazy(ctx);
			const summary = argsSummary(rawArgs, keys, rename);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), "Search", summary || "…"));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			const c = lazy(ctx);
			if (options.isPartial) {
				c.set(() => []);
				return c;
			}
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(raw)));
				return c;
			}
			const { body, notice } = splitNotice(raw);
			const trimmed = body.trim();
			const none = trimmed === "" || /^No (matches|files) found/i.test(trimmed);
			if (none) {
				c.set((w) => resultLines(w, ctx.outputPad, [dim(kind === "grep" ? "No matches found" : "No files found")]));
				return c;
			}
			const lines = trimmed.split("\n").map(replaceTabs);
			let header: string;
			if (kind === "find") {
				header = `Found ${bold(String(lines.length))} ${lines.length === 1 ? "file" : "files"}`;
			} else {
				const files = new Set(lines.map((l) => l.split(":")[0] ?? l).filter(Boolean));
				header = `Found ${bold(String(lines.length))} ${lines.length === 1 ? "line" : "lines"} across ${bold(String(files.size))} ${files.size === 1 ? "file" : "files"}`;
			}
			c.set((w) => {
				const out = withPreview(w, ctx.outputPad, header, lines, options.expanded);
				if (notice && options.expanded) out.push(...resultLines(w, ctx.outputPad, [dim(notice)]).map((l) => l.replace(/⎿/, " ")));
				return out;
			});
			return c;
		},
	};
}

function lsRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const args = (rawArgs ?? {}) as { path?: string };
			startTimer(ctx);
			const c = lazy(ctx);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), "List", relPath(str(args.path), ctx.cwd) || "."));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			const c = lazy(ctx);
			if (options.isPartial) {
				c.set(() => []);
				return c;
			}
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(raw)));
				return c;
			}
			const { body } = splitNotice(raw);
			const trimmed = body.trim();
			const lines = trimmed === "" || trimmed === "(empty directory)" ? [] : trimmed.split("\n");
			const header = `Listed ${bold(String(lines.length))} ${lines.length === 1 ? "path" : "paths"}`;
			c.set((w) => {
				if (!options.expanded) return resultLines(w, ctx.outputPad, [lines.length ? `${header} ${dim(expandHint())}` : header]);
				return resultLines(w, ctx.outputPad, [header, ...lines], { wrap: false });
			});
			return c;
		},
	};
}

// ───────────────────────────── Task (pi-extensible-workflows) ─────────────────────────────

const TASK_TOOLS = new Set([
	"workflow",
	"workflow_respond",
	"workflow_stop",
	"workflow_status",
	"workflow_retry",
	"workflow_resume",
	"workflow_catalog",
	"subagents_run",
	"subagents_inspect",
	"subagents_steer",
	"subagents_stop",
	"subagents_retry",
]);

function firstLine(s: string): string {
	return s.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

function taskLabel(toolName: string, rawArgs: unknown): string {
	const a = (rawArgs ?? {}) as Rec;
	switch (toolName) {
		case "subagents_run":
			return str(a.label) || firstLine(str(a.prompt)) || "…";
		case "workflow":
			return str(a.name) || str(a.description) || "…";
		case "workflow_catalog":
			return "catalog";
		case "subagents_inspect":
			return a.id ? `inspect ${str(a.id)}` : "inspect";
		default: {
			const verb = toolName.replace(/^(workflow|subagents)_/, "");
			const id = str(a.id ?? a.runId);
			return [verb, id].filter(Boolean).join(" ") || verb;
		}
	}
}

function obj(v: unknown): Rec | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Summarise an `AgentAccounting`-like object as `12.4k tokens`. */
function tokensOf(v: unknown): string | undefined {
	const acc = obj(v);
	if (!acc) return undefined;
	const total = (num(acc.input) ?? 0) + (num(acc.output) ?? 0) + (num(acc.cacheRead) ?? 0) + (num(acc.cacheWrite) ?? 0);
	return total > 0 ? `${formatTokens(total)} tokens` : undefined;
}

function doneSummary(status: Rec): string {
	const progress = obj(status.progress);
	const parts: string[] = [];
	const calls = Array.isArray(progress?.toolCalls) ? progress.toolCalls.length : undefined;
	if (calls !== undefined) parts.push(plural(calls, "tool use"));
	const tokens = tokensOf(progress?.accounting ?? status.accounting ?? status.usage);
	if (tokens) parts.push(tokens);
	const started = num(status.startedAt);
	const finished = num(status.finishedAt);
	if (started !== undefined && finished !== undefined && finished >= started) parts.push(formatDuration(finished - started));
	return parts.length ? `Done (${parts.join(" · ")})` : "Done";
}

/** Tree lines (`├`/`└`) for the live state of a subagent / workflow. */
function taskTree(status: Rec, running: boolean, expanded: boolean): string[] {
	const out: string[] = [];
	const progress = obj(status.progress);
	const toolCalls = Array.isArray(progress?.toolCalls) ? (progress.toolCalls as Rec[]) : [];
	const agents = Array.isArray(status.agents) ? (status.agents as Rec[]) : Array.isArray(obj(status.run)?.agents) ? (obj(status.run)!.agents as Rec[]) : [];
	const items: string[] = [];
	for (const call of toolCalls) {
		const state = str(call.state) || str(call.status);
		const name = str(call.name) || "tool";
		items.push(state === "failed" ? red(name) : state === "running" ? name : dim(name));
	}
	for (const agent of agents) {
		const label = str(agent.label) || str(agent.name) || str(agent.id);
		const state = str(agent.state) || str(agent.status);
		items.push(`${label}${state ? dim(` · ${state}`) : ""}`);
	}
	const activity = obj(progress?.activity);
	const tail = running ? (activity && str(activity.text) ? `${str(activity.text).split("\n")[0]}…` : "Running…") : undefined;
	const shownItems = expanded ? items : items.slice(-PREVIEW_LINES);
	const hiddenItems = items.length - shownItems.length;
	if (hiddenItems > 0) out.push(dim(`… +${hiddenItems} earlier`));
	shownItems.forEach((item, i) => {
		const last = i === shownItems.length - 1 && !tail;
		out.push(`${dim(last ? "└" : "├")} ${item}`);
	});
	if (tail) out.push(`${dim("└")} ${dim(tail)}`);
	return out;
}

function taskRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			startTimer(ctx);
			const c = lazy(ctx);
			const label = taskLabel(toolName, rawArgs);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), "Task", label));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			tickWhilePartial(ctx, options.isPartial);
			const c = lazy(ctx);
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				let msg = raw;
				const d = obj(result.details);
				const err = obj(d?.error);
				if (err && str(err.message)) msg = str(err.message);
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(msg)));
				return c;
			}
			let details: unknown = result.details;
			if (details === undefined && raw.trim().startsWith("{")) {
				try {
					details = JSON.parse(raw);
				} catch {
					details = undefined;
				}
			}
			const status = obj(details);
			const list = Array.isArray(details) ? (details as unknown[]) : undefined;
			c.set((w) => {
				if (list) {
					const lines = list.map((item) => {
						const s = obj(item);
						if (!s) return str(item);
						const label = str(s.label) || str(s.id) || str(s.runId) || str(s.name);
						const state = str(s.state) || str(s.status);
						return `${label}${state ? dim(` · ${state}`) : ""}`;
					});
					if (lines.length === 0) return resultLines(w, ctx.outputPad, [dim("(No tasks)")]);
					return withPreview(w, ctx.outputPad, undefined, lines, options.expanded);
				}
				if (!status) {
					if (options.isPartial) return resultLines(w, ctx.outputPad, [dim("Initializing…")]);
					const lines = raw.trim() ? raw.trim().split("\n") : [dim("Done")];
					return withPreview(w, ctx.outputPad, undefined, lines, options.expanded);
				}
				const run = obj(status.run);
				const state = str(status.state) || str(run?.state);
				const running = options.isPartial || state === "running" || state === "pending" || state === "queued";
				if (running) {
					const tree = taskTree(status, true, options.expanded);
					const header = status.detached || (!options.isPartial && state === "running") ? dim("Running in the background") : undefined;
					const lines = header ? [header, ...tree.filter((l) => !l.endsWith(dim("Running…")))] : tree.length ? tree : [dim(`Initializing… ${elapsed(ctx)}`.trim())];
					return resultLines(w, ctx.outputPad, lines);
				}
				if (state === "failed") {
					const err = obj(status.error) ?? obj(run?.error);
					const msg = err ? str(err.message) || str(err.code) : "Failed";
					return resultLines(w, ctx.outputPad, [red(msg || "Failed")]);
				}
				if (state === "stopped" || state === "cancelled") {
					return resultLines(w, ctx.outputPad, [dim(state === "stopped" ? "Stopped" : "Cancelled")]);
				}
				const lines = [doneSummary(status)];
				if (options.expanded) {
					lines.push(...taskTree(status, false, true));
					const value = status.value;
					if (value !== undefined) {
						const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
						lines.push(...text.split("\n").map((l) => dim(l)));
					}
				}
				return resultLines(w, ctx.outputPad, lines);
			});
			return c;
		},
	};
}

// ───────────────────────────── Generic fallback (custom, extension and MCP tools) ─────────────────────────────

const DISPLAY_NAMES: Record<string, string> = {
	bash_output: "BashOutput",
	kill_shell: "KillShell",
	todo_write: "Update Todos",
	tool_search: "ToolSearch",
};

/** `mcp__<server>__<tool>` → `{ server, tool }` (Pi's built-in MCP tool naming). */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
	const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
	return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

function displayName(toolName: string): string {
	const mcp = parseMcpToolName(toolName);
	// MCP tools: `● slack · search_users(query: "joan")`.
	if (mcp) return `${mcp.server} · ${mcp.tool}`;
	const known = DISPLAY_NAMES[toolName];
	if (known) return known;
	return toolName
		.split("_")
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

function genericRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			startTimer(ctx);
			const c = lazy(ctx);
			const summary = argsSummary(rawArgs);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), displayName(toolName), summary));
			return c;
		},
		renderResult(result: AnyResult, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			tickWhilePartial(ctx, options.isPartial);
			const c = lazy(ctx);
			const raw = textOf(result, ctx.showImages);
			if (ctx.isError) {
				c.set((w) => resultLines(w, ctx.outputPad, errorLines(raw)));
				return c;
			}
			const trimmed = raw.replace(/\s+$/, "");
			c.set((w) => {
				if (trimmed === "") return resultLines(w, ctx.outputPad, [dim(options.isPartial ? `Running… ${elapsed(ctx)}`.trim() : "(No content)")]);
				return withPreview(w, ctx.outputPad, undefined, trimmed.split("\n").map(replaceTabs), options.expanded);
			});
			return c;
		},
	};
}

// ───────────────────────────── PR tools (pr.ts) ─────────────────────────────

const PR_TOOL_NAMES: Record<string, string> = { pr_status: "PR Status", pr_watch: "PR Watch" };

interface PrDetails {
	number?: number;
	interval?: number;
	summary?: string[];
	full?: string[];
}

/** `#123` (from the result once resolved, else the args) plus `· every 60s` for pr_watch. */
function prLabel(toolName: string, rawArgs: unknown, details: PrDetails | undefined): string {
	const a = (rawArgs ?? {}) as Rec;
	const n = details?.number ?? num(a.pr);
	let head = n !== undefined ? `#${n}` : "current branch";
	if (toolName === "pr_watch") head += ` · every ${details?.interval ?? num(a.interval) ?? 60}s`;
	return head;
}

function prRenderers(toolName: string): ToolRenderers {
	const name = PR_TOOL_NAMES[toolName] ?? displayName(toolName);
	return {
		renderShell: "self",
		renderCall(rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			startTimer(ctx);
			const c = lazy(ctx);
			c.set((w) => callLines(w, ctx.outputPad, statusOf(ctx), name, ctx.state.label ?? prLabel(toolName, rawArgs, undefined)));
			return c;
		},
		renderResult(result: AgentToolResult<PrDetails | undefined>, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			tickWhilePartial(ctx, options.isPartial);
			const c = lazy(ctx);
			const d = result.details;
			if (d?.number !== undefined) ctx.state.label = prLabel(toolName, ctx.args, d);
			const raw = textOf(result, ctx.showImages);
			c.set((w) => {
				if (options.isPartial) return resultLines(w, ctx.outputPad, [dim(`Asking GitHub… ${elapsed(ctx)}`.trim())]);
				if (ctx.isError) return resultLines(w, ctx.outputPad, errorLines(d?.summary?.[0] ?? raw));
				const summary = d?.summary ?? raw.trim().split("\n").slice(0, PREVIEW_LINES);
				const full = d?.full ?? [];
				if (!options.expanded || full.length === 0) {
					const lines = [...summary];
					if (full.length) lines.push(moreLinesHint(full.length));
					return resultLines(w, ctx.outputPad, lines);
				}
				return resultLines(w, ctx.outputPad, [...summary, ...full.map((l) => (l.startsWith("  ") ? dim(l) : l))]);
			});
			return c;
		},
	};
}

// ───────────────────────────── ask_user_question ─────────────────────────────

/** `● Asking question` while the dialog is open; `● Asked question` + `⎿ Header → answer` rows when done. */
function askRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(_rawArgs: unknown, _theme: Theme, ctx: RenderCtx<RowState>) {
			const c = lazy(ctx);
			c.set((w) => {
				const status = statusOf(ctx);
				const title = status === "running" ? "Asking question" : "Asked question";
				return [truncateToWidth(`${" ".repeat(ctx.outputPad)}${bulletFor(status)} ${bold(title)}`, w)];
			});
			return c;
		},
		renderResult(result: AgentToolResult<AskDetails | undefined>, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx<RowState>) {
			markStatus(ctx, options);
			const c = lazy(ctx);
			const d = result.details;
			const raw = textOf(result, ctx.showImages);
			c.set((w) => {
				if (options.isPartial) return resultLines(w, ctx.outputPad, [dim("Waiting for your answer…")]);
				if (ctx.isError) return resultLines(w, ctx.outputPad, errorLines(raw));
				if (!d || d.cancelled || d.answers.length === 0) return resultLines(w, ctx.outputPad, [dim(raw.trim() || "User cancelled")]);
				const headerW = Math.max(...d.answers.map((a) => visibleWidth(a.header)));
				const rows = d.answers.map((a) => `${a.header.padEnd(headerW)} ${dim("→")} ${a.answer}`);
				return withPreview(w, ctx.outputPad, undefined, rows, options.expanded, 4);
			});
			return c;
		},
	};
}

// ───────────────────────────── Registration ─────────────────────────────

export function setupToolRenderers(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, _next): ToolRenderers | undefined => {
		switch (toolName) {
			case "read":
				return readRenderers();
			case "bash":
				return bashRenderers("Bash");
			case "powershell":
				return bashRenderers("PowerShell");
			case "edit":
				return editRenderers();
			case "write":
				return writeRenderers();
			case "grep":
				return searchRenderers("grep");
			case "find":
				return searchRenderers("find");
			case "ls":
				return lsRenderers();
			case "todo_write":
				// todo.ts renders its own `● Update Todos` list.
				return _next();
			case "ask_user_question":
				return askRenderers();
			default:
				if (TASK_TOOLS.has(toolName)) return taskRenderers(toolName);
				if (toolName in PR_TOOL_NAMES) return prRenderers(toolName);
				return genericRenderers(toolName);
		}
	});
}

// Exported for unit tests / the integrator (e.g. the permission dialog can reuse the diff look).
export { diffLines as renderClaudioDiff };
