/**
 * shared.ts — constants and helpers shared by every module of pi-ember (a UI inspired by Claude Code).
 *
 * Pure module: no side effects, no timers (only `getAgentDir` from pi-coding-agent and pi-tui width helpers).
 * Everything here is safe to import from any other module.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import * as path from "node:path";

// ───────────────────────────────────────────────────────────────────────────────
// Palette (warm dark palette inspired by Claude Code's `dark` theme)
// ───────────────────────────────────────────────────────────────────────────────

export type Rgb = readonly [r: number, g: number, b: number];

export const RGB = {
	ember: [215, 119, 87],
	emberShimmer: [235, 159, 127],
	permission: [177, 185, 249],
	permissionShimmer: [207, 215, 255],
	suggestion: [177, 185, 249],
	autoAccept: [175, 135, 255],
	planMode: [72, 150, 140],
	bashBorder: [253, 93, 177],
	promptBorder: [136, 136, 136],
	text: [255, 255, 255],
	inactive: [153, 153, 153],
	subtle: [80, 80, 80],
	success: [78, 186, 101],
	error: [255, 107, 128],
	warning: [255, 193, 7],
	diffAdded: [34, 92, 43],
	diffRemoved: [122, 41, 54],
	diffAddedDimmed: [71, 88, 74],
	diffRemovedDimmed: [105, 72, 77],
	diffAddedWord: [56, 166, 96],
	diffRemovedWord: [179, 89, 107],
	userMessageBg: [55, 55, 55],
	bashMessageBg: [65, 60, 65],
	selectionBg: [38, 79, 120],
	ide: [71, 130, 200],
	professionalBlue: [106, 155, 204],
} as const satisfies Record<string, Rgb>;

export type PaletteKey = keyof typeof RGB;

/** Hex form of the palette (handy for theme files / pi-tui `parseColor`). */
export function rgbToHex([r, g, b]: Rgb): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Raw ANSI (truecolor). Pi resets all styles after every rendered line, so these
// helpers re-open the style on every line of a multi-line string and close it with
// the *specific* terminator (39/49/22/23/29) rather than `\x1b[0m`, so they nest.
// ───────────────────────────────────────────────────────────────────────────────

export const ANSI = {
	fgReset: "\x1b[39m",
	bgReset: "\x1b[49m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	/** Closes both bold and dim. */
	boldDimReset: "\x1b[22m",
	italic: "\x1b[3m",
	italicReset: "\x1b[23m",
	strike: "\x1b[9m",
	strikeReset: "\x1b[29m",
	reset: "\x1b[0m",
} as const;

