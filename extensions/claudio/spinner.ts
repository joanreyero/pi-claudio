/**
 * Working indicator ("spinner") and terminal title, inspired by Claude Code.
 *
 *   ✻ Noodling… (12s · ↓ 1.2k tokens · running tool for 3s)
 *
 * Pi's own working row (`Loader`) is hidden (`setWorkingVisible(false)`) because it renders
 * with a one-cell left padding and may be embedded in the editor border; instead we draw the
 * row ourselves as an `aboveEditor` widget:
 * after the transcript, one blank line above, directly on top of the prompt box. While idle the row
 * stays as a blank line, so the prompt keeps its place when a turn starts and ends.
 *
 * Behaviour:
 *  - frames `· ✢ ✳ ✶ ✻ ✽` (`*` replaces `✳` outside ghostty), eased
 *    forward/back with a cosine over a 2 s period, sampled every 100 ms (≈ the classic
 *    forward+reversed list at ~120 ms), coloured `claudio` orange.
 *  - verb picked at random once per agent run, rendered in `claudio` orange with a 3-cell
 *    `claudioShimmer` glimmer sweeping right→left (one cell every 200 ms, 10-cell run-out).
 *  - dim status group `([dialog waiting ·] <elapsed> · ↓ <tokens> tokens · thinking|running tool for Ns)`; the token count
 *    animates smoothly toward the real value (+3/+15%/+50 per 50 ms, like Claude).
 *  - terminal title `✳ pi` when idle, alternating `◐`/`◑` every 960 ms while working
 *    (static `✳` under tmux, like Claude).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ANSI, FG, VERBS, bus, formatDuration, formatTokens, spinnerFrames } from "./shared.ts";

// ── palette (from shared.ts; `FG` is a live getter over the active Pi theme) ─────────────────────
const FG_RESET = ANSI.fgReset;
const DIM = ANSI.dim;
const DIM_RESET = ANSI.boldDimReset;

// ── animation constants ───────────────────────────────────────────────
const FRAME_PERIOD_MS = 2000; // full forward+back cycle
const TICK_MS = 100;
const GLIMMER_STEP_MS = 200;
const GLIMMER_RUNOUT = 10;
const TITLE_FRAMES = ["◐", "◑"];
const TITLE_STATIC = "✳";
const TITLE_INTERVAL_MS = 960;
const APP_NAME = "pi";
const ELLIPSIS = "…";

// ── module state ────────────────────────────────────────────────────────────────────────
const WIDGET_KEY = "claudio:spinner";

let active = false; // between agent_start and agent_end
let compacting = false; // Pi shows its own compaction row; hide ours meanwhile
let startedAt = 0;
let verb = "Working";
let finishedTokens = 0; // usage.output of messages that already ended in this run
let streamedChars = 0; // characters streamed for the in-progress message
let partialUsageTokens = 0; // usage.output reported for the in-progress message
let shownTokens = 0; // animated display value
let lastTokenAnimAt = 0;
let thinking = false; // a thinking block is streaming
let toolStartedAt: number | undefined; // a tool is executing
let lastToolMs: number | undefined; // duration of the last tool in this run (`ran tool for Ns`)

function pickVerb(): string {
	return VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";
}

const frames = spinnerFrames;

/** Claude: round(((1 - cos(2πt/T)) / 2) * (frames.length - 1)) → forward then back, easing at the ends. */
function frameAt(elapsedMs: number): string {
	const f = frames();
	const wave = (1 - Math.cos((2 * Math.PI * elapsedMs) / FRAME_PERIOD_MS)) / 2;
	return f[Math.round(wave * (f.length - 1))] ?? f[0] ?? "✻";
}

function targetTokens(): number {
	return finishedTokens + Math.max(partialUsageTokens, Math.round(streamedChars / 4));
}

/** Animate `shownTokens` toward the real count the way Claude does (steps every 50 ms). */
function animateTokens(now: number): void {
	const target = targetTokens();
	if (lastTokenAnimAt === 0) {
		lastTokenAnimAt = now;
		shownTokens = target;
		return;
	}
	const steps = Math.floor((now - lastTokenAnimAt) / 50);
	if (steps <= 0) return;
	lastTokenAnimAt += steps * 50;
	for (let i = 0; i < steps; i++) {
		const diff = target - shownTokens;
		if (diff === 0) break;
		const mag = Math.abs(diff);
		const step = mag < 70 ? 3 : mag < 200 ? Math.max(8, Math.ceil(mag * 0.15)) : 50;
		shownTokens = diff > 0 ? Math.min(shownTokens + step, target) : Math.max(shownTokens - step, target);
	}
}

