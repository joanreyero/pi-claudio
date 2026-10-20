/**
 * dirs.ts — `/add-dir` (Claude Code's additional working directories).
 *
 * The session's working directories are the cwd plus every directory added with `/add-dir <path>`.
 * They matter in two places:
 *  - permissions.ts: in `acceptEdits` mode, edits and writes are only auto-approved inside a working
 *    directory; anything else still asks (the dialog offers "allow edits in <dir>", which adds it here);
 *  - the system prompt: the model is told about the extra directories (an `additional_working_directories`
 *    section) and gets their `AGENTS.md` / `CLAUDE.md` as context files, like the cwd's own.
 *
 * The list is stored in the session as `claudio-add-dir` custom entries (the full list each time) and
 * rebuilt from the active branch at session_start / session_tree, so `/resume` and branching keep it.
 * `/add-dir` with no argument lists the current working directories.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bold, tildify } from "./shared.ts";

const ENTRY_TYPE = "claudio-add-dir";
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];

interface DirsEntry {
	dirs: string[];
}

// ── Module state ───────────────────────────────────────────────────────────────────────────
let extraDirs: string[] = [];

/** Directories added with `/add-dir` (absolute, normalised), excluding the cwd. */
export function getExtraDirs(): readonly string[] {
	return extraDirs;
}

/** Expand `~`, resolve against `cwd` and normalise (no trailing separator). */
export function resolveDir(input: string, cwd: string): string {
	let p = input.trim().replace(/^["']|["']$/g, "");
	if (p === "~") p = os.homedir();
	else if (p.startsWith(`~${sep}`) || p.startsWith("~/")) p = join(os.homedir(), p.slice(2));
	const abs = normalize(isAbsolute(p) ? p : resolve(cwd, p));
	return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}

function contains(dir: string, abs: string): boolean {
	return abs === dir || abs.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** True when `path` (relative paths resolve against `cwd`) is inside the cwd or an added directory. */
export function isInWorkingDirs(path: string, cwd: string): boolean {
	const abs = normalize(isAbsolute(path) ? path : resolve(cwd, path));
	const root = normalize(cwd);
	return contains(root, abs) || extraDirs.some((d) => contains(d, abs));
}

/**
 * Add a directory for this session. Returns a short message for the user; `added` is false when the
 * directory was already a working directory (or does not exist).
 */
export function addDir(pi: ExtensionAPI, input: string, cwd: string): { added: boolean; dir: string; message: string } {
	const dir = resolveDir(input, cwd);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { added: false, dir, message: `${tildify(dir)} is not a directory` };
	if (contains(normalize(cwd), dir)) return { added: false, dir, message: `${tildify(dir)} is already inside the working directory` };
	if (extraDirs.some((d) => contains(d, dir))) return { added: false, dir, message: `${tildify(dir)} is already a working directory` };
	// A parent of an existing entry replaces it.
	extraDirs = [...extraDirs.filter((d) => !contains(dir, d)), dir];
	pi.appendEntry<DirsEntry>(ENTRY_TYPE, { dirs: extraDirs });
	return { added: true, dir, message: `Added ${tildify(dir)} as a working directory` };
}

function reconstruct(ctx: ExtensionContext): void {
	let found: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as DirsEntry | undefined;
		if (data && Array.isArray(data.dirs)) found = data.dirs.filter((d): d is string => typeof d === "string");
	}
	extraDirs = found;
}

function contextFileIn(dir: string): { path: string; content: string } | undefined {
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(dir, name);
		try {
			if (existsSync(path)) return { path, content: readFileSync(path, "utf8") };
		} catch {
			// unreadable: skip
		}
	}
	return undefined;
}

// ── Setup ──────────────────────────────────────────────────────────────────────────────────
export function setupDirs(pi: ExtensionAPI): void {
	pi.on("session_start", (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// Tell the model about the extra directories and load their AGENTS.md / CLAUDE.md, as Pi does for the cwd.
	pi.on("before_agent_start", (event) => {
		if (extraDirs.length === 0) return;
		const opts = event.systemPromptOptions;
		opts.sections.additional_working_directories =
			"Besides the current working directory, the user has added these directories to the session with /add-dir. " +
			"Treat them as part of the project: read, search and edit files there as needed.\n" +
			extraDirs.map((d) => `- ${d}`).join("\n");
		const known = new Set(opts.contextFiles.map((f) => f.path));
		for (const dir of extraDirs) {
			const file = contextFileIn(dir);
			if (file && !known.has(file.path)) opts.contextFiles.push(file);
		}
	});

	pi.registerCommand("add-dir", {
		description: "Add a working directory for this session (edits there are auto-accepted in acceptEdits mode); no argument lists them",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				const lines = [`Working directories:`, `  ${bold(tildify(ctx.cwd))} ${`(cwd)`}`, ...extraDirs.map((d) => `  ${tildify(d)}`)];
				if (extraDirs.length === 0) lines.push("  (none added — /add-dir <path>)");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const result = addDir(pi, input, ctx.cwd);
			ctx.ui.notify(result.message, result.added ? "info" : "warning");
		},
	});
}