/** Foreground escape prefix for an RGB triple. */
export function fgAnsi([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}
/** Background escape prefix for an RGB triple. */
export function bgAnsi([r, g, b]: Rgb): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Ready-made foreground prefixes: `FG.ember + "●" + ANSI.fgReset`. */
export const FG = Object.fromEntries(
	(Object.keys(RGB) as PaletteKey[]).map((k) => [k, fgAnsi(RGB[k])]),
) as Record<PaletteKey, string>;

/** Ready-made background prefixes: `BG.diffAdded + line + ANSI.bgReset`. */
export const BG = Object.fromEntries(
	(Object.keys(RGB) as PaletteKey[]).map((k) => [k, bgAnsi(RGB[k])]),
) as Record<PaletteKey, string>;

function perLine(text: string, open: string, close: string): string {
	if (text.length === 0) return text;
	return text
		.split("\n")
		.map((line) => (line.length === 0 ? line : `${open}${line}${close}`))
		.join("\n");
}

/** Colour `text` with a palette key or raw RGB foreground. Re-applied on every line. */
export function fg(color: PaletteKey | Rgb, text: string): string {
	const open = typeof color === "string" ? FG[color] : fgAnsi(color);
	return perLine(text, open, ANSI.fgReset);
}
/** Paint a background behind `text`. Re-applied on every line. */
export function bg(color: PaletteKey | Rgb, text: string): string {
	const open = typeof color === "string" ? BG[color] : bgAnsi(color);
	return perLine(text, open, ANSI.bgReset);
}
/** SGR 2 (Ink `dimColor`). */
export function dim(text: string): string {
	return perLine(text, ANSI.dim, ANSI.boldDimReset);
}
export function bold(text: string): string {
	return perLine(text, ANSI.bold, ANSI.boldDimReset);
}
export function italic(text: string): string {
	return perLine(text, ANSI.italic, ANSI.italicReset);
}
export function strike(text: string): string {
	return perLine(text, ANSI.strike, ANSI.strikeReset);
}
// Convenience colour shorthands (most used ones).
export const ember = (t: string): string => fg("ember", t);
export const emberShimmer = (t: string): string => fg("emberShimmer", t);
export const permission = (t: string): string => fg("permission", t);
export const suggestion = (t: string): string => fg("suggestion", t);
export const autoAccept = (t: string): string => fg("autoAccept", t);
export const planMode = (t: string): string => fg("planMode", t);
export const bashBorder = (t: string): string => fg("bashBorder", t);
export const promptBorder = (t: string): string => fg("promptBorder", t);
export const success = (t: string): string => fg("success", t);
export const error = (t: string): string => fg("error", t);
export const warning = (t: string): string => fg("warning", t);
export const inactive = (t: string): string => fg("inactive", t);
export const subtle = (t: string): string => fg("subtle", t);

/** Strip every SGR sequence (for measuring / logging). */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ───────────────────────────────────────────────────────────────────────────────
// Glyphs
// ───────────────────────────────────────────────────────────────────────────────

export const BULLET = "●"; // U+25CF — every message / tool row on Linux
/** Indent for continuation lines under a CONNECTOR row (aligned with the first result char). */
export const RESULT_INDENT = "     ";
export const ARROW_DOWN = "↓";
export const ARROW_UP = "↑";
export const ARROW_HOOK = "↳"; // U+21B3 queued messages
export const DOT = "·"; // U+00B7 separator
export const ELLIPSIS = "…"; // U+2026
export const POINTER = "❯"; // U+276F selected menu item
export const POINTER_SMALL = "›"; // U+203A
export const TRIANGLE = "▸"; // U+25B8
export const AUTO_ACCEPT_GLYPH = "⏵⏵"; // U+23F5×2
export const PLAN_MODE_GLYPH = "⏸"; // U+23F8
export const CHECKBOX_OFF = "☐"; // U+2610
export const CHECKBOX_ON = "☒"; // U+2612
export const TASK_PENDING = "◻"; // U+25FB
export const TASK_IN_PROGRESS = "◼"; // U+25FC
export const TASK_DONE = "✔"; // U+2714
export const CROSS = "✕"; // U+2715
export const WARN = "⚠"; // U+26A0
export const STOPPED = "■";
export const SEPARATOR = ` ${DOT} `; // " · "

export const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	vertical: "│",
	horizontal: "─",
	double: "═",
} as const;

export const TREE = {
	branch: "├",
	last: "└",
	vertical: "│",
	tee: "┬",
	bottomTee: "┴",
} as const;

/** Spinner frames. Outside ghostty `✳` (U+2733) is swapped for a plain `*` (it renders badly in many fonts). */
export const SPINNER_FRAMES_GHOSTTY: readonly string[] = ["·", "✢", "✳", "✶", "✻", "✽"];
export const SPINNER_FRAMES_OTHER: readonly string[] = ["·", "✢", "*", "✶", "✻", "✽"];
export function spinnerFrames(): readonly string[] {
	return process.env.TERM === "xterm-ghostty" ? SPINNER_FRAMES_GHOSTTY : SPINNER_FRAMES_OTHER;
}

// ───────────────────────────────────────────────────────────────────────────────
// Spinner verbs (the whimsical gerund list popularised by Claude Code)
// ───────────────────────────────────────────────────────────────────────────────

