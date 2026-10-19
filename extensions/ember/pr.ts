/**
 * pr.ts — GitHub pull-request tools built on the wake-on-output background tasks of background.ts.
 *
 * - `pr_watch`: starts `scripts/pr-watch` (bundled with the package) as a background task with
 *   `wake` enabled and a wake_pattern for its event lines, so CI results, reviews and comments wake
 *   the agent. It is a thin wrapper: no polling lives in the extension.
 * - `pr_status`: an immediate snapshot via `gh` (title, state, checks, reviews, decision, comments).
 *
 * Rendering (`● PR Watch(#123 · every 60s)`, `● PR Status(#123)`) is in tools.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { startBackgroundTask } from "./background.ts";

/** `details` of pr_* results: tools.ts draws the row from `number`, `interval` and `summary`. */
export interface PrToolDetails {
	number?: number;
	interval?: number;
	/** Collapsed preview lines under `⎿`. */
	summary: string[];
	/** Extra lines shown when expanded (ctrl+o). */
	full?: string[];
	taskId?: string;
}

/** `<package>/scripts/pr-watch`, resolved from this file so it works from the git install too. */
const PR_WATCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "pr-watch");
const WAKE_PATTERN = "^(CHECKS|CHECK_FAILED|REVIEW|COMMENT|DECISION|STATE|DONE)";
const UNTIL = ["first_event", "ci_done", "review", "merged"] as const;

async function gh(pi: ExtensionAPI, args: string[], cwd: string): Promise<string> {
	const r = await pi.exec("gh", args, { cwd, timeout: 60_000 });
	if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `gh ${args[0]} failed`);
	return r.stdout;
}

