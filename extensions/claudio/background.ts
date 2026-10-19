/**
 * Background tasks (inspired by Claude Code).
 *
 * - Overrides the built-in `bash` tool adding `run_in_background` (spawns a tracked shell and
 *   returns immediately with `Command running in background with ID: <id>`); the foreground path
 *   delegates to the original definition unchanged.
 * - `wake: true` (implies run_in_background): the task's output wakes the agent. Lines are batched
 *   (`wake_debounce_ms`, default 3 s), an optional `wake_pattern` regex selects the lines that wake
 *   (every line still goes to the log), and the exit always wakes. Each wake is a `bg-wake` custom
 *   message sent with `{ triggerTurn: true, deliverAs: "followUp" }`. The batching / wake logic is
 *   based on pi-bgwatch by Josep Reyero (MIT, github.com/josep-reyero/pi-bgwatch). Logs live in
 *   `$TMPDIR/pi-claudio/<pi pid>/<id>/output.log` so several pi sessions never share a directory.
 * - ctrl+b-backgrounded commands also wake the agent (bg-wake) when they exit.
 * - `bash_output` (incremental output + status) and `kill_shell` tools.
 * - `/tasks` (alias `/bashes`): Claude-style "Background tasks" dialog (view output / kill).
 * - ctrl+b: moves the currently running foreground bash to the background.
 * - Publishes `backgroundTaskCount` on the shared bus; kills children on session_shutdown.
 *
 * Rendering of the `bash` tool rows is owned by tools.ts (we define no renderCall/renderResult);
 * a backgrounded call returns `details.background = { id, command, byUser? }`.
 */

import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashToolDetails,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	keyText,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ANSI, actions, bold, bus, dialogInnerWidth, dialogLines, dim, FG, formatDuration, moreLines, RESULT_INDENT } from "./shared.ts";

// ── palette via shared.ts (raw truecolor) ───────────────────────────────
const ORANGE = FG.claudio;
const GREEN = FG.success;
const RED = FG.error;
const PERM = FG.permission;
const FG_RESET = ANSI.fgReset;
const DIM = ANSI.dim;
const ATTR_RESET = ANSI.reset;

// ── Types ──────────────────────────────────────────────────────────────────────────────────
export type BackgroundStatus = "running" | "completed" | "failed" | "killed";

/** `details.background` on a bash result that was moved to / started in the background. */
export interface BackgroundInfo {
	id: string;
	command: string;
	/** true when the user pressed ctrl+b on a running foreground command */
	byUser?: boolean;
	/** true when the task wakes the agent on output / exit */
	wake?: boolean;
	title?: string;
	logFile?: string;
}

/** `details` of the `bg-wake` custom message (one per batch of output / exit). */
export interface BgWakeDetails {
	id: string;
	title: string;
	command: string;
	kind: "output" | "exit";
	status: BackgroundStatus;
	exitCode: number | null;
	logFile?: string;
	lines: string[];
	dropped: number;
}

/** Options for a wake-enabled background task. */
export interface WakeOptions {
	title?: string;
	/** Regex source; only matching lines wake the agent (all lines go to the log). */
	pattern?: string;
	debounceMs?: number;
}

/** Details shape of the overridden `bash` tool: the original shape plus an optional `background`. */
export type ClaudioBashDetails = (BashToolDetails & { background?: BackgroundInfo }) | undefined;

/** Details of `bash_output` / `kill_shell` results. */
export interface ShellToolDetails {
	id: string;
	command: string;
	status: BackgroundStatus;
	exitCode: number | null;
	/** bash_output only: the new output returned by this call (after filter) */
	newOutput?: string;
	error?: string;
}

interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	status: BackgroundStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	output: string;
	/** Characters of `output` already returned by bash_output */
	readOffset: number;
	controller: AbortController;
	byUser: boolean;
	/** Set when the task was created from a foreground command (output comes from snapshots) */
	snapshotDriven?: boolean;
	/** Short name shown in wakes and in /tasks (defaults to the command). */
	title: string;
	/** Present when the task wakes the agent on output (and always on exit). */
	wake?: WakeState;
}