/** Verb + ellipsis in orange, with a 3-cell shimmer window travelling right → left. */
function renderMessage(message: string, elapsedMs: number): string {
	const chars = Array.from(message);
	const width = chars.length;
	const span = width + 2 * GLIMMER_RUNOUT;
	const tick = Math.floor(elapsedMs / GLIMMER_STEP_MS);
	const center = width + GLIMMER_RUNOUT - (tick % span);
	const lo = center - 1;
	const hi = center + 1;
	if (lo >= width || hi < 0) return `${FG.claudio}${message}${FG_RESET}`;
	let before = "";
	let shimmer = "";
	let after = "";
	chars.forEach((ch, i) => {
		if (i < lo) before += ch;
		else if (i > hi) after += ch;
		else shimmer += ch;
	});
	const base = FG.claudio;
	return `${base}${before}${FG.claudioShimmer}${shimmer}${base}${after}${FG_RESET}`;
}

function renderRow(width: number, now: number): string {
	const elapsedMs = now - startedAt;
	animateTokens(now);
	// Claude swaps the random verb for the in-progress todo's activeForm ("Running tests…").
	const message = bus.get("currentTodo")?.activeForm ?? verb;
	const head = `${FG.claudio}${frameAt(elapsedMs)}${FG_RESET} ${renderMessage(message + ELLIPSIS, elapsedMs)}`;
	// `esc to interrupt` lives in the footer hint; the spinner carries
	// [dialog waiting] · elapsed · ↓ tokens · thinking | running tool for Ns | ran tool for Ns.
	const items: string[] = [];
	const dialog = bus.get("dialog");
	if (dialog?.kind === "permission" || dialog?.kind === "ask") items.push("dialog waiting");
	// Elapsed is hidden until the turn has run > 16 s, tokens arrived, or the model is thinking.
	if (elapsedMs > 16_000 || shownTokens > 0 || thinking) items.push(formatDuration(elapsedMs));
	if (shownTokens > 0) items.push(`↓ ${formatTokens(shownTokens)} tokens`);
	if (toolStartedAt !== undefined && dialog?.kind !== "permission" && dialog?.kind !== "ask") items.push(`running tool for ${formatDuration(now - toolStartedAt)}`);
	else if (lastToolMs !== undefined) items.push(`ran tool for ${formatDuration(lastToolMs)}`);
	else if (thinking) items.push("thinking");
	// Drop items right-to-left when they do not fit (Claude does the same).
	let status = "";
	for (let n = items.length; n > 0; n--) {
		const candidate = ` (${items.slice(0, n).join(" · ")})`;
		if (visibleWidth(head) + visibleWidth(candidate) <= width) {
			status = candidate;
			break;
		}
	}
	return truncateToWidth(`${head}${DIM}${status}${DIM_RESET}`, width, "");
}

