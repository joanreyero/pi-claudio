/**
 * ask.ts — Claude Code's AskUserQuestion: the model asks the user 1–4 multiple-choice questions and
 * gets the answers back as the tool result.
 *
 * The dialog uses the permission-dialog chrome (`dialogLines`), one question at a time with a tab-like
 * header row when there are several. Options are `❯ 1. Label` + a dim description; the last option is
 * always "Type something else." which opens an inline input. Keys: 1-9, ↑/↓, enter, space (toggle in
 * multiSelect), esc (cancel → "User cancelled").
 *
 * Rendering in the transcript (`● Asking question` / `● Asked question` + `⎿ Header → answer`) lives in
 * tools.ts and reads `AskDetails` from the result.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ANSI, BG, FG, bold, bus, dialogInnerWidth, dialogLines, dim } from "./shared.ts";

const PERM = FG.permission;
const FG_RESET = ANSI.fgReset;
const BG_RESET = ANSI.bgReset;

// ───────────────────────────── schema ─────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Short label shown to the user (1–5 words)" }),
	description: Type.String({ description: "One line explaining what choosing this option means" }),
});

const QuestionSchema = Type.Object({
	question: Type.String({ minLength: 1, description: "The full question, ending with a question mark" }),
	header: Type.String({ minLength: 1, maxLength: 12, description: "Very short topic label for the tab (max 12 chars, e.g. \"Auth\", \"Database\")" }),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4, description: "2–4 choices. Do not add an \"Other\" option: the user can always type something else." }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting several options (default false)" })),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4, description: "1–4 questions to ask the user" }),
});

type AskInput = Static<typeof AskParams>;
export type AskQuestion = Static<typeof QuestionSchema>;

/** Stored in the tool result for the transcript renderer. */
export interface AskDetails {
	answers: { header: string; question: string; answer: string }[];
	cancelled: boolean;
}

const DESCRIPTION = `Use this tool when you need the user to make a decision before you can continue: to clarify an ambiguous request, choose between implementation approaches, or confirm something that cannot be inferred from the code.

Ask 1–4 questions at once; each has 2–4 options with a short label and a one-line description, and a header of at most 12 characters shown as a tab. Put the recommended option first and say why in its description. The user can always type a free-text answer instead, so do not add an "Other" option. Use multiSelect when several options can apply at the same time.

Do not use it for questions you can answer by reading the code, and do not ask for permission to run tools (the permission system does that). The result lists the user's answer per question; if the user cancels, continue as best you can or ask in plain text.`;

// ───────────────────────────── dialog ─────────────────────────────

interface AnswerState {
	/** Selected option indexes (one at most unless multiSelect). */
	picked: Set<number>;
	/** Free text when "Type something else." was used. */
	text?: string;
}

const OTHER_LABEL = "Type something else.";

class AskDialog implements Component, Focusable {
	focused = false;
	private current = 0;
	private cursor = 0;
	private typing = false;
	private draft = "";
	private readonly answers: AnswerState[];

	constructor(
		private readonly questions: AskQuestion[],
		private readonly done: (answers: AnswerState[] | undefined) => void,
	) {
		this.answers = questions.map(() => ({ picked: new Set<number>() }));
	}

	private get q(): AskQuestion {
		return this.questions[this.current]!;
	}
	/** Options + the trailing "Type something else." row. */
	private get rows(): number {
		return this.q.options.length + 1;
	}
	private get otherIndex(): number {
		return this.q.options.length;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
		if (this.typing) {
			if (matchesKey(data, "enter")) {
				const text = this.draft.trim();
				this.typing = false;
				if (!text) return;
				const a = this.answers[this.current]!;
				a.text = text;
				a.picked.clear();
				return this.advance();
			}
			if (matchesKey(data, "backspace")) {
				this.draft = this.draft.slice(0, -1);
				return;
			}
			if (matchesKey(data, "up")) {
				this.typing = false;
				this.cursor = Math.max(0, this.otherIndex - 1);
				return;
			}
			if (data.length > 0 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) this.draft += data;
			return;
		}
		if (matchesKey(data, "up")) this.cursor = (this.cursor + this.rows - 1) % this.rows;
		else if (matchesKey(data, "down")) this.cursor = (this.cursor + 1) % this.rows;
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.switchTo(this.current - 1);
		else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.switchTo(this.current + 1);
		else if (matchesKey(data, "space") || data === " ") this.toggle(this.cursor);
		else if (matchesKey(data, "enter")) this.choose(this.cursor);
		else if (/^[1-9]$/.test(data)) {
			const i = Number(data) - 1;
			if (i < this.rows) this.choose(i);
		}
	}

