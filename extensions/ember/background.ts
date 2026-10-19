/**
 * Background tasks (inspired by Claude Code).
 *
 * - Overrides the built-in `bash` tool adding `run_in_background` (spawns a tracked shell and
 *   returns immediately with `Command running in background with ID: <id>`); the foreground path
 *   delegates to the original definition unchanged.
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
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ANSI, actions, bus, dialogInnerWidth, dialogLines, FG, formatDuration } from "./shared.ts";

// ── palette via shared.ts (raw truecolor) ───────────────────────────────
const ORANGE = FG.ember;
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
}

/** Details shape of the overridden `bash` tool: the original shape plus an optional `background`. */
export type EmberBashDetails = (BashToolDetails & { background?: BackgroundInfo }) | undefined;

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
}

function finishTask(task: BackgroundTask, status: BackgroundStatus, exitCode: number | null): void {
	if (task.status !== "running") return;
	task.status = status;
	task.exitCode = exitCode;
	task.endedAt = Date.now();
	publishCount();
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
function startBackgroundTask(pi: ExtensionAPI, command: string, cwd: string, timeoutSeconds: number | undefined): BackgroundTask {
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
	};
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
				startBackgroundTask(this.pi, t.command, t.cwd, undefined);
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
			body.push(`  ${this.theme.bold(truncateToWidth(t.command, inner - 2))}`);
			body.push(`  ${statusText(t)} ${DIM}· ${formatDuration((t.endedAt ?? Date.now()) - t.startedAt)} · ${t.cwd}${ATTR_RESET}`);
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
					const name = truncateToWidth(t.command.replace(/\s+/g, " "), nameWidth, "…", true);
					const elapsed = formatDuration((t.endedAt ?? Date.now()) - t.startedAt).padEnd(6);
					const status = truncateToWidth(statusText(t), 13, "…", true);
					body.push(`${sel ? `${PERM}❯ ${name}${FG_RESET}` : `  ${name}`}  ${status}  ${DIM}${elapsed}  shell${ATTR_RESET}`);
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
	});

	pi.registerTool<typeof params, EmberBashDetails>({
		...original,
		parameters: params,
		description:
			`${original.description}\n\n` +
			"Long-running commands (dev servers, watchers, slow builds/tests) can be started with run_in_background=true; " +
			"the call returns at once with a shell ID. Read its output with bash_output and stop it with kill_shell. " +
			"Never use `&`, `nohup` or `sleep`-polling to background a command yourself.",
		async execute(toolCallId, args, signal, onUpdate, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const command = args.command;

			if (args.run_in_background) {
				const task = startBackgroundTask(pi, command, cwd, args.timeout);
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
			let resolveBackground: ((r: AgentToolResult<EmberBashDetails>) => void) | undefined;
			const backgrounded = new Promise<AgentToolResult<EmberBashDetails>>((resolve) => {
				resolveBackground = resolve;
			});

			const wrappedUpdate: AgentToolUpdateCallback<EmberBashDetails> | undefined = (partial) => {
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
					(result): AgentToolResult<EmberBashDetails> => {
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
		for (const t of tasks.values()) if (t.status === "running") t.controller.abort();
	});
}

/** Read-only view for other modules (footer, status) — prefer the bus for the count. */
export function listBackgroundTasks(): ReadonlyArray<{ id: string; command: string; status: BackgroundStatus; startedAt: number; endedAt?: number }> {
	return [...tasks.values()].map(({ id, command, status, startedAt, endedAt }) => ({ id, command, status, startedAt, endedAt }));
}

