/**
 * setup.ts — `/claudio setup` and `/claudio status`.
 *
 * pi-claudio needs a few host settings to look right (scrollback-style TUI, no output padding, a quiet
 * startup because we draw our own header, collapsed thinking, and Pi's double-escape action disabled so
 * Esc Esc can open Rewind) and three keybindings (Esc interrupts, ctrl+o expands tool output, shift+tab
 * freed from `app.thinking.cycle` so it can cycle permission modes). The colours follow whatever Pi theme
 * is active; `light/claudio` is only written when the user has not chosen a theme.
 *
 * `/claudio setup` merges those into `~/.pi/agent/settings.json` and `~/.pi/agent/keybindings.json`
 * (other keys are kept) and installs the workflow package pi-claudio ships with (`npm:pi-extensible-workflows`,
 * see docs/workflows-eval.md) when it is missing. `/claudio status` reports what is applied. On session start a
 * single hint is shown when the setup is incomplete.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;

export const RECOMMENDED_SETTINGS: Readonly<Json> = {
	tuiMode: "regular",
	outputPad: 0,
	quietStartup: true,
	hideThinkingBlock: true,
	doubleEscapeAction: "none",
};

export const RECOMMENDED_KEYBINDINGS: Readonly<Record<string, string>> = {
	"app.interrupt": "escape",
	"app.tools.expand": "ctrl+o",
	"app.thinking.cycle": "alt+t",
};

/**
 * Theme written by `/claudio setup` when the user has no `theme` setting yet. The bundled `claudio`
 * theme is Claude Code's *dark* palette (white text), so it is paired with Pi's `light` theme in Pi's
 * `light/dark` form: light terminals get `light`, dark terminals get `claudio`. pi-claudio renders with
 * whatever Pi theme is active, so an existing choice such as `dark` or `system` is left alone.
 */
export const DEFAULT_THEME = "light/claudio";

/** The workflow package pi-claudio recommends and installs (the winner of docs/workflows-eval.md). */
export const WORKFLOWS_PACKAGE = "npm:pi-extensible-workflows";

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}
function keybindingsPath(): string {
	return join(getAgentDir(), "keybindings.json");
}

function readJson(file: string): Json {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
	} catch {
		return {};
	}
}

function writeJson(file: string, data: Json): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function bindingKeys(value: unknown): string[] {
	if (typeof value === "string") return [value.toLowerCase()];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
	return [];
}

/** True when `~/.pi/agent/keybindings.json` has freed shift+tab from `app.thinking.cycle`. */
export function shiftTabIsFree(): boolean {
	const binding = readJson(keybindingsPath())["app.thinking.cycle"];
	if (binding === undefined) return false;
	return !bindingKeys(binding).includes("shift+tab");
}

/** True when `~/.pi/agent/settings.json` lists the workflows package (`pi install` records packages there). */
export function workflowsInstalled(): boolean {
	const packages = readJson(settingsPath()).packages;
	if (!Array.isArray(packages)) return false;
	return packages.some((p) => (typeof p === "string" ? p : (p as { source?: unknown } | null)?.source) === WORKFLOWS_PACKAGE);
}

interface Check {
	label: string;
	ok: boolean;
	current: string;
	wanted: string;
}

function fmt(v: unknown): string {
	return v === undefined ? "(unset)" : JSON.stringify(v);
}

export function checks(): Check[] {
	const settings = readJson(settingsPath());
	const keys = readJson(keybindingsPath());
	const out: Check[] = [];
	for (const [k, wanted] of Object.entries(RECOMMENDED_SETTINGS)) {
		const current = settings[k];
		out.push({ label: `settings.${k}`, ok: JSON.stringify(current) === JSON.stringify(wanted), current: fmt(current), wanted: fmt(wanted) });
	}
	for (const [k, wanted] of Object.entries(RECOMMENDED_KEYBINDINGS)) {
		const current = keys[k];
		const ok = k === "app.thinking.cycle" ? shiftTabIsFree() : bindingKeys(current).includes(wanted);
		out.push({ label: `keybindings.${k}`, ok, current: fmt(current), wanted: fmt(wanted) });
	}
	const wf = workflowsInstalled();
	out.push({ label: `packages.${WORKFLOWS_PACKAGE}`, ok: wf, current: wf ? "installed" : "(missing)", wanted: "installed (/claudio setup runs pi install)" });
	return out;
}

export function isSetUp(): boolean {
	return checks().every((c) => c.ok);
}