/** `[repo, number]` from the args or the current branch (`gh pr view`). */
async function resolvePr(pi: ExtensionAPI, cwd: string, repo: string | undefined, pr: number | undefined): Promise<{ repo: string; number: number }> {
	const base = repo ? ["-R", repo] : [];
	const out = await gh(pi, ["pr", "view", ...(pr !== undefined ? [String(pr)] : []), ...base, "--json", "number,headRepository,headRepositoryOwner,baseRefName,url"], cwd);
	const v = JSON.parse(out) as { number: number; url: string };
	const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(v.url);
	return { repo: repo ?? m?.[1] ?? "", number: v.number };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const oneLine = (s: string, n = 200) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function setupPr(pi: ExtensionAPI): void {
	const prDesc = "PR number. Omit to use the PR of the current branch.";
	const repoDesc = "owner/name. Omit to use the repository of the current directory.";

	// ── pr_watch ──
	const watchParams = Type.Object({
		pr: Type.Optional(Type.Number({ description: prDesc })),
		repo: Type.Optional(Type.String({ description: repoDesc })),
		interval: Type.Optional(Type.Number({ description: "Poll interval in seconds (default 60, min 10)." })),
		until: Type.Optional(
			Type.Union(
				UNTIL.map((u) => Type.Literal(u)),
				{ description: "When the watcher exits: first_event (default), ci_done, review (a review, comment or decision), merged (or closed)." },
			),
		),
		log_failed: Type.Optional(Type.Boolean({ description: "On a failed check, also print the last 40 lines of its failed job log." })),
		include_self: Type.Optional(Type.Boolean({ description: "Also report reviews/comments by the current gh user (skipped by default, since your own gh comments would wake you)." })),
	});
	pi.registerTool<typeof watchParams, PrToolDetails | undefined>({
		name: "pr_watch",
		label: "PR Watch",
		description:
			"Watch a GitHub pull request in the background and be woken when something happens: CI finishes or fails " +
			"(CHECKS / CHECK_FAILED lines), a review or comment arrives (REVIEW / COMMENT), the review decision changes " +
			"(DECISION), it is merged or closed (STATE), and when the watcher stops (DONE <reason>). Built on `bash` with " +
			"wake=true; stop it with kill_shell. Offer this right after `gh pr create` or when asked to wait for CI or a " +
			"review. Never busy-wait: start it, end your turn, act when woken.",
		promptSnippet: "Watch a PR; wake on CI, reviews and comments",
		parameters: watchParams,
		async execute(_id, args, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd || process.cwd();
			if (!existsSync(PR_WATCH_SCRIPT)) {
				return { content: [{ type: "text", text: `pr-watch script not found at ${PR_WATCH_SCRIPT}` }], details: undefined, isError: true };
			}
			let ref: { repo: string; number: number };
			try {
				ref = await resolvePr(pi, cwd, args.repo, args.pr);
			} catch (e) {
				return { content: [{ type: "text", text: `Could not resolve the PR: ${e instanceof Error ? e.message : String(e)}` }], details: undefined, isError: true };
			}
			const interval = Math.max(10, Math.round(args.interval ?? 60));
			const until = args.until ?? "first_event";
			const command = [
				shq(PR_WATCH_SCRIPT),
				...(ref.repo ? ["--repo", shq(ref.repo)] : []),
				"--pr",
				String(ref.number),
				"--interval",
				String(interval),
				"--until",
				until,
				...(args.log_failed ? ["--log-failed"] : []),
				...(args.include_self ? ["--include-self"] : []),
			].join(" ");
			const title = `PR #${ref.number}`;
			const task = startBackgroundTask(pi, command, cwd, undefined, { title, pattern: WAKE_PATTERN, debounceMs: 3000 });
			const summary = [`Watching ${ref.repo ? `${ref.repo}#` : "#"}${ref.number} every ${interval}s until ${until.replace("_", " ")} (task ${task.id})`];
			const text =
				`${summary[0]}.\nEvents wake you as lines: CHECKS head=<sha> ok=N failing=N pending=N · CHECK_FAILED <name> <url> · ` +
				`REVIEW <author> <state> <text> · COMMENT <author> [<path>:<line>] <text> · DECISION <d> · STATE merged|closed · DONE <reason>.\n` +
				`Stop it with kill_shell ${task.id}. End your turn now and act when woken.`;
			return { content: [{ type: "text", text }], details: { number: ref.number, interval, summary, taskId: task.id } };
		},
	});

	// ── pr_status ──
	const statusParams = Type.Object({
		pr: Type.Optional(Type.Number({ description: prDesc })),
		repo: Type.Optional(Type.String({ description: repoDesc })),
	});
	pi.registerTool<typeof statusParams, PrToolDetails | undefined>({
		name: "pr_status",
		label: "PR Status",
		description:
			"Immediate snapshot of a GitHub pull request via gh: title, state, checks summary (with failed check URLs), " +
			"reviews, review decision and the latest comments. For waiting on changes use pr_watch instead.",
		promptSnippet: "Snapshot of a PR: checks, reviews, comments",
		parameters: statusParams,
		async execute(_id, args, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd || process.cwd();
			try {
				const ref = await resolvePr(pi, cwd, args.repo, args.pr);
				const base = ref.repo ? ["-R", ref.repo] : [];
				const n = String(ref.number);
				const [viewOut, checksOut, reviewsOut, rcOut, icOut] = await Promise.all([
					gh(pi, ["pr", "view", n, ...base, "--json", "title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus"], cwd),
					pi.exec("gh", ["pr", "checks", n, ...base, "--json", "name,bucket,link"], { cwd, timeout: 60_000 }).then((r) => r.stdout.trim()),
					gh(pi, ["api", "--paginate", "--slurp", `repos/${ref.repo}/pulls/${n}/reviews`], cwd),
					gh(pi, ["api", "--paginate", "--slurp", `repos/${ref.repo}/pulls/${n}/comments`], cwd),
					gh(pi, ["api", "--paginate", "--slurp", `repos/${ref.repo}/issues/${n}/comments`], cwd),
				]);
				const v = JSON.parse(viewOut) as Record<string, string | boolean>;
				const checks = (checksOut.startsWith("[") ? (JSON.parse(checksOut) as Array<{ name: string; bucket: string; link: string }>) : []);
				// --slurp returns an array of pages.
				const parse = (s: string): Array<Record<string, any>> => (s.trim() ? (JSON.parse(s.trim()) as unknown[]).flatMap((p) => (Array.isArray(p) ? p : [p])) : []);
				const reviews = parse(reviewsOut).filter((r) => r.state !== "PENDING");
				const comments = [...parse(rcOut), ...parse(icOut)].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
				const count = (b: string) => checks.filter((c) => c.bucket === b).length;
				const fails = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
				const state = v.state === "OPEN" && v.isDraft ? "draft" : String(v.state).toLowerCase();
				const decision = String(v.reviewDecision || "none").toLowerCase().replace(/_/g, " ");
				const checksLine = checks.length ? `Checks: ${count("pass")} ok, ${fails.length} failing, ${count("pending")} pending` : "Checks: none reported";
				const summary = [
					`${v.title} — ${state} · ${v.headRefName} → ${v.baseRefName} · review: ${decision}`,
					checksLine,
					`${reviews.length} reviews, ${comments.length} comments`,
				];
				const full: string[] = [`URL: ${v.url} · merge state: ${String(v.mergeStateStatus || "unknown").toLowerCase()}`];
				for (const c of fails) full.push(`  ✗ ${c.name} ${c.link}`);
				for (const r of reviews) full.push(`  review ${r.user?.login} ${r.state}${r.body ? ` — ${oneLine(r.body)}` : ""}`);
				for (const c of comments.slice(-10)) full.push(`  comment ${c.user?.login}${c.path ? ` ${c.path}:${c.line ?? c.original_line ?? "?"}` : ""} — ${oneLine(c.body)}`);
				return { content: [{ type: "text", text: [`PR #${ref.number}`, ...summary, ...full].join("\n") }], details: { number: ref.number, summary, full } };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text", text: `pr_status failed: ${msg}` }], details: { summary: [msg] }, isError: true };
			}
		},
	});
}
