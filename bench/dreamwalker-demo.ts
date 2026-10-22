/**
 * Preview the dreamwalker chrome in your terminal (the dreamwalker theme): a short transcript, then the editor card
 * and the footer in four moments of a run (running, a failing test, at risk, done).
 * Run: `node bench/dreamwalker-demo.ts`. Env: THEME (dreamwalker), WIDTH, HTML=path (also write the output as HTML).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import {
	getEditorTheme,
	loadThemeFromPath,
	setThemeInstance,
	theme as piTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Chronicle } from "../extensions/chronicle.ts";
import { DreamEditor } from "../extensions/editor.ts";
import { DreamFooter } from "../extensions/footer.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";
import { clock, signal } from "../extensions/signal.ts";
import { type DreamState, ToolFrame } from "../extensions/tools.ts";

setThemeInstance(loadThemeFromPath(fileURLToPath(new URL(`../themes/${process.env.THEME ?? "dreamwalker"}.json`, import.meta.url))));
const theme = piTheme as Theme;
const width = Number(process.env.WIDTH ?? Math.min(process.stdout.columns || 100, 110));
const tui = { terminal: { rows: 40, columns: width }, requestRender() {} } as unknown as TUI;
const labels = { provider: "magpie", model: "claude-opus-5-5", thinking: "high" };
const editor = new DreamEditor(tui, getEditorTheme(), { matches: () => false } as unknown as KeybindingsManager, () => theme, () => labels, 0);
// pi sets this from the thinking level.
editor.borderColor = theme.getThinkingBorderColor(labels.thinking as "high");
const data = { getGitBranch: () => "main", getExtensionStatuses: () => new Map([["fast", "⚡ fast"]]), onBranchChange: () => () => {} } as unknown as ReadonlyFooterDataProvider;
const footer = new DreamFooter(
	() => theme,
	data,
	() => ({
		sessionKey: () => "k",
		entries: () => [{ type: "message", message: { role: "assistant", usage: { input: 52_000, output: 6_000, cacheRead: 3_000_000, cacheWrite: 0, cost: { total: 2.42 } } } }],
		sessionName: () => undefined,
		cwd: () => `${process.env.HOME}/workspaces/pi-dreamwalker-theme`,
		context: () => ({ tokens: 52_000, contextWindow: 400_000, percent: 13 }),
	}),
	() => {},
);

// While busy the editor shows pi's working status in the row above the card and a band on the border (frozen mid-sweep here).
let busy = true;
editor.shimmerNow = () => 900;
(editor as unknown as { setWorkingStatusIndicator(i: unknown): void }).setWorkingStatusIndicator({
	get kind() {
		return busy ? "working" : "idle";
	},
	message: "Working",
	messageColorFn: (s: string) => theme.fg("muted", s),
	renderInBorder: () => "",
	renderSpinnerInBorder: () => theme.fg("accent", "⠋"),
});

const out: string[] = [];
const text = (lines: string[]) => out.push(...lines);
const chronicle = new Chronicle();
installMessageChrome({ theme: () => theme, chronicle, notify() {}, showRunStats: true });

const message = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "The p99 jump looks like an N+1 in the orders handler.\n\nRead the route first, then the Prisma calls." },
		{ type: "text", text: "Located an N+1 query in `app/api/orders/route.ts`: every request fans out **50+** `lineItem.findMany` round-trips.\n\n- Replaced the loop with one query using `include`\n- p99 drops from 2.4s to 198ms\n\n> Add a lint rule so future N+1 regressions surface in CI." },
	],
	timestamp: 5_000,
	durationMs: 61_000,
	stopReason: "stop",
	model: "claude-opus-5-5",
	usage: { input: 1000, output: 1200, cacheRead: 30_000, cacheWrite: 0, cost: { total: 0.42 } },
};
chronicle.reindex([
	{ type: "message", message: { role: "user", content: "investigate why /api/orders p99 jumped to 2.4s in production", timestamp: 1_000 } as never },
	{ type: "message", message: message as never },
]);

const row = (
	toolName: string,
	args: Record<string, unknown>,
	status: "done" | "error" | "running",
	opts: { id: string; ms?: number; parts?: { text: string; tone: "ok" | "bad" | "dim" }[]; body?: string[]; shown?: string[] },
) => {
	const state: DreamState = { dreamSummary: { result: {}, summary: opts.parts ? { parts: opts.parts } : undefined } };
	const meta = { callId: opts.id, state, live: false, toolName, args };
	const inner = (lines: string[]) => new Text(lines.join("\n"), 0, 0);
	out.push(...new ToolFrame("call", { bodyShown: !!opts.shown }).update(inner(["", ...(opts.shown ?? [])]), theme, status, opts.ms, 3, meta).render(width));
	if (opts.body) out.push(...new ToolFrame("result").update(inner(opts.body), theme, status, undefined, 3, meta).render(width));
};
const show = (title: string) => out.push("", theme.fg("dim", `── ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`));
const frame = () => out.push(...editor.render(width), ...footer.render(width));

text(new UserMessageComponent("investigate why /api/orders p99 jumped to 2.4s in production", getMarkdownTheme(), 1).render(width));
out.push("");
row("read", { path: "app/api/orders/route.ts" }, "done", { id: "r0", ms: 120, parts: [{ text: "28 lines", tone: "dim" }] });
out.push("");
row("edit", { path: "app/api/orders/route.ts" }, "done", { id: "e0", ms: 400, parts: [{ text: "+9", tone: "ok" }, { text: "-14", tone: "bad" }], shown: ["-const enriched = await Promise.all(orders.map(", "+const orders = await prisma.order.findMany({ include })"] });
out.push("");
row("bash", { command: "pnpm bench:orders" }, "done", { id: "b0", ms: 6100, parts: [{ text: "✓ 41", tone: "ok" }], body: ["p50: 82ms -> 38ms (-54%)", "p99: 2,418ms -> 198ms (-92%)"] });
out.push("");
text(new AssistantMessageComponent(message as never, false, getMarkdownTheme(), "Thinking…", 1).render(width));

const start = Date.now() - 26_000;
clock.now = () => start + 26_000;
signal.agentStart(start);
show("running");
frame();

show("a failing test");
signal.toolResult("bash", { command: "pnpm test" }, true);
row("bash", { command: "pnpm test" }, "error", { id: "b1", ms: 6100, parts: [{ text: "✓ 41", tone: "ok" }, { text: "✕ 3", tone: "bad" }], body: ["FAIL  totals match at 23:59 local time"] });
frame();

show("at risk: the same patch again");
signal.toolResult("edit", { path: "src/cart/total.ts" }, false);
signal.toolResult("bash", { command: "pnpm test" }, true);
signal.toolResult("edit", { path: "src/cart/total.ts" }, false);
signal.toolResult("edit", { path: "src/cart/total.ts" }, false);
clock.now = () => start + 93_000;
frame();

show("done");
busy = false;
signal.agentEnd("stop", start + 65_000);
frame();
uninstallMessageChrome();

const lines = out.map((l) => l.replace(/\x1b_pi:[^\x07]*\x07/g, "").replace(/\x1b\]133;[^\x07]*\x07/g, ""));
process.stdout.write(`${lines.join("\n")}\n`);
if (process.env.HTML) writeFileSync(process.env.HTML, toHtml(lines));

/** The output as a dark HTML page (SGR colors, bold, faint, reverse), for screenshots. */
function toHtml(rows: string[]): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const body = rows
		.map((row) => {
			let fg = "";
			let bold = false;
			let dim = false;
			let rev = false;
			let html = "";
			let last = 0;
			const flush = (chunk: string) => {
				if (!chunk) return;
				const style = [fg && `color:${fg}`, bold && "font-weight:700", dim && "opacity:.6", rev && "background:#ddd;color:#101014"].filter(Boolean).join(";");
				html += style ? `<span style="${style}">${esc(chunk)}</span>` : esc(chunk);
			};
			for (const m of row.matchAll(/\x1b\[([0-9;:]*)m/g)) {
				flush(row.slice(last, m.index));
				last = m.index + m[0].length;
				const codes = m[1]!.split(/[;:]/).map(Number);
				for (let i = 0; i < codes.length; i++) {
					const c = codes[i]!;
					if (c === 0) [fg, bold, dim, rev] = ["", false, false, false];
					else if (c === 1) bold = true;
					else if (c === 2) dim = true;
					else if (c === 22) bold = dim = false;
					else if (c === 7) rev = true;
					else if (c === 27) rev = false;
					else if (c === 39) fg = "";
					else if (c === 38 && codes[i + 1] === 2) {
						fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
						i += 4;
					}
				}
			}
			flush(row.slice(last));
			return html;
		})
		.join("\n");
	return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#101014"><pre style="margin:0;padding:16px 20px;color:#dcdcda;font:14px/1.45 'JetBrains Mono','SF Mono',Menlo,monospace">${body}</pre>`;
}
