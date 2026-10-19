/**
 * rewind.ts — "Rewind" (Esc Esc on an empty prompt, or `/rewind`), inspired by Claude Code.
 *
 * 1. File checkpoints: before `edit` / `write` (or any mutating tool with a `path` argument) runs,
 *    the file's current content (or "absent") is snapshotted, keyed by the user message that
 *    started the turn. Only the FIRST snapshot per (file, user turn) is kept — the pre-state.
 *    Snapshots live in memory and under `~/.pi/agent/claudio/checkpoints/<sessionId>/<turnId>/` so a resumed
 *    session can still rewind. Files over 2 MB are skipped.
 * 2. Picker (`ctx.ui.custom`, same dialog chrome as the permission prompt): the user messages on
 *    the current branch, newest first, then "Rewind to this message?" with
 *    Restore code and conversation / Restore conversation / Restore code / Never mind
 *    (code options only when a checkpoint exists at or after that turn).
 * 3. Actions: conversation → `ctx.navigateTree(userMessageId)` (Pi moves the leaf to the parent and
 *    puts the prompt back in the editor); code → write back the earliest snapshot at or after the
 *    turn for every file (delete when it was absent). Checkpoints from the rewind point on are dropped.
 *
 * The editor (chrome.ts) triggers the picker through `actions.openRewind`, which sends `/rewind`
 * via `pi.sendUserMessage(..., { expandPromptTemplates: true })` — the only way to reach the
 * command context (`navigateTree`) from a key handler.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { actions, ANSI, bus, dialogInnerWidth, dialogLines, dim, ELLIPSIS, FG, pluralize, POINTER, stateDir, success } from "./shared.ts";

// ───────────────────────────── storage ─────────────────────────────

const STATE_DIR = join(stateDir(), "checkpoints");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Tools that never mutate the file at `input.path`. */
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find", "glob", "bash", "powershell"]);

interface Snapshot {
	/** Absolute path of the file. */
	path: string;
	/** The file did not exist before the turn. */
	absent: boolean;
	/** Pre-state bytes (loaded lazily from `file` for persisted snapshots). */
	data?: Buffer;
	/** On-disk JSON record, when persisted. */
	file?: string;
}

interface PersistedSnapshot {
	path: string;
	absent: boolean;
	data?: string; // base64
}

/** turnId → (absolute path → pre-state). */
const checkpoints = new Map<string, Map<string, Snapshot>>();
let loadedSessionId: string | undefined;

