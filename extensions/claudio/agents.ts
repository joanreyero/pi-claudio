/**
 * Claude Code subagents for pi workflows.
 *
 * Claude Code defines subagents as Markdown files with frontmatter (`.claude/agents/<name>.md` in the project,
 * `~/.claude/agents/<name>.md` for the user, `<plugin>:<name>` for a plugin's `agents/` directory) and its
 * Workflow tool launches one with `agent(prompt, { agentType: "<name>" })`. pi-extensible-workflows has no agent
 * files, but it forwards unknown `agent()` options to extension *preparation hooks*. This module registers one:
 * when an agent call (workflow `agent()`, `agent.create()`, nested children) carries `agentType`, the hook finds
 * the Claude Code agent file, appends its body to the system prompt, narrows the tools to the file's `tools:`
 * list (Claude tool names mapped to pi's), applies `model:` when it names a configured workflow model alias, and
 * labels the agent after it. The agent files stay the single source of truth for both runtimes.
 *
 * Inert when pi-extensible-workflows is not installed (the hook has nothing to register with).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

// ── pi-extensible-workflows (optional) ───────────────────────────────────────────────────────────────────────
// The registry lives on globalThis (Symbol.for), so any copy of the package's module registers into the live one.

type AgentPreparation = {
	label?: string;
	model?: string;
	tools: string[];
	skills: string[];
	extensions: string[];
	systemPrompt?: string;
	systemPromptAppend: string;
};
type AgentPreparationContext = {
	readonly options: Readonly<Record<string, unknown>>;
	readonly cwd: string;
	readonly projectCwd?: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	readonly defaults: Readonly<{ modelAliases: Readonly<Record<string, string>> }>;
	readonly capabilities: Readonly<{ tools: readonly string[]; skills: readonly string[] }>;
	readonly signal: AbortSignal;
	readonly mode: "execution" | "inspection";
};
type WorkflowsModule = {
	registerWorkflowExtension: (extension: Record<string, unknown>) => void;
	WorkflowError?: new (code: string, message: string) => Error;
};

const PACKAGE = "pi-extensible-workflows";

/**
 * Load pi-extensible-workflows from the agent dir's package store (where `pi install npm:…` puts it), or null.
 * Pi has already imported that same file as the package's extension entry, so this resolves from the module
 * cache at once (before `session_start`, when the registry freezes); Bun cannot `require()` it, hence `import()`.
 */