/** Per-task wake state (debounced batches of lines; based on pi-bgwatch by Josep Reyero, MIT). */
interface WakeState {
	pattern?: RegExp;
	debounceMs: number;
	pending: string[];
	dropped: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Partial last line of the stream, waiting for its `\n`. */
	lineBuf: string;
	logFile: string;
	log: WriteStream;
	lines: number;
}

interface ForegroundRun {
	toolCallId: string;
	command: string;
	startedAt: number;
	/** Resolves the tool call immediately and keeps the process alive as a background task */
	moveToBackground: () => BackgroundTask | undefined;
}

// ── Module state ───────────────────────────────────────────────────────────────────────────
const tasks = new Map<string, BackgroundTask>();
const foreground = new Map<string, ForegroundRun>();
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024; // keep at most 2 MiB per task in memory
const MAX_LINES_PER_WAKE = 200;
const DEFAULT_WAKE_DEBOUNCE_MS = 3000;
/** Per pi process, so several sessions on one host never share a directory. */
const WAKE_ROOT = join(tmpdir(), "pi-claudio", String(process.pid));
let piApi: ExtensionAPI | undefined;

function newId(): string {
	let id = "";
	do {
		id = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	} while (tasks.has(id));
	return id;
}

function publishCount(): void {
	let n = 0;
	for (const t of tasks.values()) if (t.status === "running") n++;
	bus.set("backgroundTaskCount", n);
}

function appendOutput(task: BackgroundTask, chunk: string): void {
	task.output += chunk;
	if (task.output.length > MAX_OUTPUT_CHARS) {
		const drop = task.output.length - MAX_OUTPUT_CHARS;
		task.output = task.output.slice(drop);
		task.readOffset = Math.max(0, task.readOffset - drop);
	}
	if (task.wake) feedWake(task, task.wake, chunk);
}

function finishTask(task: BackgroundTask, status: BackgroundStatus, exitCode: number | null): void {
	if (task.status !== "running") return;
	task.status = status;
	task.exitCode = exitCode;
	task.endedAt = Date.now();
	publishCount();
	const w = task.wake;
	if (w) {
		if (w.lineBuf) wakeLine(task, w, w.lineBuf);
		w.lineBuf = "";
		w.log.end();
		try {
			writeFileSync(join(WAKE_ROOT, task.id, "exitcode"), `${exitCode ?? 1}\n`);
		} catch {
			/* best effort */
		}
	}
}

// ── Wake-on-output (based on pi-bgwatch by Josep Reyero, MIT) ────────────────────────────────
function createWake(task: BackgroundTask, opts: WakeOptions): WakeState {
	const dir = join(WAKE_ROOT, task.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "command"), `${task.command}\n`);
	const logFile = join(dir, "output.log");
	return {
		pattern: opts.pattern ? new RegExp(opts.pattern) : undefined,
		debounceMs: Math.max(0, opts.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS),
		pending: [],
		dropped: 0,
		lineBuf: "",
		logFile,
		log: createWriteStream(logFile, { flags: "w" }),
		lines: 0,
	};
}

function feedWake(task: BackgroundTask, w: WakeState, chunk: string): void {
	w.lineBuf += chunk;
	const parts = w.lineBuf.split("\n");
	w.lineBuf = parts.pop() ?? "";
	for (const line of parts) wakeLine(task, w, line.replace(/\r$/, ""));
}

function wakeLine(task: BackgroundTask, w: WakeState, line: string): void {
	w.lines++;
	w.log.write(`${line}\n`);
	if (w.pattern && !w.pattern.test(line)) return;
	if (w.pending.length >= MAX_LINES_PER_WAKE) w.dropped++;
	else w.pending.push(line);
	if (!w.timer) w.timer = setTimeout(() => sendWake(task, "output"), w.debounceMs);
}

/**
 * The wake itself: flush the pending batch into a `bg-wake` message. Content (in the spirit of
 * pi-bgwatch): `<title> output:` + lines, or `<title> exited N.` + remaining lines, then `Log: <path>`.
 * `followUp` queues behind a running turn instead of interrupting it; `triggerTurn` starts one when idle.
 */