export const VERBS: readonly string[] =
	"Accomplishing,Actioning,Actualizing,Architecting,Baking,Beaming,Beboppin',Befuddling,Billowing,Blanching,Bloviating,Boogieing,Boondoggling,Booping,Bootstrapping,Brewing,Bunning,Burrowing,Calculating,Canoodling,Caramelizing,Cascading,Catapulting,Cerebrating,Channeling,Choreographing,Churning,Coalescing,Cogitating,Combobulating,Composing,Computing,Concocting,Considering,Contemplating,Cooking,Crafting,Creating,Crunching,Crystallizing,Cultivating,Deciphering,Deliberating,Determining,Dilly-dallying,Discombobulating,Doodling,Drizzling,Ebbing,Effecting,Elucidating,Embellishing,Enchanting,Envisioning,Fermenting,Fiddle-faddling,Finagling,Flibbertigibbeting,Flowing,Flummoxing,Fluttering,Forging,Forming,Frolicking,Frosting,Gallivanting,Galloping,Garnishing,Generating,Gesticulating,Germinating,Gitifying,Grooving,Gusting,Harmonizing,Hashing,Hatching,Herding,Honking,Hullaballooing,Hyperspacing,Ideating,Imagining,Improvising,Incubating,Inferring,Infusing,Ionizing,Jitterbugging,Julienning,Kerfuffling,Kneading,Leavening,Levitating,Lollygagging,Manifesting,Marinating,Meandering,Metamorphosing,Misting,Moonwalking,Moseying,Mulling,Mustering,Nebulizing,Nesting,Newspapering,Noodling,Nucleating,Onioning,Orbiting,Orchestrating,Osmosing,Perambulating,Percolating,Perusing,Philosophizing,Photosynthesizing,Polishing,Pollinating,Pondering,Pontificating,Pouncing,Precipitating,Prestidigitating,Proofing,Propagating,Puttering,Puzzling,Quantumizing,Razzle-dazzling,Razzmatazzing,Recombobulating,Reticulating,Roosting,Ruminating,Scampering,Schlepping,Scurrying,Seasoning,Shenaniganing,Shimmying,Simmering,Skedaddling,Sketching,Slithering,Smooshing,Sock-hopping,Spelunking,Spinning,Sprouting,Stewing,Sublimating,Swirling,Swooping,Symbioting,Synthesizing,Tempering,Thundering,Tinkering,Tomfoolering,Topsy-turvying,Transfiguring,Transmogrifying,Transmuting,Twisting,Undulating,Unfurling,Unraveling,Vibing,Waddling,Wandering,Warping,Whatchamacalliting,Whirlpooling,Whirring,Whisking,Wibbling,Wrangling,Zesting,Zigzagging".split(
		",",
	);

/** Placeholder examples for the prompt box: `Try "fix lint errors"`. */
export const PLACEHOLDER_EXAMPLES: readonly string[] = [
	"fix lint errors",
	"fix typecheck errors",
	"how does <file> work?",
	"refactor <file>",
	"how do I log an error?",
	"edit <file> to...",
	"write a test for <file>",
	"create a util logging.py that...",
];
// ───────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ───────────────────────────────────────────────────────────────────────────────

const compactFmtFrac = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
});
const compactFmtInt = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
	minimumFractionDigits: 0,
});

/**
 * Compact token count: `340`, `1.2k`, `12.4k`, `120.3k`, `1.5m`.
 * (Binary: Intl compact notation, lower-cased, trailing `.0` removed.)
 */
export function formatTokens(n: number): string {
	const v = Math.max(0, Math.floor(n));
	const s = (v >= 1000 ? compactFmtFrac : compactFmtInt).format(v).toLowerCase();
	return s.replace(".0", "");
}

/**
 * Human duration: `12s`, `1m 12s`, `1h 2m 3s`, `2d 3h 4m`.
 * With `hideTrailingZeros` the zero components at the end are dropped (`1m` instead of `1m 0s`).
 */
export function formatDuration(ms: number, opts?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean }): string {
	const e = Math.max(0, ms);
	if (e < 60_000) return `${Math.floor(e / 1000)}s`;
	let d = Math.floor(e / 86_400_000);
	let h = Math.floor((e % 86_400_000) / 3_600_000);
	let m = Math.floor((e % 3_600_000) / 60_000);
	let s = Math.round((e % 60_000) / 1000);
	if (s === 60) {
		s = 0;
		m++;
	}
	if (m === 60) {
		m = 0;
		h++;
	}
	if (h === 24) {
		h = 0;
		d++;
	}
	const o = opts?.hideTrailingZeros ?? false;
	if (opts?.mostSignificantOnly) {
		if (d > 0) return `${d}d`;
		if (h > 0) return `${h}h`;
		if (m > 0) return `${m}m`;
		return `${s}s`;
	}
	if (d > 0) {
		if (o && h === 0 && m === 0) return `${d}d`;
		if (o && m === 0) return `${d}d ${h}h`;
		return `${d}d ${h}h ${m}m`;
	}
	if (h > 0) {
		if (o && m === 0 && s === 0) return `${h}h`;
		if (o && s === 0) return `${h}h ${m}m`;
		return `${h}h ${m}m ${s}s`;
	}
	if (o && s === 0) return `${m}m`;
	return `${m}m ${s}s`;
}