async function loadWorkflows(): Promise<WorkflowsModule | null> {
	const candidates = [
		path.join(getAgentDir(), "npm", "node_modules", PACKAGE),
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", PACKAGE),
	];
	for (const dir of candidates) {
		if (!existsSync(path.join(dir, "package.json"))) continue;
		try {
			const mod = (await import(pathToFileURL(path.join(dir, "dist", "src", "index.js")).href)) as Partial<WorkflowsModule>;
			if (typeof mod.registerWorkflowExtension === "function") return mod as WorkflowsModule;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

// ── Claude Code agent files ──────────────────────────────────────────────────────────────────────────────────

export interface ClaudeAgentDefinition {
	name: string;
	description?: string;
	/** Claude tool allow-list (`tools:`), or undefined for "all tools". */
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	skills?: string[];
	body: string;
	path: string;
}

/** Minimal frontmatter reader: `key: value` lines; values may be quoted, `[a, b]`, or `a, b`. */
export function parseAgentFile(content: string, file: string): ClaudeAgentDefinition {
	const text = content.replace(/^\uFEFF/, "");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const fields: Record<string, string> = {};
	let body = text;
	if (m) {
		body = m[2] ?? "";
		for (const line of (m[1] ?? "").split(/\r?\n/)) {
			const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
			if (kv) fields[kv[1] as string] = (kv[2] ?? "").trim();
		}
	}
	const unquote = (v: string): string => {
		const t = v.trim();
		return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
	};
	const list = (v: string | undefined): string[] | undefined => {
		if (v === undefined) return undefined;
		let t = v.trim();
		if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
		const items = t
			.split(",")
			.map((s) => unquote(s))
			.filter(Boolean);
		return items.length ? items : undefined;
	};
	return {
		name: unquote(fields.name ?? "") || path.basename(file, ".md"),
		description: fields.description ? unquote(fields.description) : undefined,
		tools: list(fields.tools),
		disallowedTools: list(fields.disallowedTools),
		model: fields.model ? unquote(fields.model) : undefined,
		skills: list(fields.skills),
		body: body.trim(),
		path: file,
	};
}

/** Candidate files for an `agentType`, in Claude Code's precedence: project (cwd and ancestors), user, plugin. */
export function agentFileCandidates(agentType: string, projectCwd: string, projectTrusted: boolean): string[] {
	const home = os.homedir();
	const claudeHome = path.join(home, ".claude");
	const out: string[] = [];
	const plugin = /^([^:]+):(.+)$/.exec(agentType);
	if (plugin) {
		const [, pluginName, agentName] = plugin as unknown as [string, string, string];
		// Installed plugins: ~/.claude/plugins/installed_plugins.json → installPath/agents/<name>.md
		try {
			const installed = JSON.parse(readFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), "utf8")) as {
				plugins?: Record<string, Array<{ installPath?: string; scope?: string; projectPath?: string }>>;
			};
			for (const [key, entries] of Object.entries(installed.plugins ?? {})) {
				if (key !== pluginName && !key.startsWith(`${pluginName}@`)) continue;
				const sorted = [...entries].sort((a, b) => Number(b.projectPath === projectCwd) - Number(a.projectPath === projectCwd));
				for (const e of sorted) if (e.installPath) out.push(path.join(e.installPath, "agents", `${agentName}.md`));
			}
		} catch {
			/* no installed plugins */
		}
		// Marketplace checkouts: a plugin at the marketplace root or under plugins/<name>/
		const mk = path.join(claudeHome, "plugins", "marketplaces");
		out.push(path.join(mk, pluginName, "agents", `${agentName}.md`));
		for (const marketplace of readdirSyncSafe(mk)) out.push(path.join(mk, marketplace, "plugins", pluginName, "agents", `${agentName}.md`));
		return out;
	}
	if (projectTrusted) {
		let dir = path.resolve(projectCwd);
		for (;;) {
			out.push(path.join(dir, ".claude", "agents", `${agentType}.md`));
			if (existsSync(path.join(dir, ".git"))) break; // repository root: Claude Code's project boundary
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	out.push(path.join(claudeHome, "agents", `${agentType}.md`));
	return out;
}

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export function resolveAgentFile(agentType: string, projectCwd: string, projectTrusted: boolean): ClaudeAgentDefinition | null {
	for (const file of agentFileCandidates(agentType, projectCwd, projectTrusted)) {
		if (!existsSync(file)) continue;
		return parseAgentFile(readFileSync(file, "utf8"), file);
	}
	return null;
}

// ── Tool-name mapping ────────────────────────────────────────────────────────────────────────────────────────

/** Claude Code tool → pi tools (pi-claudio names). Tools with no pi counterpart map to nothing. */
const TOOL_MAP: Record<string, string[]> = {
	bash: ["bash", "bash_output", "kill_shell"],
	read: ["read"],
	write: ["write"],
	edit: ["edit"],
	multiedit: ["edit"],
	notebookedit: ["edit"],
	glob: ["find", "ls"],
	grep: ["grep"],
	ls: ["ls"],
	todowrite: ["todo_write"],
	askuserquestion: ["ask_user_question"],
	task: [],
	webfetch: [],
	websearch: [],
	skill: [],
	slashcommand: [],
	exitplanmode: [],
	enterplanmode: [],
	killshell: ["kill_shell"],
	bashoutput: ["bash_output"],
};

/** `Bash(git:*)`-style qualifiers are Claude permission syntax; the tool is the part before `(`. */
export function mapClaudeTool(name: string): string[] {
	const base = name.replace(/\(.*$/, "").trim();
	if (!base) return [];
	if (base.startsWith("mcp__")) return [base];
	const mapped = TOOL_MAP[base.toLowerCase()];
	return mapped ?? [base.toLowerCase()];
}

/** The pi tool selector list for a Claude `tools:` allow-list, restricted to tools the parent can grant. */
export function toolSelectors(def: ClaudeAgentDefinition, available: readonly string[]): string[] | undefined {
	if (!def.tools && !def.disallowedTools) return undefined;
	const allow = new Set<string>();
	for (const t of def.tools ?? []) for (const p of mapClaudeTool(t)) allow.add(p);
	const selectors: string[] = [];
	if (def.tools) {
		selectors.push("!*");
		for (const t of available) if (allow.has(t)) selectors.push(t);
	}
	for (const t of def.disallowedTools ?? []) for (const p of mapClaudeTool(t)) if (available.includes(p)) selectors.push(`!${p}`);
	return selectors;
}

// ── The hook ─────────────────────────────────────────────────────────────────────────────────────────────────

export function prepareClaudeAgent(configuration: AgentPreparation, context: Readonly<AgentPreparationContext>, fail: (message: string) => Error): void {
	const agentType = context.options.agentType;
	if (agentType === undefined) return;
	if (typeof agentType !== "string" || !agentType.trim()) throw fail("agentType must be a non-empty string naming a Claude Code agent (.claude/agents/<name>.md or <plugin>:<name>)");
	const projectCwd = context.projectCwd ?? context.cwd;
	const def = resolveAgentFile(agentType.trim(), projectCwd, context.projectTrusted);
	if (!def) {
		const where = agentType.includes(":") ? `~/.claude/plugins (installed plugin "${agentType.split(":")[0]}")` : `${path.join(projectCwd, ".claude", "agents")} or ~/.claude/agents`;
		throw fail(`Unknown agentType "${agentType}": no ${agentType.split(":").pop()}.md in ${where}${context.projectTrusted ? "" : " (project agents need project trust)"}`);
	}
	if (!configuration.label) configuration.label = def.name;
	const selectors = toolSelectors(def, context.capabilities.tools);
	if (selectors) configuration.tools = selectors;
	// Claude's `model: sonnet|opus|haiku|inherit` only applies when a workflow model alias of that name exists.
	if (def.model && def.model !== "inherit" && Object.hasOwn(context.defaults.modelAliases, def.model)) configuration.model = def.model;
	const preload = (def.skills ?? []).filter((s) => context.capabilities.skills.includes(s));
	const parts = [
		`# Agent: ${def.name}`,
		def.description ? `Role: ${def.description}` : "",
		`(Claude Code agent definition from ${def.path}.)`,
		"",
		def.body,
		preload.length ? `\n\nPreloaded skills — read each one's SKILL.md before working: ${preload.join(", ")}.` : "",
	].filter((p) => p !== "");
	const suffix = parts.join("\n");
	configuration.systemPromptAppend = configuration.systemPromptAppend ? `${configuration.systemPromptAppend}\n\n${suffix}` : suffix;
}

export function setupClaudeAgents(_pi: ExtensionAPI): void {
	void loadWorkflows().then((workflows) => {
		if (!workflows) return;
		const fail = (message: string): Error => (workflows.WorkflowError ? new workflows.WorkflowError("INVALID_METADATA", message) : new Error(message));
		try {
			workflows.registerWorkflowExtension({
				version: "1.0.0",
				source: import.meta.url,
				headline: "Claude Code agents: agent(prompt, { agentType }) loads .claude/agents/<name>.md",
				description: "Resolves Claude Code subagent files (.claude/agents, ~/.claude/agents, <plugin>:<name>) for workflow and subagent calls that pass agentType: system prompt, tools and model from the file.",
				agentPreparationHooks: {
					claudeAgents: {
						priority: 20,
						optionsSchema: { type: "object", properties: { agentType: { type: "string", minLength: 1 } } },
						prepare(configuration: AgentPreparation, context: Readonly<AgentPreparationContext>) {
							if (context.signal.aborted) return;
							prepareClaudeAgent(configuration, context, fail);
						},
					},
				},
			});
		} catch {
			/* a second load in the same process (REGISTRY_FROZEN / DUPLICATE_NAME): the first registration stands */
		}
	});
}

/** For tests and `/claudio status`: where an agentType would be looked up from a given project. */
export function describeAgentLookup(agentType: string, projectCwd: string): string {
	return agentFileCandidates(agentType, projectCwd, true)
		.map((f) => `${existsSync(f) ? "✔" : "·"} ${f.replace(os.homedir(), "~")}`)
		.join("\n");
}
