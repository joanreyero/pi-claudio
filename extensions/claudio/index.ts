/**
 * pi-claudio — Claude Code's look and feel for pi. Extension entry point.
 *
 * Order matters in places:
 *  - permissions first so its tool_call gate is registered before any tool runs;
 *  - background re-registers `bash` before tools.ts hands out renderers for it;
 *  - pr (pr_watch / pr_status) after background: pr_watch starts a wake-enabled background task;
 *  - spinner before chrome so its `aboveEditor` widget is registered before any other widget;
 *  - ask (ask_user_question) before tools.ts so its renderer sees the tool;
 *  - rewind after permissions/tools: its tool_call checkpoint runs after the permission gate (no snapshot for rejected calls);
 *  - chrome last: header / editor / footer only read state the others publish on the bus;
 *  - herdr only subscribes to the bus, so its position does not matter;
 *  - the /claudio setup command is independent and goes first so its session_start hint is registered early.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupAsk } from "./ask.ts";
import { setupBackground } from "./background.ts";
import { setupChrome } from "./chrome.ts";
import { setupHerdr } from "./herdr.ts";
import { setupMessages } from "./messages.ts";
import { setupPermissions } from "./permissions.ts";
import { setupPr } from "./pr.ts";
import { setupRewind } from "./rewind.ts";
import { setupClaudioCommand } from "./setup.ts";
import { setupSpinner } from "./spinner.ts";
import { setupTodo } from "./todo.ts";
import { setupToolRenderers } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
	setupClaudioCommand(pi);
	setupPermissions(pi);
	setupBackground(pi);
	setupTodo(pi);
	setupAsk(pi);
	setupPr(pi);
	setupToolRenderers(pi);
	setupRewind(pi);
	setupSpinner(pi);
	setupMessages(pi);
	setupChrome(pi);
	setupHerdr(pi);
}
