/**
 * pi-ember — a warm finish for pi (UI inspired by Claude Code). Extension entry point.
 *
 * Order matters in places:
 *  - permissions first so its tool_call gate is registered before any tool runs;
 *  - background re-registers `bash` before tools.ts hands out renderers for it;
 *  - spinner before chrome so its `aboveEditor` widget is registered before any other widget;
 *  - rewind after permissions/tools: its tool_call checkpoint runs after the permission gate (no snapshot for rejected calls);
 *  - chrome last: header / editor / footer only read state the others publish on the bus;
 *  - the /ember setup command is independent and goes first so its session_start hint is registered early.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupBackground } from "./background.ts";
import { setupChrome } from "./chrome.ts";
import { setupMessages } from "./messages.ts";
import { setupPermissions } from "./permissions.ts";
import { setupRewind } from "./rewind.ts";
import { setupEmberCommand } from "./setup.ts";
import { setupSpinner } from "./spinner.ts";
import { setupTodo } from "./todo.ts";
import { setupToolRenderers } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
	setupEmberCommand(pi);
	setupPermissions(pi);
	setupBackground(pi);
	setupTodo(pi);
	setupToolRenderers(pi);
	setupRewind(pi);
	setupSpinner(pi);
	setupMessages(pi);
	setupChrome(pi);
}
