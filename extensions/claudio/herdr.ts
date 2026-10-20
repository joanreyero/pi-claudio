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
 * Pane name: herdr's sidebar lists panes by name, so the name should say what the agent is doing.
 * Asking the model to run `herdr pane rename` turned out unreliable, so this does it:
 *  - the first user prompt of the session names the pane (first words, shortened);
 *  - while a todo list has an in-progress item, its `activeForm` ("Running tests") is the name;
 *  - when the list is done, the name goes back to the prompt-based one.
 * A later `herdr pane rename` by the model (the global instructions ask for one when the task
 * changes) is kept until the next todo item replaces it.
 *
 * Does nothing outside a herdr pane (HERDR_ENV unset), and is harmless without herdr's extension:
 * the event simply has no listener.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	let baseName: string | undefined;
	pi.on("before_agent_start", (event) => {
		if (baseName || event.messageType !== "user" || typeof event.prompt !== "string") return;
		baseName = paneNameFromPrompt(event.prompt);
		if (baseName) renamePane(baseName);
	});

	bus.subscribe("currentTodo", (todo) => {
		if (todo?.activeForm) renamePane(todo.activeForm.slice(0, MAX_NAME));
		else if (baseName) renamePane(baseName);
	});
}
