/**
 * Message styling (inspired by Claude Code) that Pi lets us do through Markdown transformers:
 *
 *   > user prompt text                 (prefix "\u200B> " — the zero-width space keeps Markdown
 *                                        from treating it as a blockquote; first line only)
 *   ● assistant text                   (bullet on the first non-empty paragraph only)
 *   ✻ Thinking…                        (collapsed thinking label)
 *
 * Pi cannot swap the user/assistant message components, and the compaction summary / custom
 * message boxes have no extension hook (`CompactionSummaryMessageComponent` is hard-wired), so those are left to the theme (customMessageBg / userMessageBg …).
 *
 * The assistant transformer runs on every render of the (possibly streaming) Markdown source, so
 * it is a pure function of the text: given the same text it always yields the same output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BULLET } from "./shared.ts";

const THINKING_LABEL = "✻ Thinking…";
const ZWSP = "\u200B";

const FENCE_RE = /^(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})(\s+)(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s/;
const TABLE_RE = /^\s*\|/;
const QUOTE_RE = /^\s*>/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** `> text` echo. Only the first line gets the prefix (continuation lines stay as typed). */
export function transformUserMarkdown(md: string): string {
	if (md.startsWith(`${ZWSP}> `)) return md;
	return `${ZWSP}> ${md}`;
}

/**
 * Put `● ` in front of the first non-empty paragraph.
 *  - plain paragraph → `● text`
 *  - heading         → `# ● text` (keeps heading styling; the bullet still leads the rendered line)
 *  - fence / list / table / quote / rule → a `●` paragraph line directly above the block (never
 *    inside a code fence; these blocks may interrupt a paragraph so no blank line is needed)
 */
export function transformAssistantMarkdown(md: string): string {
	const lines = md.split("\n");
	let i = 0;
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i >= lines.length) return md;
	const first = lines[i]!;
	const trimmed = first.trimStart();

	if (trimmed.startsWith(BULLET)) return md; // already transformed (defensive)

	const heading = HEADING_RE.exec(trimmed);
	if (heading) {
		lines[i] = `${heading[1]}${heading[2]}${BULLET} ${heading[3]}`;
		return lines.join("\n");
	}
	if (HR_RE.test(first)) {
		// A bare `●` line directly above `---` would turn into a setext heading; keep a blank line.
		lines.splice(i, 0, BULLET, "");
		return lines.join("\n");
	}
	if (FENCE_RE.test(trimmed) || LIST_RE.test(first) || TABLE_RE.test(first) || QUOTE_RE.test(first)) {
		lines.splice(i, 0, BULLET);
		return lines.join("\n");
	}
	lines[i] = `${BULLET} ${trimmed}`;
	return lines.join("\n");
}

export function setupMessages(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((md, ctx) => {
		switch (ctx.messageType) {
			case "user":
				return transformUserMarkdown(md);
			case "assistant":
				return transformAssistantMarkdown(md);
			default:
				return md; // "assistant-thinking": shown dim italic as-is when expanded
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
	});
}