function sendWake(task: BackgroundTask, kind: "output" | "exit"): void {
	const w = task.wake;
	if (w?.timer) {
		clearTimeout(w.timer);
		w.timer = undefined;
	}
	const lines = w ? w.pending : [];
	const dropped = w ? w.dropped : 0;
	if (w) {
		w.pending = [];
		w.dropped = 0;
	}
	if (kind === "output" && lines.length === 0) return;
	if (!piApi) return;

	let content = task.title;
	if (kind === "exit") {
		content += task.status === "killed" ? " stopped." : ` exited ${task.exitCode ?? "?"}.`;
	} else {
		content += " output:";
	}
	if (lines.length > 0) {
		content += `\n${lines.join("\n")}`;
		if (dropped > 0) content += `\n... ${dropped} more line(s) in ${w?.logFile ?? "the log"}`;
	} else if (kind === "exit" && !w) {
		// ctrl+b task without a wake log: give the model the tail of what we have.
		const tail = tailLines(task.output, 20);
		if (tail.trim()) content += `\n${tail}`;
	}
	if (w) content += `\nLog: ${w.logFile}`;
	else content += `\nShell id: ${task.id} (bash_output for the full output).`;

	piApi.sendMessage(
		{
			customType: "bg-wake",
			content,
			display: true,
			details: {
				id: task.id,
				title: task.title,
				command: task.command,
				kind,
				status: task.status,
				exitCode: task.exitCode,
				logFile: w?.logFile,
				lines: kind === "exit" && !w && lines.length === 0 ? tailLines(task.output, 20).split("\n").filter(Boolean) : lines,
				dropped,
			} satisfies BgWakeDetails,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function tailLines(text: string, n: number): string {
	const lines = text.replace(/\n$/, "").split("\n");
	return lines.slice(-n).join("\n");
}

function statusText(task: BackgroundTask): string {
	switch (task.status) {
		case "running":
			return `${ORANGE}●${FG_RESET} running`;
		case "completed":
			return `${GREEN}✔${FG_RESET} Completed`;
		case "failed":
			return `${RED}✕${FG_RESET} Failed${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""}`;
		case "killed":
			return `${DIM}■ Stopped${ATTR_RESET}`;
	}
}

// ── Model notification when a background task ends ─────────────────────────────────────────
function notifyModel(pi: ExtensionAPI, task: BackgroundTask): void {
	// Wake-enabled and ctrl+b tasks wake the agent with a `bg-wake` (the exit always wakes).
	if (task.wake || task.byUser) return sendWake(task, "exit");
	const verb =
		task.status === "completed"
			? "completed"
			: task.status === "failed"
				? `failed with exit code ${task.exitCode ?? "unknown"}`
				: "was killed";
	const tail = tailLines(task.output, 20);
	const body =
		`<background-task-notification>\nBackground shell ${task.id} (${JSON.stringify(task.command)}) ${verb}.\n` +
		(tail ? `Last output:\n${tail}\n` : "(no output)\n") +
		`Use bash_output with bash_id "${task.id}" for the full output.\n</background-task-notification>`;
	pi.sendMessage(
		{
			customType: "background_task_done",
			content: body,
			display: true,
			details: { id: task.id, command: task.command, status: task.status, exitCode: task.exitCode } satisfies ShellToolDetails,
		},
		// Completed/failed wakes the model (like Claude Code); a kill was deliberate, so it is just
		// context for the next turn.
		task.status === "killed" ? { deliverAs: "nextTurn" } : { triggerTurn: true },
	);
}

// ── Spawning a detached background task ────────────────────────────────────────────────────
/**
 * Start a tracked background shell. With `wake` the task wakes the agent on output (debounced,
 * optionally filtered) and on exit. Exported for thin wrappers such as `pr_watch` (pr.ts).
 * Throws on an invalid `wake.pattern`.
 */
export function startBackgroundTask(pi: ExtensionAPI, command: string, cwd: string, timeoutSeconds: number | undefined, wake?: WakeOptions): BackgroundTask {
	piApi = pi;
	const settings = pi.getSettings();
	const ops = createLocalBashOperations({ shellPath: settings.shellPath });
	const prefix = settings.shellCommandPrefix;
	const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
	const task: BackgroundTask = {
		id: newId(),
		command,
		cwd,
		status: "running",
		exitCode: null,
		startedAt: Date.now(),
		output: "",
		readOffset: 0,
		controller: new AbortController(),
		byUser: false,
		title: wake?.title?.trim() || command,
	};
	if (wake) task.wake = createWake(task, wake);
	tasks.set(task.id, task);
	publishCount();
	void ops
		.exec(resolvedCommand, cwd, {
			onData: (data) => appendOutput(task, data.toString()),
			signal: task.controller.signal,
			timeout: timeoutSeconds,
		})
		.then(({ exitCode }) => {
			finishTask(task, exitCode === 0 ? "completed" : "failed", exitCode);
		})
		.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (task.controller.signal.aborted || msg === "aborted") finishTask(task, "killed", null);
			else {
				appendOutput(task, `\n${msg.startsWith("timeout:") ? `Command timed out after ${msg.slice(8)} seconds` : msg}\n`);
				finishTask(task, "failed", null);
			}
		})
		.finally(() => notifyModel(pi, task));
	return task;
}

function killTask(task: BackgroundTask): void {
	if (task.status !== "running") return;
	task.controller.abort();
	// The snapshot-driven case has no exec promise of our own; mark it directly.
	if (task.snapshotDriven) finishTask(task, "killed", null);
}

/** Model-facing text returned by `bash` when a wake task starts. */
function wakeStartedText(task: BackgroundTask, pattern: string | undefined): string {
	const w = task.wake!;
	return (
		`Started background task ${task.id}: ${task.title}\n` +
		`Log: ${w.logFile}` +
		(pattern ? `\nWaking on lines matching /${pattern}/ (every line is still logged).` : "") +
		`\nYou will be woken when output arrives (batched ${w.debounceMs}ms) and when it exits. End your turn now; do not poll bash_output.`
	);
}

// ── The /tasks dialog ──────────────────────────────────────────────────────────────────────
class BackgroundTasksDialog implements Component, Focusable {
	focused = false;
	private selected = 0;
	private viewing: BackgroundTask | undefined;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	private list(): BackgroundTask[] {
		return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	handleInput(data: string): void {
		const list = this.list();
		if (this.viewing) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") {
				this.viewing = undefined;
			} else if (data === "x" && this.viewing.status === "running") {
				killTask(this.viewing);
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.done();
		if (list.length === 0) return;
		if (matchesKey(data, "up") || data === "k") this.selected = (this.selected + list.length - 1) % list.length;
		else if (matchesKey(data, "down") || data === "j") this.selected = (this.selected + 1) % list.length;
		else if (matchesKey(data, "enter")) this.viewing = list[this.selected];
		else if (data === "x") {
			const t = list[this.selected];
			if (t) killTask(t);
		} else if (data === "r") {
			// Restart a finished task: same command and cwd, new shell id.
			const t = list[this.selected];
			if (t && t.status !== "running") {
				tasks.delete(t.id);
				startBackgroundTask(this.pi, t.command, t.cwd, undefined, t.wake ? { title: t.title, pattern: t.wake.pattern?.source, debounceMs: t.wake.debounceMs } : undefined);
				this.selected = 0;
			}
		} else if (data === "d") {
			const t = list[this.selected];
			if (t && t.status !== "running") {
				tasks.delete(t.id);
				this.selected = Math.min(this.selected, Math.max(0, this.list().length - 1));
			}
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = dialogInnerWidth(width);
		const body: string[] = [""];
		const title = this.viewing ? `Background task ${this.viewing.id}` : "Background tasks";

		if (this.viewing) {
			const t = this.viewing;
			body.push(`  ${this.theme.bold(truncateToWidth(t.title !== t.command ? `${t.title} · ${t.command}` : t.command, inner - 2))}`);
			body.push(`  ${statusText(t)} ${DIM}· ${formatDuration((t.endedAt ?? Date.now()) - t.startedAt)} · ${t.cwd}${ATTR_RESET}`);
			if (t.wake) body.push(`  ${DIM}wakes the agent on ${t.wake.pattern ? `/${t.wake.pattern.source}/` : "output"} · ${t.wake.lines} lines · ${t.wake.logFile}${ATTR_RESET}`);
			body.push("");
			const text = t.output.length ? tailLines(t.output, 15) : "(no output)";
			const maxRows = 15;
			const rows: string[] = [];
			for (const raw of text.split("\n")) for (const w of wrapTextWithAnsi(raw, inner - 2)) rows.push(w);
			for (const r of rows.slice(-maxRows)) body.push(`  ${t.output.length ? r : DIM + r + ATTR_RESET}`);
			body.push("");
			const hints = [t.status === "running" ? "x stop" : undefined, "esc back"].filter(Boolean).join(" · ");
			body.push(`  ${DIM}${hints}${ATTR_RESET}`);
		} else {
			const list = this.list();
			if (list.length === 0) {
				body.push(`  ${DIM}No background tasks${ATTR_RESET}`);
			} else {
				const nameWidth = Math.max(12, Math.min(40, inner - 30));
				list.forEach((t, i) => {
					const sel = i === this.selected;
					const name = truncateToWidth(t.title.replace(/\s+/g, " "), nameWidth, "…", true);
					const elapsed = formatDuration((t.endedAt ?? Date.now()) - t.startedAt).padEnd(6);
					const status = truncateToWidth(statusText(t), 13, "…", true);
					body.push(`${sel ? `${PERM}❯ ${name}${FG_RESET}` : `  ${name}`}  ${status}  ${DIM}${elapsed}  ${t.wake ? "wake" : "shell"}${ATTR_RESET}`);
				});
			}
			body.push("");
			body.push(`  ${DIM}↑↓ select · enter view · x stop · r restart · esc close${ATTR_RESET}`);
		}
		return dialogLines(width, "permission", title, undefined, body);
	}
}

// ── Setup ──────────────────────────────────────────────────────────────────────────────────
export function setupBackground(pi: ExtensionAPI): void {
	piApi = pi;
	bus.set("backgroundTaskCount", 0);

	// Metadata (name, description, outputSchema…) comes from an unconfigured definition; the one
	// that actually executes is created lazily because settings are not readable at load time.
	const original = createBashToolDefinition(process.cwd());
	let configured: ReturnType<typeof createBashToolDefinition> | undefined;
	const getConfigured = () => {
		if (!configured) {
			const settings = pi.getSettings();
			configured = createBashToolDefinition(process.cwd(), {
				commandPrefix: settings.shellCommandPrefix,
				shellPath: settings.shellPath,
			});
		}
		return configured;
	};

	const params = Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
		description: Type.Optional(
			Type.String({
				description:
					"Clear, concise description of what this command does in 5-10 words, in active voice. Examples: " +
					"'List files in current directory', 'Install package dependencies', 'Run unit tests'.",
			}),
		),
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Set to true to run this command in the background. Use bash_output to read the output later.",
			}),
		),
		wake: Type.Optional(
			Type.Boolean({
				description:
					"Wake the agent when new output arrives and when the command exits; implies run_in_background. " +
					"Use for watchers, test loops, log tails, pollers: start it, end your turn, act when woken.",
			}),
		),
		wake_pattern: Type.Optional(
			Type.String({ description: "Regex; with wake=true only matching lines wake the agent (every line is still written to the log)." }),
		),
		wake_debounce_ms: Type.Optional(
			Type.Number({ description: "With wake=true, batch window in ms before a wake (default 3000; 0 = one wake per line)." }),
		),
		title: Type.Optional(Type.String({ description: "Short name for a background task, shown in wakes and in /tasks (defaults to the command)." })),
	});

	pi.registerTool<typeof params, ClaudioBashDetails>({
		...original,
		parameters: params,
		description:
			`${original.description}\n\n` +
			"Long-running commands (dev servers, watchers, slow builds/tests) can be started with run_in_background=true; " +
			"the call returns at once with a shell ID. Read its output with bash_output and stop it with kill_shell. " +
			"Never use `&`, `nohup` or `sleep`-polling to background a command yourself.\n\n" +
			"wake=true makes the background command wake you: each batch of new output lines (debounced wake_debounce_ms, " +
			"default 3 s) is injected into the session and triggers a turn; wake_pattern (regex) selects which lines wake you; " +
			"the exit always wakes you. Never busy-wait: start it, end your turn, act when woken. " +
			"After `gh pr create`, offer to watch the PR with the pr_watch tool.",
		async execute(toolCallId, args, signal, onUpdate, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const command = args.command;

			if (args.wake) {
				let task: BackgroundTask;
				try {
					task = startBackgroundTask(pi, command, cwd, args.timeout, { title: args.title, pattern: args.wake_pattern, debounceMs: args.wake_debounce_ms });
				} catch (e) {
					const msg = `Invalid wake_pattern: ${e instanceof Error ? e.message : String(e)}`;
					return { content: [{ type: "text", text: msg }], details: undefined, isError: true };
				}
				const text = wakeStartedText(task, args.wake_pattern);
				return {
					content: [{ type: "text", text }],
					details: { background: { id: task.id, command, wake: true, title: task.title, logFile: task.wake?.logFile } },
					structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 0 },
				};
			}

			if (args.run_in_background) {
				const task = startBackgroundTask(pi, command, cwd, args.timeout, undefined);
				if (args.title?.trim()) task.title = args.title.trim();
				const text = `Command running in background with ID: ${task.id}. Use bash_output with bash_id "${task.id}" to read its output; you will be notified when it completes.`;
				return {
					content: [{ type: "text", text }],
					details: { background: { id: task.id, command } },
					structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 0 },
				};
			}

			// Foreground: delegate to the original, but through our own abort controller so the
			// command can be moved to the background (ctrl+b) and keep running after this call resolves.
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener("abort", forwardAbort, { once: true });
			}

			let bgTask: BackgroundTask | undefined;
			let resolveBackground: ((r: AgentToolResult<ClaudioBashDetails>) => void) | undefined;
			const backgrounded = new Promise<AgentToolResult<ClaudioBashDetails>>((resolve) => {
				resolveBackground = resolve;
			});

			const wrappedUpdate: AgentToolUpdateCallback<ClaudioBashDetails> | undefined = (partial) => {
				if (bgTask) {
					// Snapshot of the full output so far (head-truncated by the original tool).
					const text = partial.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					bgTask.output = text;
					return;
				}
				onUpdate?.(partial);
			};

			const run: ForegroundRun = {
				toolCallId,
				command,
				startedAt: Date.now(),
				moveToBackground: () => {
					if (bgTask) return bgTask;
					signal?.removeEventListener("abort", forwardAbort);
					bgTask = {
						id: newId(),
						command,
						cwd,
						status: "running",
						exitCode: null,
						startedAt: run.startedAt,
						output: "",
						readOffset: 0,
						controller,
						byUser: true,
						snapshotDriven: true,
						title: command,
					};
					tasks.set(bgTask.id, bgTask);
					publishCount();
					foreground.delete(toolCallId);
					const text = `Command running in background (shell id: ${bgTask.id}). Use bash_output with bash_id "${bgTask.id}" to read its output; you will be notified when it completes.`;
					resolveBackground?.({
						content: [{ type: "text", text }],
						details: { background: { id: bgTask.id, command, byUser: true } },
						structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 0 },
					});
					return bgTask;
				},
			};
			foreground.set(toolCallId, run);

			const execution = getConfigured()
				.execute(toolCallId, { command, timeout: args.timeout }, controller.signal, wrappedUpdate, ctx)
				.then(
					(result): AgentToolResult<ClaudioBashDetails> => {
						if (bgTask) {
							const text = result.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n");
							if (text) bgTask.output = text;
							const exit = (result.structuredContent as { exit_code?: number } | undefined)?.exit_code ?? 0;
							finishTask(bgTask, exit === 0 ? "completed" : "failed", exit);
							notifyModel(pi, bgTask);
						}
						return result;
					},
					(err: unknown) => {
						if (bgTask) {
							const msg = err instanceof Error ? err.message : String(err);
							if (controller.signal.aborted) finishTask(bgTask, "killed", null);
							else {
								bgTask.output += `\n${msg}`;
								finishTask(bgTask, "failed", null);
							}
							notifyModel(pi, bgTask);
							// Swallow: the tool call already resolved with the background message.
							return backgrounded;
						}
						throw err;
					},
				)
				.finally(() => {
					foreground.delete(toolCallId);
					signal?.removeEventListener("abort", forwardAbort);
				});

			return Promise.race([execution, backgrounded]);
		},
	});

	// ── bash_output ──
	const outputParams = Type.Object({
		bash_id: Type.String({ description: "The ID of the background shell to retrieve output from" }),
		filter: Type.Optional(
			Type.String({
				description:
					"Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result. Any lines that do not match will no longer be available to read.",
			}),
		),
	});
	pi.registerTool<typeof outputParams, ShellToolDetails | undefined>({
		name: "bash_output",
		label: "BashOutput",
		description:
			"Retrieves output from a running or completed background bash shell. Returns only new output since the last check, along with the shell status. Use this to monitor commands started with run_in_background. Do not poll in a tight loop; you are notified when the shell exits.",
		promptSnippet: "Read new output from a background shell",
		parameters: outputParams,
		async execute(_id, args) {
			const task = tasks.get(args.bash_id);
			if (!task) {
				return {
					content: [{ type: "text", text: `No background shell with ID ${args.bash_id}` }],
					details: undefined,
					isError: true,
				};
			}
			let fresh = task.output.slice(task.readOffset);
			task.readOffset = task.output.length;
			if (args.filter) {
				try {
					const re = new RegExp(args.filter);
					fresh = fresh
						.split("\n")
						.filter((l) => re.test(l))
						.join("\n");
				} catch (e) {
					return {
						content: [{ type: "text", text: `Invalid filter regex: ${e instanceof Error ? e.message : String(e)}` }],
						details: { id: task.id, command: task.command, status: task.status, exitCode: task.exitCode, error: "bad filter" },
						isError: true,
					};
				}
			}
			const parts = [`<status>${task.status}</status>`];
			if (task.status !== "running") parts.push(`<exit_code>${task.exitCode ?? "null"}</exit_code>`);
			parts.push(`<stdout>\n${fresh.replace(/\n$/, "")}\n</stdout>`);
			parts.push(`<timestamp>${new Date().toISOString()}</timestamp>`);
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { id: task.id, command: task.command, status: task.status, exitCode: task.exitCode, newOutput: fresh },
			};
		},
	});

	// ── kill_shell ──
	const killParams = Type.Object({
		shell_id: Type.String({ description: "The ID of the background shell to kill" }),
	});
	pi.registerTool<typeof killParams, ShellToolDetails | undefined>({
		name: "kill_shell",
		label: "KillShell",
		description: "Kills a running background bash shell by its ID. Use this to stop commands started with run_in_background.",
		promptSnippet: "Stop a background shell",
		parameters: killParams,
		async execute(_id, args) {
			const task = tasks.get(args.shell_id);
			if (!task) {
				return { content: [{ type: "text", text: `No background shell with ID ${args.shell_id}` }], details: undefined, isError: true };
			}
			if (task.status !== "running") {
				return {
					content: [{ type: "text", text: `Shell ${task.id} is not running (status: ${task.status})` }],
					details: { id: task.id, command: task.command, status: task.status, exitCode: task.exitCode },
					isError: true,
				};
			}
			killTask(task);
			return {
				content: [{ type: "text", text: `Successfully killed shell: ${task.id} (${task.command})` }],
				details: { id: task.id, command: task.command, status: "killed", exitCode: null },
			};
		},
	});

	// ── Transcript rows for wakes: `● <title> · output` / `● <title> · exited 0`, then ⎿ lines ──
	pi.registerMessageRenderer<BgWakeDetails>("bg-wake", (msg, opts) => {
		const d = msg.details;
		if (!d) return new Text(dim(`● ${typeof msg.content === "string" ? msg.content.split("\n")[0] : "background task"}`), 0, 0);
		const pad = " ".repeat(opts.outputPad);
		const status =
			d.kind === "output"
				? `${ORANGE}●${FG_RESET} ${bold(d.title)} · output`
				: d.status === "killed"
					? `${DIM}●${ATTR_RESET} ${bold(d.title)} · stopped`
					: `${d.exitCode === 0 ? GREEN : RED}●${FG_RESET} ${bold(d.title)} · exited ${d.exitCode ?? "?"}`;
		const all = d.lines.map((l) => l.replace(/\t/g, "    "));
		const max = 8;
		const shown = opts.expanded ? all : all.slice(0, max);
		const hidden = all.length - shown.length + d.dropped;
		const rows = [...shown];
		if (hidden > 0) rows.push(dim(`${moreLines(hidden)} (${keyText("app.tools.expand")} to expand)`));
		if (rows.length === 0) rows.push(dim(d.kind === "exit" ? "(no output)" : ""));
		if (opts.expanded && d.logFile) rows.push(dim(`Log: ${d.logFile}`));
		return new WakeRow(pad, status, rows);
	});

	// ── Transcript row for the completion notification ──
	pi.registerMessageRenderer<ShellToolDetails>("background_task_done", (msg, _opts, theme) => {
		const d = msg.details;
		const label = d
			? `Background shell ${d.id} ${d.status === "completed" ? "finished" : d.status === "killed" ? "stopped" : `failed (exit ${d.exitCode ?? "?"})`}: ${d.command}`
			: "Background shell finished";
		return new Text(theme.fg("muted", `● ${label}`), 0, 0);
	});

	// ── /tasks and /bashes ──
	const openTasks = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			const lines = [...tasks.values()].map((t) => `${t.id}  ${t.status}  ${formatDuration((t.endedAt ?? Date.now()) - t.startedAt)}  ${t.command}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No background tasks", "info");
			return;
		}
		bus.set("dialog", { kind: "tasks" });
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new BackgroundTasksDialog(pi, tui, theme, () => done()), { overlay: false });
		} finally {
			bus.set("dialog", null);
		}
	};
	pi.registerCommand("tasks", { description: "List and manage background tasks", handler: (_a, ctx) => openTasks(ctx) });
	pi.registerCommand("bashes", { description: "List and manage background tasks", handler: (_a, ctx) => openTasks(ctx) });

	// ── ctrl+b: move the running foreground bash to the background ──
	// Works because the editor keeps focus while the agent runs, and registerShortcut handlers are
	// dispatched by CustomEditor.handleInput before anything else (conflicts with tui.editor.cursorLeft,
	// which only warns; silence it with "tui.editor.cursorLeft": ["left"] in keybindings.json).
	pi.registerShortcut("ctrl+b", {
		description: "Run the current bash command in the background",
		handler: (ctx) => {
			const runs = [...foreground.values()].sort((a, b) => b.startedAt - a.startedAt);
			const run = runs[0];
			if (!run) {
				if (ctx.hasUI) ctx.ui.notify("Nothing to background yet — send a message first.", "info");
				return;
			}
			// No notification: the result row (`Command running in background (shell id: …)`) replaces
			// the running row at once; Pi's notify() would leave a permanent status line in the transcript.
			run.moveToBackground();
		},
	});

	// Let the editor open the list with ↓ on an empty prompt (`(down to manage)`).
	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode === "tui") actions.openTasks = () => void openTasks(ctx);
	});

	// ── Cleanup ──
	pi.on("session_shutdown", () => {
		actions.openTasks = undefined;
		for (const t of tasks.values()) {
			if (t.status === "running") t.controller.abort();
			if (t.wake?.timer) clearTimeout(t.wake.timer);
		}
	});
}

/** `● title · status` followed by `  ⎿  line` rows (continuations indented 5), wrapped to the width. */
class WakeRow implements Component {
	constructor(
		private readonly pad: string,
		private readonly head: string,
		private readonly rows: string[],
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const out = [truncateToWidth(`${this.pad}${this.head}`, width, "…")];
		const inner = Math.max(10, width - this.pad.length - RESULT_INDENT.length);
		let first = true;
		for (const row of this.rows) {
			const pieces = wrapTextWithAnsi(row, inner);
			if (pieces.length === 0) pieces.push("");
			for (const piece of pieces) {
				out.push(truncateToWidth(`${this.pad}${first ? `  ${dim("⎿")}  ` : RESULT_INDENT}${piece}`, width));
				first = false;
			}
		}
		return out;
	}
}

/** Read-only view for other modules (footer, status) — prefer the bus for the count. */
export function listBackgroundTasks(): ReadonlyArray<{ id: string; command: string; status: BackgroundStatus; startedAt: number; endedAt?: number }> {
	return [...tasks.values()].map(({ id, command, status, startedAt, endedAt }) => ({ id, command, status, startedAt, endedAt }));
}

