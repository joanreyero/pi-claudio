/**
 * workflows.ts — running workflows in the footer, ↓ to open them.
 *
 * pi-extensible-workflows draws its live run tree below the editor, so the prompt moves up and down as
 * runs start and end. `/claudio setup` turns that widget off (`backgroundWidget: false` in the package's
 * settings). Instead this module counts the session's unfinished runs from the package's events and
 * publishes `workflowCount`; the footer shows it next to the background tasks, and ↓ on an empty prompt
 * opens `/workflow`, the package's run browser. Inert without the package: no events arrive.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { actions, bus } from "./shared.ts";

/** The package's hard-terminal run states; every other state (paused, awaiting input, interrupted…) still needs a look. */
const FINISHED = new Set(["completed", "failed", "stopped"]);
/** Events that mean a run is (again) under way. */
const STARTED = ["workflow:run-started", "workflow:run-resumed"];
/** Activity of a run; it counts a run first seen through them, such as one already running before /reload. */
const ACTIVITY = ["workflow:agent-state-changed", "workflow:phase-changed", "workflow:checkpoint-state-changed", "workflow:budget-event"];

export function setupWorkflows(pi: ExtensionAPI): void {
	/** runId → last known state, for this session's runs. Finished runs stay, so late events cannot revive them. */
	const runs = new Map<string, string>();
	let sessionId: string | undefined;

	const publish = () => bus.set("workflowCount", [...runs.values()].filter((s) => !FINISHED.has(s)).length);
	const runOf = (event: unknown): string | undefined => {
		const { runId, sessionId: session } = (event ?? {}) as { runId?: unknown; sessionId?: unknown };
		return typeof runId === "string" && session === sessionId ? runId : undefined;
	};
	const track = (names: string[], next: (event: unknown, known: string | undefined) => string | undefined) => {
		for (const name of names) {
			pi.events.on(name, (event: unknown) => {
				const runId = runOf(event);
				if (!runId) return;
				const state = next(event, runs.get(runId));
				if (state === undefined) return;
				runs.set(runId, state);
				publish();
			});
		}
	};

	track(STARTED, () => "running");
	track(ACTIVITY, (_e, known) => (known === undefined ? "running" : undefined));
	track(["workflow:run-state-changed"], (e) => {
		const state = (e as { state?: unknown }).state;
		return typeof state === "string" ? state : undefined;
	});
	track(["workflow:run-completed"], () => "completed");
	track(["workflow:run-failed"], () => "failed");

	pi.on("session_start", (_event, ctx) => {
		runs.clear();
		sessionId = ctx.sessionManager.getSessionId();
		publish();
		if (ctx.mode === "tui") actions.openWorkflows = () => void pi.sendUserMessage("/workflow", { expandPromptTemplates: true });
	});
	pi.on("session_shutdown", () => {
		actions.openWorkflows = undefined;
		runs.clear();
		bus.set("workflowCount", 0);
	});
}
