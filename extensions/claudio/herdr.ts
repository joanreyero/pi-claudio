/**
 * Herdr integration: report "blocked" while a claudio dialog waits for the user.
 *
 * Herdr's own Pi integration (`herdr integration install pi`, which writes
 * ~/.pi/agent/extensions/herdr-agent-state.ts) reports working/idle from the agent lifecycle, and
 * switches to **blocked** only when another extension emits `herdr:blocked` on `pi.events`.
 * Nothing in pi does that by default, so a permission prompt or an AskUserQuestion dialog shows up
 * in herdr's sidebar as "working". This module bridges the gap: every dialog claudio opens that
 * needs the user (permission, ask) is published as blocked, and cleared when it closes.
 *
 * User-opened dialogs (tasks, rewind) are not blocked: the agent is not waiting on them.
 * Does nothing outside a herdr pane (HERDR_ENV unset), and is harmless without herdr's extension:
 * the event simply has no listener.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bus, type DialogState } from "./shared.ts";

const LABELS: Partial<Record<DialogState["kind"], string>> = {
	permission: "Permission needed",
	ask: "Question for you",
};

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
}