// ── widget component ────────────────────────────────────────────────────────────────────
class SpinnerWidget implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly tui: TUI;
	constructor(tui: TUI) {
		this.tui = tui;
	}

	/** Called from agent_start / agent_end; animation runs only while active. */
	sync(): void {
		if (active && !this.timer) {
			this.timer = setInterval(() => this.tui.requestRender(), TICK_MS);
		} else if (!active && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		// Pi draws its own row while compacting.
		if (compacting) return [];
		if (!active) return [""];
		return [renderRow(width, Date.now())];
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

let widget: SpinnerWidget | undefined;

// ── terminal title ──────────────────────────────────────────────────────────────────────
let titleTimer: ReturnType<typeof setInterval> | undefined;
let titleFrame = 0;

function baseTitle(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName() ?? APP_NAME;
}

function setIdleTitle(ctx: ExtensionContext): void {
	if (titleTimer) clearInterval(titleTimer);
	titleTimer = undefined;
	ctx.ui.setTitle(`${TITLE_STATIC} ${baseTitle(ctx)}`);
}

/** Pi re-asserts its own `π - <cwd>` title after session_start / session_info_changed; re-apply ours a little later. */
const idleTitleTimers = new Set<ReturnType<typeof setTimeout>>();
function reassertIdleTitle(ctx: ExtensionContext): void {
	setIdleTitle(ctx);
	for (const delay of [50, 500, 2000]) {
		const t = setTimeout(() => {
			idleTitleTimers.delete(t);
			if (!active) setIdleTitle(ctx);
		}, delay);
		idleTitleTimers.add(t);
	}
}
function clearIdleTitleTimers(): void {
	for (const t of idleTitleTimers) clearTimeout(t);
	idleTitleTimers.clear();
}

function setWorkingTitle(ctx: ExtensionContext): void {
	if (titleTimer) clearInterval(titleTimer);
	titleTimer = undefined;
	if (process.env.TMUX) {
		// Claude keeps the title static under a multiplexer.
		ctx.ui.setTitle(`${TITLE_STATIC} ${baseTitle(ctx)}`);
		return;
	}
	const tick = () => {
		titleFrame = (titleFrame + 1) % TITLE_FRAMES.length;
		ctx.ui.setTitle(`${TITLE_FRAMES[titleFrame]} ${baseTitle(ctx)}`);
	};
	tick();
	titleTimer = setInterval(tick, TITLE_INTERVAL_MS);
}

// ── setup ───────────────────────────────────────────────────────────────────────────────
export function setupSpinner(pi: ExtensionAPI): void {
	const stop = (ctx?: ExtensionContext) => {
		active = false;
		widget?.sync();
		if (ctx && ctx.mode === "tui") setIdleTitle(ctx);
		else if (titleTimer) {
			clearInterval(titleTimer);
			titleTimer = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		active = false;
		compacting = false;
		// Hide Pi's own working row; we draw ours as a widget just above the editor.
		ctx.ui.setWorkingVisible(false);
		// Register the widget once, so it keeps its slot (before widgets added later) and holds its
		// row while idle. The animation timer only runs between agent_start and agent_end.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				widget = new SpinnerWidget(tui);
				return widget;
			},
			{ placement: "aboveEditor" },
		);
		reassertIdleTitle(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode !== "tui" || active) return;
		reassertIdleTitle(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		startedAt = Date.now();
		verb = pickVerb();
		finishedTokens = 0;
		streamedChars = 0;
		partialUsageTokens = 0;
		shownTokens = 0;
		lastTokenAnimAt = 0;
		thinking = false;
		toolStartedAt = undefined;
		lastToolMs = undefined;
		active = true;
		widget?.sync();
		setWorkingTitle(ctx);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		streamedChars = 0;
		partialUsageTokens = 0;
		thinking = false;
		// Once the model speaks again the `ran tool for Ns` item is retired.
		lastToolMs = undefined;
	});

	pi.on("tool_execution_start", () => {
		toolStartedAt = Date.now();
	});
	// Time spent in a permission dialog does not count as "running tool" (the task list does not reset it).
	bus.subscribe("dialog", (current, previous) => {
		if (current === null && (previous?.kind === "permission" || previous?.kind === "ask") && toolStartedAt !== undefined) toolStartedAt = Date.now();
	});
	pi.on("tool_execution_end", () => {
		if (toolStartedAt !== undefined) lastToolMs = Date.now() - toolStartedAt;
		toolStartedAt = undefined;
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const ev = event.assistantMessageEvent;
		if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
			streamedChars += ev.delta.length;
		}
		if (ev.type === "thinking_start" || ev.type === "thinking_delta") thinking = true;
		else if (ev.type === "thinking_end" || ev.type === "text_start" || ev.type === "toolcall_start") thinking = false;
		partialUsageTokens = (event.message as AssistantMessage).usage.output;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const final = (event.message as AssistantMessage).usage.output;
		finishedTokens += final > 0 ? final : Math.round(streamedChars / 4);
		streamedChars = 0;
		partialUsageTokens = 0;
	});

	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});

	pi.on("agent_end", (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", () => {
		stop();
		clearIdleTitleTimers();
		widget?.dispose();
		widget = undefined;
	});
}
