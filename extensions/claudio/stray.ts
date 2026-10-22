/**
 * stray.ts — keeps stray console output out of the prompt box.
 *
 * Pi draws the TUI with differential writes and does not capture `console.*`. An extension that logs
 * while the TUI runs writes at the terminal cursor, which sits in the prompt box, so the text lands in
 * the input bar and stays there. The aweb extension does this on every event-stream disconnect and
 * reconnect (`console.warn("aweb: event stream disconnected … retrying in 1s")`).
 *
 * In TUI mode `console.log/info/debug/warn/error` go through `ctx.ui.notify` instead. The aweb stream
 * lines are dropped: the aweb extension also sets its `aweb-channel` status, which the footer shows.
 * The originals are restored on session_shutdown.
 */
import { format } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type Method = (typeof METHODS)[number];

/** The aweb extension's stream-state lines; its footer status already says the same. */
export const AWEB_STREAM_LINE = /^aweb: event stream (connected|reconnected|disconnected)\b/;

export function setupStray(pi: ExtensionAPI): void {
	let restore: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restore?.();
		if (ctx.mode !== "tui") return;
		const originals = METHODS.map((m) => [m, console[m]] as const);
		let notifying = false;
		const route = (method: Method) => (...args: unknown[]) => {
			const text = format(...args).trimEnd();
			// A notify that logs would recurse; drop that line rather than write it over the TUI.
			if (notifying || !text || AWEB_STREAM_LINE.test(text)) return;
			notifying = true;
			try {
				ctx.ui.notify(text, method === "error" ? "error" : method === "warn" ? "warning" : "info");
			} catch {
				/* the UI is closing */
			} finally {
				notifying = false;
			}
		};
		for (const m of METHODS) console[m] = route(m);
		restore = () => {
			for (const [m, fn] of originals) console[m] = fn;
			restore = undefined;
		};
	});

	pi.on("session_shutdown", () => restore?.());
}