function sessionDir(sessionId: string): string {
	return join(STATE_DIR, sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

function recordFile(sessionId: string, turnId: string, path: string): string {
	const hash = createHash("sha1").update(path).digest("hex").slice(0, 16);
	return join(sessionDir(sessionId), turnId.replace(/[^A-Za-z0-9_.-]/g, "_"), `${hash}.json`);
}

/** Populate the in-memory map from disk for a (resumed) session. Cheap: records are read lazily. */
function loadSession(sessionId: string): void {
	if (loadedSessionId === sessionId) return;
	checkpoints.clear();
	loadedSessionId = sessionId;
	const dir = sessionDir(sessionId);
	if (!existsSync(dir)) return;
	try {
		for (const turnId of readdirSync(dir)) {
			const turnDir = join(dir, turnId);
			let files: string[];
			try {
				files = readdirSync(turnDir).filter((f) => f.endsWith(".json"));
			} catch {
				continue;
			}
			const map = new Map<string, Snapshot>();
			for (const f of files) {
				try {
					const rec = JSON.parse(readFileSync(join(turnDir, f), "utf8")) as PersistedSnapshot;
					if (typeof rec.path === "string") map.set(rec.path, { path: rec.path, absent: !!rec.absent, file: join(turnDir, f) });
				} catch {
					/* corrupt record — ignore */
				}
			}
			if (map.size > 0) checkpoints.set(turnId, map);
		}
	} catch {
		/* unreadable state dir */
	}
}

function snapshotData(s: Snapshot): Buffer | undefined {
	if (s.absent) return undefined;
	if (s.data) return s.data;
	if (!s.file) return undefined;
	try {
		const rec = JSON.parse(readFileSync(s.file, "utf8")) as PersistedSnapshot;
		s.data = Buffer.from(rec.data ?? "", "base64");
		return s.data;
	} catch {
		return undefined;
	}
}

/** Snapshot `path` for `turnId` unless a pre-state is already recorded. */
function takeSnapshot(sessionId: string, turnId: string, path: string): void {
	let map = checkpoints.get(turnId);
	if (map?.has(path)) return;
	let snap: Snapshot;
	try {
		if (!existsSync(path)) snap = { path, absent: true };
		else {
			const st = statSync(path);
			if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
			snap = { path, absent: false, data: readFileSync(path) };
		}
	} catch {
		return;
	}
	if (!map) {
		map = new Map();
		checkpoints.set(turnId, map);
	}
	map.set(path, snap);
	try {
		const file = recordFile(sessionId, turnId, path);
		mkdirSync(dirname(file), { recursive: true });
		const rec: PersistedSnapshot = { path, absent: snap.absent, data: snap.data?.toString("base64") };
		writeFileSync(file, JSON.stringify(rec));
		snap.file = file;
	} catch {
		/* persistence is best-effort; the in-memory copy still works */
	}
}

function dropTurns(sessionId: string, turnIds: readonly string[]): void {
	for (const id of turnIds) {
		checkpoints.delete(id);
		try {
			rmSync(join(sessionDir(sessionId), id.replace(/[^A-Za-z0-9_.-]/g, "_")), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

// ───────────────────────────── session helpers ─────────────────────────────

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface UserTurn {
	id: string;
	text: string;
	timestamp: number;
	/** Index of the entry on the branch (root → leaf). */
	index: number;
}

function userText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** User messages on the current branch, root → leaf. Empty-text turns (image only) show a placeholder. */
function userTurns(sm: ReadonlySessionManager): UserTurn[] {
	const out: UserTurn[] = [];
	sm.getBranch().forEach((entry, index) => {
		const text = userText(entry);
		if (text === undefined) return;
		out.push({ id: entry.id, text: text.trim() || "(image)", timestamp: Date.parse(entry.timestamp) || Date.now(), index });
	});
	return out;
}

function currentTurnId(sm: ReadonlySessionManager): string | undefined {
	const branch = sm.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]!;
		if (e.type === "message" && e.message.role === "user") return e.id;
	}
	return undefined;
}

/** Paths that have a checkpoint at or after `turn` on the branch, with the earliest pre-state for each. */
function snapshotsFrom(turns: readonly UserTurn[], turn: UserTurn): { files: Map<string, Snapshot>; turnIds: string[] } {
	const files = new Map<string, Snapshot>();
	const turnIds: string[] = [];
	for (const t of turns) {
		if (t.index < turn.index) continue;
		turnIds.push(t.id);
		const map = checkpoints.get(t.id);
		if (!map) continue;
		for (const [path, snap] of map) if (!files.has(path)) files.set(path, snap);
	}
	return { files, turnIds };
}

function restoreFiles(files: Map<string, Snapshot>): number {
	let restored = 0;
	for (const snap of files.values()) {
		try {
			if (snap.absent) {
				if (existsSync(snap.path)) unlinkSync(snap.path);
			} else {
				const data = snapshotData(snap);
				if (!data) continue;
				mkdirSync(dirname(snap.path), { recursive: true });
				writeFileSync(snap.path, data);
			}
			restored++;
		} catch {
			/* leave the file as is */
		}
	}
	return restored;
}

function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function clockTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ───────────────────────────── picker dialog ─────────────────────────────

type RewindAction = "both" | "conversation" | "code";
interface RewindChoice {
	turn: UserTurn;
	action: RewindAction;
}
interface ActionOption {
	value: RewindAction | "cancel";
	label: string;
}

const PERM = FG.permission;
const FG_RESET = ANSI.fgReset;

class RewindDialog implements Component, Focusable {
	focused = false;
	/** Rows newest first. */
	private readonly rows: UserTurn[];
	private selected = 0;
	private picked: UserTurn | undefined;
	private options: ActionOption[] = [];
	private optionIndex = 0;

	constructor(
		turns: readonly UserTurn[],
		private readonly hasCheckpoints: (turn: UserTurn) => boolean,
		private readonly done: (choice: RewindChoice | undefined) => void,
	) {
		this.rows = [...turns].reverse();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) return this.done(undefined);
		if (this.picked) {
			const n = this.options.length;
			if (matchesKey(data, "escape")) {
				this.picked = undefined; // back to the list
				return;
			}
			if (matchesKey(data, "up")) this.optionIndex = (this.optionIndex + n - 1) % n;
			else if (matchesKey(data, "down")) this.optionIndex = (this.optionIndex + 1) % n;
			else if (matchesKey(data, "enter")) this.chooseAction(this.optionIndex);
			else if (/^[1-9]$/.test(data) && Number(data) <= n) this.chooseAction(Number(data) - 1);
			return;
		}
		const n = this.rows.length;
		if (matchesKey(data, "escape")) return this.done(undefined);
		if (matchesKey(data, "up")) this.selected = (this.selected + n - 1) % n;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % n;
		else if (matchesKey(data, "enter")) this.pick(this.selected);
		else if (/^[1-9]$/.test(data) && Number(data) <= n) this.pick(Number(data) - 1);
	}

	private pick(index: number): void {
		const turn = this.rows[index];
		if (!turn) return;
		this.selected = index;
		this.picked = turn;
		this.optionIndex = 0;
		this.options = this.hasCheckpoints(turn)
			? [
					{ value: "both", label: "Restore code and conversation" },
					{ value: "conversation", label: "Restore conversation" },
					{ value: "code", label: "Restore code" },
				]
			: [{ value: "conversation", label: "Restore conversation" }];
		this.options.push({ value: "cancel", label: "Never mind" });
	}

	private chooseAction(index: number): void {
		const opt = this.options[index];
		if (!opt || !this.picked) return;
		if (opt.value === "cancel") return this.done(undefined);
		this.done({ turn: this.picked, action: opt.value });
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = dialogInnerWidth(width);
		const body: string[] = [""];
		if (this.picked) {
			body.push(dim(truncateToWidth(firstLine(this.picked.text), inner, ELLIPSIS)));
			body.push("");
			body.push("Rewind to this message?");
			this.options.forEach((opt, i) => {
				const label = `${i + 1}. ${opt.label}`;
				body.push(i === this.optionIndex ? `${PERM}${POINTER} ${label}${FG_RESET}` : `  ${label}`);
			});
			return dialogLines(width, "permission", "Rewind to a previous message", undefined, body);
		}
		const now = Date.now();
		this.rows.forEach((turn, i) => {
			const sel = i === this.selected;
			const time = relativeTime(turn.timestamp, now) + (i === 0 ? " (current)" : "");
			const prefix = `${sel ? POINTER : " "} ${i + 1}. `;
			const textWidth = Math.max(8, inner - visibleWidth(prefix) - visibleWidth(time) - 2);
			const text = truncateToWidth(firstLine(turn.text), textWidth, ELLIPSIS);
			const gap = Math.max(1, inner - visibleWidth(prefix) - visibleWidth(text) - visibleWidth(time));
			const row = `${prefix}${text}${" ".repeat(gap)}${dim(time)}`;
			body.push(sel ? `${PERM}${row}${FG_RESET}` : row);
		});
		body.push("");
		body.push(dim("↑/↓ to select · enter to confirm · esc to cancel"));
		return dialogLines(width, "permission", "Rewind to a previous message", undefined, body);
	}
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return line.replace(/\s+/g, " ").trim();
}

// ───────────────────────────── setup ─────────────────────────────

export function setupRewind(pi: ExtensionAPI): void {
	// 1. Checkpoints before every mutating tool call.
	pi.on("tool_call", (event, ctx) => {
		if (READ_ONLY_TOOLS.has(event.toolName)) return;
		const input = event.input as Record<string, unknown> | undefined;
		const raw = input?.path;
		if (typeof raw !== "string" || raw.length === 0) return;
		// Built-in edit/write plus custom tools whose name says they mutate (e.g. multi_edit, append_file).
		if (!/^(edit|write|create|append|patch|replace|delete|remove|move|rename|multi_?edit)/i.test(event.toolName)) return;
		const sm = ctx.sessionManager;
		const turnId = currentTurnId(sm);
		if (!turnId) return;
		const sessionId = sm.getSessionId();
		loadSession(sessionId);
		const path = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw);
		takeSnapshot(sessionId, turnId, path);
	});

	pi.on("session_start", (_e, ctx) => {
		loadSession(ctx.sessionManager.getSessionId());
		if (ctx.mode === "tui") actions.openRewind = () => void pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
	});
	pi.on("session_shutdown", () => {
		actions.openRewind = undefined;
	});

	// 2 + 3. The picker and its actions.
	const rewind = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("Rewind is only available in the interactive UI", "info");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Rewind is unavailable while the agent is working — press esc to interrupt first", "warning");
			return;
		}
		const sm = ctx.sessionManager;
		const sessionId = sm.getSessionId();
		loadSession(sessionId);
		const turns = userTurns(sm);
		if (turns.length === 0) {
			ctx.ui.notify("No messages to rewind to yet", "info");
			return;
		}
		const hasCheckpoints = (turn: UserTurn) => snapshotsFrom(turns, turn).files.size > 0;

		bus.set("dialog", { kind: "rewind" });
		let choice: RewindChoice | undefined;
		try {
			choice = await ctx.ui.custom<RewindChoice | undefined>((_tui, _theme, _kb, done) => new RewindDialog(turns, hasCheckpoints, done), {
				overlay: false,
			});
		} finally {
			bus.set("dialog", null);
		}
		if (!choice) return;
		const { turn, action } = choice;

		let restoredFiles = 0;
		const { files, turnIds } = snapshotsFrom(turns, turn);
		if (action === "code" || action === "both") restoredFiles = restoreFiles(files);

		let conversationRestored = false;
		if (action === "conversation" || action === "both") {
			const result = await ctx.navigateTree(turn.id);
			if (result.cancelled) {
				ctx.ui.notify("Rewind cancelled", "info");
			} else {
				conversationRestored = true;
				// Pi already copies the prompt into an empty editor; make sure it is there.
				if (!ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(turn.text === "(image)" ? "" : turn.text);
			}
		}

		// Everything from the rewind point on is history now (code restored or the branch abandoned).
		if (action === "both" || (action === "conversation" && conversationRestored) || action === "code") dropTurns(sessionId, turnIds);

		const parts: string[] = [];
		if (conversationRestored) parts.push("conversation");
		if (action === "code" || action === "both") parts.push(pluralize(restoredFiles, "file"));
		if (parts.length === 0) return;
		ctx.ui.notify(`${success("✓")} Rewound to ${clockTime(turn.timestamp)} ${dim("·")} restored ${parts.join(" and ")}`, "info");
	};

	pi.registerCommand("rewind", {
		description: "Rewind to a previous message (restore code and/or conversation)",
		handler: (_args, ctx) => rewind(ctx),
	});
}

