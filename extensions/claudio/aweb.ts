/**
 * aweb.ts — transcript rows for the aweb extension's (`@awebai/pi`) custom messages.
 *
 * Without a renderer Pi shows a custom message as a filled box with the whole text the model
 * receives: for one incoming mail that is its metadata, the body and the reply instructions, a
 * screen of text on `customMessageBg`. Here each one is a single muted row with no background,
 * and `app.tools.expand` (ctrl+o) shows the rest:
 *
 *   ● Mail from joan-product-maintainer · Re: Desktop UI rework (ctrl+o to expand)
 *   ● aweb · channel is installed but not ready (ctrl+o to expand)
 *
 * Display only: the message the model reads is unchanged. A sender that aweb did not verify is
 * said so on the row itself, never only when expanded. The text comes from other agents, so
 * escape sequences and control characters are removed before it is drawn.
 *
 * A message renderer is keyed by `customType`, whichever extension sends the message, so this
 * needs nothing from the aweb package and is inert without it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, BULLET, dim, fg, inactive, RESULT_INDENT, SEPARATOR, stripAnsi, WARN } from "./shared.ts";

/** aweb's `trust_status` values that mean the sender is who it says. */
const TRUSTED = new Set(["verified", "verified_custodial"]);
/** Metadata worth a line when expanded; the rest (responsibility JSON, flags) is noise to a reader. */
const SHOWN_META = ["from", "subject", "message_id", "conversation_id", "session_id", "task_id", "signal"];

/** One line of someone else's text, safe to draw: no escape sequences, no control characters. */
export function clean(text: string): string {
	return stripAnsi(text)
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** The sender's name without its namespace: `oats.aweb.ai/joan-maintainer` → `joan-maintainer`. */
function shortSender(from: string): string {
	return from.slice(from.lastIndexOf("/") + 1) || from;
}

/** The body of an awakening: what follows `Message:` / `App event:`, without aweb's closing instruction line. */
export function awakeningBody(content: string): string[] {
	const lines = content.split("\n");
	const start = lines.findIndex((l) => l === "Message:" || l === "App event:");
	if (start < 0) return [];
	const body = lines.slice(start + 1);
	// The closing line is the last paragraph, after a blank line.
	const lastBlank = body.lastIndexOf("");
	return (lastBlank >= 0 ? body.slice(0, lastBlank) : body).map(clean);
}

export interface AwebRow {
	head: string;
	/** Shown under the head even when collapsed (trust warnings). */
	always: string[];
	/** Shown when expanded. */
	rows: string[];
}

/** The row for an awakening (`aweb-channel`): mail, chat, room post, control signal, work, app event. */
export function awakeningRow(content: string, meta: Record<string, unknown> | undefined): AwebRow {
	const m = (key: string): string => (typeof meta?.[key] === "string" ? clean(meta[key] as string) : "");
	const type = m("type") || /^aweb (\S+) event received\./.exec(content)?.[1] || "event";
	const from = shortSender(m("from"));
	const body = awakeningBody(content);
	const what = type === "room" ? "Room post" : `${type[0]!.toUpperCase()}${type.slice(1)}`;
	const about = m("subject") || m("signal") || body.find((l) => l.trim())?.trim() || "";
	const trust = m("trust_status");
	const untrusted = meta !== undefined && "trust_status" in meta && !TRUSTED.has(trust);
	const head =
		`${untrusted ? fg("warning", BULLET) : inactive(BULLET)} ${inactive(from ? `${what} from ` : what)}${from ? bold(from) : ""}` +
		(about ? inactive(`${SEPARATOR}${about}`) : "");
	const rows = [...body];
	const metaLines = SHOWN_META.filter((k) => m(k)).map((k) => dim(`${k}: ${m(k)}`));
	if (rows.length && metaLines.length) rows.push("");
	rows.push(...metaLines);
	return { head, always: untrusted ? [fg("warning", `${WARN} sender not verified (${trust || "unknown"})`)] : [], rows };
}

/** The row for a notice from the aweb extension itself (`aweb-channel-status`, `aweb-welcome`). */
export function noticeRow(content: string): AwebRow {
	const lines = content.split("\n").map(clean);
	const first = lines.findIndex((l) => l.trim());
	const title = (lines[first] ?? "").trim().replace(/^aweb:?\s+/, "").replace(/\.$/, "");
	const rest = lines.slice(first + 1);
	while (rest.length && !rest[0]!.trim()) rest.shift();
	return { head: `${inactive(BULLET)} ${inactive(`aweb${title ? `${SEPARATOR}${title}` : ""}`)}`, always: [], rows: rest };
}

/** `● head (ctrl+o to expand)`, then `  ⎿  line` rows (continuations indented 5), wrapped to the width. */
class Row implements Component {
	constructor(
		private readonly pad: string,
		private readonly row: AwebRow,
		private readonly expanded: boolean,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const { head, always, rows } = this.row;
		const hint = !this.expanded && rows.length ? ` ${dim(`(${keyText("app.tools.expand")} to expand)`)}` : "";
		// The hint is what says there is more: the head gives way to it, not the other way round.
		const out = [truncateToWidth(`${this.pad}${truncateToWidth(head, Math.max(10, width - this.pad.length - visibleWidth(hint)), "…")}${hint}`, width, "…")];
		const inner = Math.max(10, width - this.pad.length - RESULT_INDENT.length);
		let first = true;
		for (const line of this.expanded ? [...always, ...rows] : always) {
			const pieces = wrapTextWithAnsi(line, inner);
			if (pieces.length === 0) pieces.push("");
			for (const piece of pieces) {
				out.push(truncateToWidth(`${this.pad}${first ? `  ${dim("⎿")}  ` : RESULT_INDENT}${piece}`, width));
				first = false;
			}
		}
		return out;
	}
}

export function setupAweb(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<Record<string, unknown>>("aweb-channel", (msg, opts) => {
		const details = msg.details && typeof msg.details === "object" ? msg.details : undefined;
		return new Row(" ".repeat(opts.outputPad), awakeningRow(contentText(msg.content), details), opts.expanded);
	});
	for (const type of ["aweb-channel-status", "aweb-welcome"]) {
		pi.registerMessageRenderer(type, (msg, opts) => new Row(" ".repeat(opts.outputPad), noticeRow(contentText(msg.content)), opts.expanded));
	}
}