/** `pluralize(1, "line")` → `"1 line"`, `pluralize(3, "line")` → `"3 lines"`. */
export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}
/**
 * Truncate in the middle with `…`, keeping both ends: `truncateMiddle("abcdefghij", 7)` → `"abc…hij"`.
 * Measures by display width (ANSI-free input expected).
 */
export function truncateMiddle(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const ellW = visibleWidth(ellipsis);
	if (maxWidth <= ellW) return truncateToWidth(ellipsis, maxWidth, "");
	const chars = Array.from(text);
	const keep = maxWidth - ellW;
	const headN = Math.ceil(keep / 2);
	const tailN = Math.floor(keep / 2);
	let head = "";
	for (const c of chars) {
		if (visibleWidth(head + c) > headN) break;
		head += c;
	}
	let tail = "";
	for (let i = chars.length - 1; i >= 0; i--) {
		const c = chars[i]!;
		if (visibleWidth(c + tail) > tailN) break;
		tail = c + tail;
	}
	return `${head}${ellipsis}${tail}`;
}

/** `"… +N lines"`; `"… +1 line"` for one. */
export function moreLines(n: number): string {
	return `${ELLIPSIS} +${pluralize(n, "line")}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Paths
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Directory for everything pi-ember persists (permission allow-lists, file checkpoints):
 * `~/.pi/agent/ember`. Never inside the package directory, so updates/reinstalls keep the state.
 */
export function stateDir(): string {
	return path.join(getAgentDir(), "ember");
}

/** Replace a leading home directory with `~`. */
export function tildify(p: string): string {
	const home = os.homedir();
	if (!home) return p;
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
	return p;
}

/**
 * Path as shown in tool titles: relative to `cwd` when inside it, otherwise
 * `~`-abbreviated absolute. Never returns an empty string (cwd itself → `.`).
 */
export function relPath(cwd: string, p: string): string {
	if (!p) return p;
	const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
	const rel = path.relative(cwd, abs);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	return tildify(abs);
}

/**
 * Shorten a path to fit `maxWidth` by eliding middle segments: `/home/joan/…/deep/dir`.
 * The input is `~`-abbreviated first. Falls back to middle truncation for a single long segment.
 */
export function shortenPath(p: string, maxWidth: number): string {
	const t = tildify(p);
	if (visibleWidth(t) <= maxWidth) return t;
	const parts = t.split("/");
	// Keep the first segment and as many trailing segments as fit.
	const first = parts[0] ?? "";
	for (let keep = parts.length - 1; keep >= 1; keep--) {
		const tail = parts.slice(parts.length - keep).join("/");
		const candidate = `${first}/${ELLIPSIS}/${tail}`;
		if (visibleWidth(candidate) <= maxWidth) return candidate;
	}
	return truncateMiddle(t, maxWidth);
}

// ───────────────────────────────────────────────────────────────────────────────
// Cross-module state bus
// ───────────────────────────────────────────────────────────────────────────────

/** Permission modes (shift+tab cycles through PERMISSION_MODE_CYCLE). */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = ["bypassPermissions", "plan"];

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
	const i = PERMISSION_MODE_CYCLE.indexOf(mode);
	return PERMISSION_MODE_CYCLE[(i + 1) % PERMISSION_MODE_CYCLE.length] ?? "bypassPermissions";
}

/** Footer pill text + colour for a mode (`undefined` for default = nothing shown). */
export function permissionModePill(mode: PermissionMode): { text: string; color: PaletteKey } | undefined {
	switch (mode) {
		case "acceptEdits":
			return { text: `${AUTO_ACCEPT_GLYPH} accept edits on`, color: "autoAccept" };
		case "plan":
			return { text: `${PLAN_MODE_GLYPH} plan mode on`, color: "planMode" };
		case "bypassPermissions":
			return { text: `${AUTO_ACCEPT_GLYPH} bypass permissions on`, color: "error" };
		default:
			return undefined;
	}
}

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	/** Present-continuous label shown while in progress (e.g. "Running tests"). */
	activeForm?: string;
}

export type DialogState = { kind: "permission"; toolCallId: string } | { kind: "tasks" } | { kind: "rewind" };

export interface SharedState {
	permissionMode: PermissionMode;
	backgroundTaskCount: number;
	/** The in-progress todo; the spinner shows its `activeForm` instead of a random verb. */
	currentTodo: TodoItem | null;
	/** Whether tool outputs are globally expanded (ctrl+o). */
	toolsExpanded: boolean;
	/** The dialog currently replacing the editor (permission prompt for a tool call, or the task list), or null. */
	dialog: DialogState | null;
}

export type StateKey = keyof SharedState;
export type StateListener<K extends StateKey> = (value: SharedState[K], previous: SharedState[K]) => void;

const state: SharedState = {
	permissionMode: "bypassPermissions",
	backgroundTaskCount: 0,
	currentTodo: null,
	toolsExpanded: false,
	dialog: null,
};

const listeners = new Map<StateKey, Set<StateListener<StateKey>>>();
const anyListeners = new Set<(key: StateKey) => void>();

interface Bus {
	/** Typed read: `bus.get("permissionMode")` → `PermissionMode`. */
	get<K extends StateKey>(key: K): SharedState[K];
	/** Loosely typed read: `bus.get<string>("permissionMode")` → `string | undefined`. */
	get<T>(key: StateKey): T | undefined;
	set<K extends StateKey>(key: K, value: SharedState[K]): void;
	subscribe<K extends StateKey>(key: K, fn: StateListener<K>): () => void;
	subscribeAll(fn: (key: StateKey) => void): () => void;
	snapshot(): Readonly<SharedState>;
}

/** Typed cross-module state bus. Synchronous; listeners run inline on `set`. */
export const bus: Bus = {
	get(key: StateKey): any {
		return state[key];
	},
	set<K extends StateKey>(key: K, value: SharedState[K]): void {
		const previous = state[key];
		if (Object.is(previous, value)) return;
		state[key] = value;
		for (const fn of listeners.get(key) ?? []) {
			try {
				(fn as StateListener<K>)(value, previous);
			} catch {
				/* a broken listener must not break the others */
			}
		}
		for (const fn of anyListeners) {
			try {
				fn(key);
			} catch {
				/* ignore */
			}
		}
	},
	/** Subscribe to one key. Returns an unsubscribe function. */
	subscribe<K extends StateKey>(key: K, fn: StateListener<K>): () => void {
		let set = listeners.get(key);
		if (!set) {
			set = new Set();
			listeners.set(key, set);
		}
		set.add(fn as StateListener<StateKey>);
		return () => {
			set?.delete(fn as StateListener<StateKey>);
		};
	},
	/** Subscribe to every change (e.g. a footer that just needs `requestRender()`). */
	subscribeAll(fn: (key: StateKey) => void): () => void {
		anyListeners.add(fn);
		return () => {
			anyListeners.delete(fn);
		};
	},
	/** Read-only snapshot of everything. */
	snapshot(): Readonly<SharedState> {
		return { ...state };
	},
};

// Convenience accessors for the most shared key.
export function getPermissionMode(): PermissionMode {
	return bus.get("permissionMode");
}
export function setPermissionMode(mode: PermissionMode): void {
	bus.set("permissionMode", mode);
}
/** Advance to the next mode in the shift+tab cycle, publish it and return it. */
export function cyclePermissionMode(): PermissionMode {
	const next = nextPermissionMode(getPermissionMode());
	setPermissionMode(next);
	return next;
}

// ───────────────────────────────────────────────────────────────────────────────
// Cross-module actions (set by the owning module at session_start, called by the chrome)
// ───────────────────────────────────────────────────────────────────────────────

export const actions: {
	/** Open the Background tasks dialog (`/tasks`); set by background.ts. */
	openTasks?: () => void;
	/** Open the Rewind picker (`/rewind`, Esc Esc on an empty prompt); set by rewind.ts. */
	openRewind?: () => void;
} = {};

// ───────────────────────────────────────────────────────────────────────────────
// Dialog chrome: marginTop 1, a single top rule in the dialog colour
// (round border with left/right/bottom disabled), title row at paddingX 1, then the body at
// paddingX 1. No side or bottom borders.
// ───────────────────────────────────────────────────────────────────────────────

export function dialogLines(width: number, color: PaletteKey, title: string, subtitle: string | undefined, body: string[]): string[] {
	const w = Math.max(20, width);
	const out: string[] = ["", fg(color, BOX.horizontal.repeat(w))];
	out.push(truncateToWidth(` ${fg(color, bold(title))}`, w));
	if (subtitle) out.push(truncateToWidth(` ${dim(subtitle)}`, w));
	for (const line of body) out.push(truncateToWidth(` ${line}`, w, ELLIPSIS));
	return out;
}

/** Interior width available to a dialog body for a terminal of `width` columns (paddingX 1 both sides). */
export function dialogInnerWidth(width: number): number {
	return Math.max(16, Math.max(20, width) - 2);
}
