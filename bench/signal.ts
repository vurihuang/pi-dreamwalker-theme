/**
 * Cost of the run signal (signal.ts) on the paint path. Run: `node bench/signal.ts`
 *
 * Every number is per frame (or per event), steady state, with `features.runSignal`,
 * `resultLine` and `statusChip` on versus off. The signal adds no timer: the only timers are the four
 * a failure schedules for its flash, counted at the end.
 */
import { performance } from "node:perf_hooks";
import {
	initTheme,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { getEditorTheme, theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DREAMWALKER } from "../extensions/config.ts";
import { DreamEditor } from "../extensions/editor.ts";
import { DreamFooter } from "../extensions/footer.ts";
import { clock, signal } from "../extensions/signal.ts";
import { summarizeResult } from "../extensions/summary.ts";
import { ToolFrame } from "../extensions/tools.ts";

initTheme("dark");
const WIDTH = 120;
const N = 20_000;
const theme = piTheme as Theme;

function perCall(fn: () => void): number {
	for (let i = 0; i < 2000; i++) fn(); // warm up
	const t = performance.now();
	for (let i = 0; i < N; i++) fn();
	return ((performance.now() - t) / N) * 1000; // µs
}

const tui = { terminal: { rows: 40, columns: WIDTH }, requestRender() {} } as unknown as TUI;
const editor = new DreamEditor(
	tui,
	getEditorTheme(),
	{ matches: () => false } as unknown as KeybindingsManager,
	() => theme,
	() => ({ provider: "p", model: "m", thinking: "high" }),
	0,
);
editor.setText("hello\nworld");
const data = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} } as unknown as ReadonlyFooterDataProvider;
const entries = Array.from({ length: 2000 }, () => ({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, cost: { total: 0.001 } } } }));
const footer = new DreamFooter(() => theme, data, () => ({ sessionKey: () => "k", entries: () => entries, sessionName: () => "n" }), () => {});

const frame = new ToolFrame("call").update(new Text("read a.ts", 0, 0), theme, "done", 1500, 1, {
	callId: "t",
	toolName: "read",
	args: { path: "a.ts" },
	state: { dreamSummary: { result: {}, summary: { parts: [{ text: "212 lines", tone: "dim" }] } } },
});

function measure(label: string) {
	const e = perCall(() => editor.render(WIDTH));
	const f = perCall(() => footer.render(WIDTH));
	const r = perCall(() => frame.render(WIDTH));
	console.log(`${label.padEnd(34)} editor ${e.toFixed(2)} µs   footer ${f.toFixed(2)} µs   settled tool row ${r.toFixed(2)} µs`);
}

const features = DREAMWALKER.features;
const set = (on: boolean) => {
	features.runSignal = features.resultLine = features.statusChip = on;
};

set(false);
measure("signal off, idle");
set(true);
signal.reset();
measure("signal on, idle");

signal.agentStart();
measure("signal on, running (status chip)");
for (let i = 0; i < 3; i++) signal.toolResult("read", { path: `f${i}` }, true);
clock.now = () => signal.riskSince + 10_000;
measure("signal on, at risk (red frame)");
signal.agentEnd("aborted");
measure("signal on, paused");
signal.reset();

// Event handlers.
const input = { path: "a.ts" };
const tool = perCall(() => signal.toolResult("edit", input, false));
signal.reset();
console.log(`tool_result handler (no flash): ${tool.toFixed(2)} µs`);
const glyphs = { pass: "✓", fail: "✕" };
const diff = Array.from({ length: 400 }, (_, i) => `${i % 2 ? "+" : "-"}${i} line of code`).join("\n");
const edit = perCall(() => summarizeResult("edit", {}, { details: { diff } }, false, glyphs));
const log = { content: [{ type: "text", text: `${"x".repeat(80)}\n`.repeat(2000) + "Tests: 3 failed, 41 passed, 44 total" }] };
const test = perCall(() => summarizeResult("bash", { command: "pnpm test" }, log, true, glyphs));
console.log(`summary, once per result: 400-line diff ${edit.toFixed(1)} µs, 160 KB test log ${test.toFixed(1)} µs`);