function applySetup(): { settingsChanged: string[]; keybindingsChanged: string[] } {
	const settings = readJson(settingsPath());
	const settingsChanged: string[] = [];
	if (settings.theme === undefined) {
		settings.theme = DEFAULT_THEME;
		settingsChanged.push("theme");
	}
	for (const [k, v] of Object.entries(RECOMMENDED_SETTINGS)) {
		if (JSON.stringify(settings[k]) !== JSON.stringify(v)) {
			settings[k] = v;
			settingsChanged.push(k);
		}
	}
	if (settingsChanged.length) writeJson(settingsPath(), settings);

	const keys = readJson(keybindingsPath());
	const keybindingsChanged: string[] = [];
	for (const [k, v] of Object.entries(RECOMMENDED_KEYBINDINGS)) {
		if (JSON.stringify(keys[k]) !== JSON.stringify(v)) {
			keys[k] = v;
			keybindingsChanged.push(k);
		}
	}
	if (keybindingsChanged.length) {
		if (!("$schema" in keys)) {
			// Keep $schema first for editors.
			const ordered: Json = { $schema: "https://pi.dev/schemas/keybindings.schema.json", ...keys };
			writeJson(keybindingsPath(), ordered);
		} else writeJson(keybindingsPath(), keys);
	}
	return { settingsChanged, keybindingsChanged };
}

const USAGE = "Usage: /claudio setup — write the recommended settings and keybindings and install pi-extensible-workflows · /claudio status — show what is applied";

let hinted = false;

export function setupClaudioCommand(pi: ExtensionAPI): void {
	pi.registerCommand("claudio", {
		description: "pi-claudio: `setup` writes the recommended settings/keybindings and installs pi-extensible-workflows, `status` shows what is applied",
		getArgumentCompletions: (prefix: string) =>
			["setup", "status"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "setup") {
				const { settingsChanged, keybindingsChanged } = applySetup();
				const changed = [...settingsChanged.map((k) => `settings.${k}`), ...keybindingsChanged.map((k) => `keybindings.${k}`)];
				let workflowsNote = "";
				if (!workflowsInstalled()) {
					ctx.ui.notify(`pi-claudio: installing ${WORKFLOWS_PACKAGE} (pi install)…`, "info");
					const r = await pi.exec("pi", ["install", WORKFLOWS_PACKAGE], { timeout: 180_000 });
					if (r.code === 0) {
						changed.push(`packages.${WORKFLOWS_PACKAGE}`);
					} else {
						const err = (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
						workflowsNote = `\nCould not install ${WORKFLOWS_PACKAGE} (exit ${r.code}): ${err}\nRun \`pi install ${WORKFLOWS_PACKAGE}\` yourself.`;
					}
				}
				if (changed.length === 0) {
					ctx.ui.notify(`pi-claudio is already set up — nothing to change.${workflowsNote}`, workflowsNote ? "warning" : "info");
					return;
				}
				ctx.ui.notify(
					`pi-claudio: wrote ${changed.join(", ")} to ~/.pi/agent/settings.json and keybindings.json.\n` +
						"Restart pi (or run /reload) to apply the settings, keybindings and packages." +
						workflowsNote,
					workflowsNote ? "warning" : "info",
				);
				return;
			}
			if (sub === "status" || sub === "") {
				const all = checks();
				const lines = all.map((c) => `${c.ok ? "✔" : "✕"} ${c.label}: ${c.current}${c.ok ? "" : ` → wanted ${c.wanted}`}`);
				const themeSetting = readJson(settingsPath()).theme;
				lines.push(`· settings.theme: ${themeSetting === undefined ? "(unset → system)" : fmt(themeSetting)} — any Pi theme works; \`${DEFAULT_THEME}\` gives Claude Code's colours on dark terminals`);
				const missing = all.filter((c) => !c.ok).length;
				lines.push(missing === 0 ? "pi-claudio is fully set up." : `${missing} setting${missing === 1 ? "" : "s"} missing — run /claudio setup.`);
				if (sub === "") lines.push(USAGE);
				ctx.ui.notify(lines.join("\n"), missing === 0 ? "info" : "warning");
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || hinted) return;
		if (shiftTabIsFree() && workflowsInstalled()) return;
		hinted = true;
		const missingWf = workflowsInstalled() ? "" : " (also installs pi-extensible-workflows for /workflow and ● Task runs)";
		ctx.ui.notify(`Run /claudio setup to finish installing pi-claudio${missingWf}`, "info");
	});
}