	private switchTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.current = index;
		this.cursor = 0;
		this.typing = false;
	}

	private toggle(index: number): void {
		if (index === this.otherIndex) return this.choose(index);
		const a = this.answers[this.current]!;
		if (!this.q.multiSelect) {
			a.picked.clear();
			a.picked.add(index);
			a.text = undefined;
			return;
		}
		if (a.picked.has(index)) a.picked.delete(index);
		else a.picked.add(index);
		a.text = undefined;
		this.cursor = index;
	}

	private choose(index: number): void {
		this.cursor = index;
		if (index === this.otherIndex) {
			this.typing = true;
			this.draft = this.answers[this.current]?.text ?? "";
			return;
		}
		const a = this.answers[this.current]!;
		if (this.q.multiSelect) {
			// Enter on an option in multiSelect: make sure it is included, then move on.
			a.picked.add(index);
			a.text = undefined;
		} else {
			a.picked.clear();
			a.picked.add(index);
			a.text = undefined;
		}
		this.advance();
	}

	/** Go to the next unanswered question, or finish when all have an answer. */
	private advance(): void {
		const answered = (a: AnswerState) => a.picked.size > 0 || !!a.text;
		for (let step = 1; step <= this.questions.length; step++) {
			const i = (this.current + step) % this.questions.length;
			if (!answered(this.answers[i]!)) return this.switchTo(i);
		}
		this.done(this.answers);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = dialogInnerWidth(width);
		const body: string[] = [];
		if (this.questions.length > 1) {
			const tabs = this.questions.map((q, i) => {
				const label = ` ${q.header} `;
				if (i === this.current) return `${ANSI.inverse}${PERM}${bold(label)}${ANSI.inverseReset}${FG_RESET}`;
				const a = this.answers[i]!;
				return a.picked.size > 0 || a.text ? dim(`${label}✓`) : dim(label);
			});
			body.push(truncateToWidth(tabs.join(" "), inner, "…"));
			body.push("");
		}
		for (const l of wrapTextWithAnsi(this.q.question, Math.max(10, inner - 1))) body.push(bold(l));
		if (this.q.multiSelect) body.push(dim("Select all that apply (space toggles, enter continues)"));
		body.push("");
		const a = this.answers[this.current]!;
		this.q.options.forEach((opt, i) => {
			const sel = i === this.cursor && !this.typing;
			const mark = this.q.multiSelect ? (a.picked.has(i) ? "☒ " : "☐ ") : "";
			const row = `${i + 1}. ${mark}${opt.label}`;
			body.push(sel ? `${PERM}❯ ${row}${FG_RESET}` : `  ${row}`);
			if (opt.description) for (const l of wrapTextWithAnsi(opt.description, Math.max(10, inner - 5))) body.push(`     ${dim(l)}`);
		});
		const n = this.otherIndex + 1;
		if (this.typing) {
			const marker = this.focused ? CURSOR_MARKER : "";
			const typed = this.draft
				? `${this.draft}${marker}${renderFakeCursor(" ")}`
				: `${marker}${renderFakeCursor(OTHER_LABEL.charAt(0))}${dim(OTHER_LABEL.slice(1))}`;
			body.push(`${PERM}❯ ${n}. ${FG_RESET}${typed}`);
		} else {
			const sel = this.cursor === this.otherIndex;
			const label = a.text ? `${OTHER_LABEL} ${dim(`(${a.text})`)}` : OTHER_LABEL;
			body.push(sel ? `${PERM}❯ ${n}. ${label}${FG_RESET}` : `  ${n}. ${label}`);
		}
		body.push("");
		const hint = this.typing ? "Enter to submit · ↑ back to the options" : `Enter to confirm${this.questions.length > 1 ? " · ←/→ switch question" : ""}`;
		body.push(dim(truncateToWidth(hint, inner, "…")));
		const title = this.questions.length > 1 ? `Question ${this.current + 1} of ${this.questions.length}` : "Question";
		return dialogLines(width, "permission", title, undefined, body);
	}
}

// ───────────────────────────── setup ─────────────────────────────

function answerText(q: AskQuestion, a: AnswerState): string {
	if (a.text) return a.text;
	const labels = [...a.picked].sort((x, y) => x - y).map((i) => q.options[i]?.label ?? "").filter(Boolean);
	return labels.join(", ");
}

export function setupAsk(pi: ExtensionAPI): void {
	pi.registerTool<typeof AskParams, AskDetails>({
		name: "ask_user_question",
		label: "Ask user question",
		description: DESCRIPTION,
		promptSnippet: "Ask the user 1–4 multiple-choice questions when a decision needs their input",
		parameters: AskParams,
		exposure: "model-only",
		renderShell: "self",
		annotations: { readOnlyHint: true },

		async execute(_toolCallId, params: AskInput, _signal, _onUpdate, ctx: ExtensionContext) {
			const questions = params.questions;
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "No interactive UI is available for ask_user_question. Ask the question in plain text in your reply instead." }],
					details: { answers: [], cancelled: true },
					isError: true,
				};
			}
			bus.set("dialog", { kind: "ask" });
			let answers: AnswerState[] | undefined;
			try {
				answers = await ctx.ui.custom<AnswerState[] | undefined>((_tui, _theme, _kb, done) => new AskDialog(questions, done), { overlay: false });
			} finally {
				bus.set("dialog", null);
			}
			if (!answers) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: { answers: [], cancelled: true },
				};
			}
			const rows = questions.map((q, i) => ({ header: q.header, question: q.question, answer: answerText(q, answers![i]!) }));
			const text = rows.map((r) => `User answered: ${r.header}: ${r.answer}`).join("\n");
			return { content: [{ type: "text", text }], details: { answers: rows, cancelled: false } };
		},
	});
}


