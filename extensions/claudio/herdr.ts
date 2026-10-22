/**
 * Herdr integration: report "blocked" while a claudio dialog waits for the user, and name the
 * pane after the task.
 *
 * Herdr's own Pi integration (`herdr integration install pi`, which writes
 * ~/.pi/agent/extensions/herdr-agent-state.ts) reports working/idle from the agent lifecycle, and
 * switches to **blocked** only when another extension emits `herdr:blocked` on `pi.events`.
 * Nothing in pi does that by default, so a permission prompt or an AskUserQuestion dialog shows up
 * in herdr's sidebar as "working". This module bridges the gap: every dialog claudio opens that
 * needs the user (permission, ask) is published as blocked, and cleared when it closes.
 * User-opened dialogs (tasks, rewind) are not blocked: the agent is not waiting on them.
 *
 * Pane name: herdr's sidebar lists panes by name, so the name should say what the session is
 * about. One name per session, set once; it never follows the current step (that is what the status
 * dot is for) so the sidebar stays readable:
 *  - a session that already has a name (`/name`, or named by an earlier run) uses it;
 *  - otherwise the first user prompt names it: first words at once, then a 3–5 word title the
 *    current model writes from that prompt (one tiny request), which is also stored as the Pi
 *    session name so `/resume` lists it and a resumed session keeps the same pane name;
 *  - a resumed session without a name is titled from its first prompt in the branch.
 * Nothing renames the pane after that. If the model runs `herdr pane rename` itself (the global
 * instructions ask Claude Code to, once), that name stays.
 *
 * Does nothing outside a herdr pane (HERDR_ENV unset), and is harmless without herdr's extension:
 * the event simply has no listener.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bus, type DialogState } from "./shared.ts";

const LABELS: Partial<Record<DialogState["kind"], string>> = {
	permission: "Permission needed",
	ask: "Question for you",
};

const MAX_NAME = 40;

/** First words of a prompt, at most MAX_NAME characters, one line. */
export function paneNameFromPrompt(prompt: string): string | undefined {
	const line = prompt
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !l.startsWith("/"));
	if (!line) return undefined;
	const words = line.replace(/\s+/g, " ").split(" ");
	let out = "";
	for (const w of words) {
		const next = out ? `${out} ${w}` : w;
		if (next.length > MAX_NAME) break;
		out = next;
	}
	if (!out) out = line.slice(0, MAX_NAME);
	return out.length < line.length ? `${out}…` : out;
}

function renamePane(name: string): void {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return;
	const bin = process.env.HERDR_BIN_PATH || "herdr";
	execFile(bin, ["pane", "rename", paneId, name], { timeout: 3000 }, () => {
		/* best effort: a missing binary or a stopped server must not disturb the session */
	});
}

export function setupHerdr(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;

	let blocked = false;
	bus.subscribe("dialog", (dialog) => {
		const label = dialog ? LABELS[dialog.kind] : undefined;
		if (label && !blocked) {
			blocked = true;
			pi.events.emit("herdr:blocked", { active: true, label });
		} else if (!label && blocked) {
			blocked = false;
			pi.events.emit("herdr:blocked", { active: false });
		}
	});

	let named = false; // one name per session; reset on session_start

	const nameFrom = (ctx: ExtensionContext, prompt: string) => {
		named = true;
		const quick = paneNameFromPrompt(prompt);
		if (quick) renamePane(quick);
		void generateTitle(ctx, prompt).then((title) => {
			if (!title) return;
			// The title arrives asynchronously; in print mode the session may already be gone and `pi` stale.
			try {
				pi.setSessionName(title);
			} catch {
				return;
			}
			renamePane(title);
		});
	};

	pi.on("session_start", (_event, ctx) => {
		named = false;
		const existing = pi.getSessionName();
		if (existing) {
			named = true;
			renamePane(existing.slice(0, MAX_NAME));
			return;
		}
		const first = firstUserPrompt(ctx);
		if (first) nameFrom(ctx, first);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (named || event.messageType !== "user" || typeof event.prompt !== "string") return;
		nameFrom(ctx, event.prompt);
	});
}

/** The first user prompt on the active branch (resumed sessions), ignoring slash commands. */
function firstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const c = entry.message.content;
		const text = typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "")).join("\n");
		if (text.trim() && !text.trim().startsWith("/")) return text;
	}
	return undefined;
}

const TITLE_PROMPT =
	"Title the coding session that starts with the user message below. Reply with the title only: 3 to 5 words, " +
	"under 40 characters, sentence case, no quotes, no trailing period. Say what the session is for overall " +
	"(the goal), not the first step. Examples: 'Fix onboarding skill', 'Notifications off, cleaner ls', 'Landing page on Vercel'.";

/** Ask the current model for a short title; undefined on any failure (no model, no auth, timeout). */
async function generateTitle(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{ systemPrompt: TITLE_PROMPT, messages: [{ role: "user", content: prompt.slice(0, 2000), timestamp: Date.now() }] },
			{ maxTokens: 40, reasoning: "minimal" },
		);
		const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000));
		const message = await Promise.race([stream.result(), timeout]);
		if (!message) return undefined;
		const text = message.content
			.map((p) => (p.type === "text" ? p.text : ""))
			.join("")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0);
		if (!text) return undefined;
		const clean = text.replace(/^["'`*#\s]+|["'`*.\s]+$/g, "");
		return clean ? clean.slice(0, MAX_NAME) : undefined;
	} catch {
		return undefined;
	}
}
