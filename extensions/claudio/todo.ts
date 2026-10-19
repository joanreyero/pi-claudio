/**
 * `todo_write` tool with a checklist rendering inspired by Claude Code's TodoWrite.
 *
 * - Params: `todos: [{ content, status: pending|in_progress|completed, activeForm }]` (full list each
 *   call; it replaces the previous one — like Claude, an all-completed list clears the todos).
 * - State lives in the tool result `details` and is reconstructed from the session branch on
 *   session_start / session_tree, so branching/resume keep it correct.
 * - Rendering (renderShell "self"):
 *       ● Update Todos
 *         ⎿  ☒ completed item        (strikethrough, dim)
 *            ☐ in-progress item      (bold, claudio orange)
 *            ☐ pending item
 * - Publishes the current in_progress todo on the bus key `currentTodo` (shared.ts) as
 *   `{ content, status, activeForm }` (activeForm is an extra field on shared's TodoItem).
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ANSI, bus, FG, fg, type TodoItem as SharedTodoItem } from "./shared.ts";

// ── palette via shared.ts (resolved from the active Pi theme at render time; FG is a live getter) ──
const orange = (s: string): string => fg("claudio", s);
const green = (s: string): string => fg("success", s);
const red = (s: string): string => fg("error", s);
const DIM = ANSI.dim;
const BOLD = ANSI.bold;
const STRIKE = ANSI.strike;
const ATTR_RESET = ANSI.reset;

type RenderCtx<TState = unknown, TArgs = unknown> = Parameters<NonNullable<ToolDefinition<any, any, TState>["renderCall"]>>[2] & {
	args: TArgs;
	state: TState;
};

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}
export interface TodoDetails {
	oldTodos: TodoItem[];
	newTodos: TodoItem[];
}

const TodoItemSchema = Type.Object({
	content: Type.String({ minLength: 1, description: "The task, in imperative form (e.g. \"Run tests\")" }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], { description: "Task status" }),
	activeForm: Type.String({ minLength: 1, description: "Present continuous form shown while in progress (e.g. \"Running tests\")" }),
});
const TodoParams = Type.Object({
	todos: Type.Array(TodoItemSchema, { description: "The updated todo list" }),
});

const DESCRIPTION =
	"Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. " +
	"Make sure that at least one task is in_progress at all times. Always provide both content (imperative) and activeForm (present continuous) for each task.";

const GUIDELINES = [
	"Use todo_write for multi-step or non-trivial tasks (3+ distinct steps) and when the user gives several tasks; skip it for single trivial steps or purely conversational requests.",
	"todo_write replaces the whole list each call. Keep exactly one item in_progress at a time, mark items completed IMMEDIATELY after finishing them (do not batch), and only mark completed when fully done — keep it in_progress if blocked or tests fail.",
];

const RESULT_TEXT =
	"Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";

// ── Module state ───────────────────────────────────────────────────────────────────────────
let todos: TodoItem[] = [];

function publish(): void {
	const current = todos.find((t) => t.status === "in_progress");
	// shared.ts's TodoItem is { content, status }; we add `activeForm` (the spinner-friendly label).
	// Consumers: `(todo as { activeForm?: string }).activeForm ?? todo.content`.
	const value: (SharedTodoItem & { activeForm: string }) | null = current
		? { content: current.content, status: current.status, activeForm: current.activeForm }
		: null;
	bus.set("currentTodo", value);
}

function setTodos(next: TodoItem[]): void {
	todos = next;
	publish();
}

/** Current todo list (read-only snapshot) for other modules, e.g. a ctrl+t widget. */
export function getTodos(): readonly TodoItem[] {
	return todos;
}

function reconstruct(ctx: ExtensionContext): void {
	let found: TodoItem[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo_write") continue;
		const details = msg.details as TodoDetails | undefined;
		if (details && Array.isArray(details.newTodos)) found = details.newTodos;
	}
	setTodos(found);
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────
/** Style wrappers re-applied per wrapped line so Pi's per-line reset cannot break them. */
function styleItem(t: TodoItem, line: string): string {
	switch (t.status) {
		case "completed":
			return `${DIM}${STRIKE}${line}${ATTR_RESET}`;
		case "in_progress":
			return `${FG.claudio}${BOLD}${line}${ATTR_RESET}`;
		default:
			return line;
	}
}

/** Row text before styling: `☒ content` / `☐ content`. */
function itemText(t: TodoItem): string {
	return `${t.status === "completed" ? "☒" : "☐"} ${t.content}`;
}

/**
 * Width-safe list: `  ⎿  <item>` then `     <item>`; long items wrap with a hanging indent of 5
 * (continuation lines sit under the checkbox column, like every other result row).
 */
function renderListLines(items: TodoItem[], width: number): string[] {
	const connector = `  ${DIM}⎿${ATTR_RESET}  `;
	const indent = "     ";
	const inner = Math.max(10, width - indent.length);
	if (items.length === 0) return []; // only while the call is still streaming
	const out: string[] = [];
	items.forEach((t, i) => {
		const wrapped = wrapTextWithAnsi(itemText(t), inner);
		wrapped.forEach((w, j) => {
			const prefix = i === 0 && j === 0 ? connector : indent;
			out.push(truncateToWidth(`${prefix}${styleItem(t, w)}`, width));
		});
	});
	return out;
}

/** Component whose lines are rebuilt for the current width (Text would wrap flush-left). */
class TodoList implements Component {
	private items: TodoItem[] = [];
	private error: string | undefined;
	private cache: { width: number; lines: string[] } | undefined;
	set(items: TodoItem[], error?: string): void {
		this.items = items;
		this.error = error;
		this.cache = undefined;
	}
	invalidate(): void {
		this.cache = undefined;
	}
	render(width: number): string[] {
		if (!this.cache || this.cache.width !== width) {
			const lines = this.error !== undefined ? [truncateToWidth(`  ${DIM}⎿${ATTR_RESET}  ${red(this.error)}`, width)] : renderListLines(this.items, width);
			this.cache = { width, lines };
		}
		return this.cache.lines;
	}
}

// ── Setup ──────────────────────────────────────────────────────────────────────────────────
export function setupTodo(pi: ExtensionAPI): void {
	publish();
	pi.on("session_start", (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	pi.registerTool<typeof TodoParams, TodoDetails>({
		name: "todo_write",
		label: "Update Todos",
		description: DESCRIPTION,
		promptSnippet: "Create and update the session task list shown to the user as your working plan",
		promptGuidelines: GUIDELINES,
		parameters: TodoParams,
		renderShell: "self",

		async execute(_toolCallId, params) {
			const oldTodos = [...todos];
			const incoming: TodoItem[] = params.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
			const allDone = incoming.length > 0 && incoming.every((t) => t.status === "completed");
			setTodos(allDone ? [] : incoming);
			return {
				content: [{ type: "text", text: RESULT_TEXT }],
				details: { oldTodos, newTodos: incoming },
			};
		},

		renderCall(_args, _theme: Theme, ctx: RenderCtx) {
			const bullet = !ctx.executionStarted || ctx.isPartial ? orange("●") : ctx.isError ? red("●") : green("●");
			const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${bullet} ${BOLD}Update Todos${ATTR_RESET}`);
			return text;
		},

		renderResult(result: AgentToolResult<TodoDetails>, options: ToolRenderResultOptions, _theme: Theme, ctx: RenderCtx) {
			const list = ctx.lastComponent instanceof TodoList ? ctx.lastComponent : new TodoList();
			if (options.isPartial) {
				list.set([]);
				return list;
			}
			if (ctx.isError || !result.details) {
				const msg = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				list.set([], msg || "Error updating todos");
				return list;
			}
			list.set(result.details.newTodos);
			return list;
		},
	});
}
