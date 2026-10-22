/**
 * Run signal and what is drawn from it: state machine, flash steps, result summaries, the tool rows'
 * summary line, the editor frame and the status row's chip.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { initTheme, type KeybindingsManager, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	getEditorTheme,
	theme as piTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { DREAMWALKER } from "../extensions/config.ts";
import { DreamEditor } from "../extensions/editor.ts";
import { formatElapsed } from "../extensions/format.ts";
import { installToolGrouping } from "../extensions/grouping.ts";
import { clock, flashStep, isLit, RunState, setFlashRender, signal } from "../extensions/signal.ts";
import { countLines, diffStat, summarizeResult, summaryText, testCounts } from "../extensions/summary.ts";
import { createToolRenderers, ToolFrame } from "../extensions/tools.ts";

initTheme("dark");
const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g;
const plain = (line: string) => line.replace(ANSI, "");
const theme = () => piTheme as Theme;
const glyphs = { pass: "✓", fail: "✕" };
const realNow = clock.now;

afterEach(() => {
	signal.reset();
	clock.now = realNow;
});

/** The SGR prefix a theme token paints with. */
const sgrOf = (token: Parameters<Theme["fg"]>[0]) => theme().fg(token, "x").split("x")[0]!;

// ── State machine ──────────────────────────────────────────────────────────────────────────────

test("signal: three failed tools in a row put the run at risk; two successes clear it", () => {
	const s = new RunState();
	s.agentStart(1000);
	assert.equal(s.toolResult("read", { path: "a" }, true), false);
	assert.equal(s.toolResult("read", { path: "b" }, true), false);
	assert.equal(s.phase, "running");
	assert.equal(s.toolResult("read", { path: "c" }, true), true, "entering risk is reported once");
	assert.equal(s.phase, "risk");
	assert.ok(s.riskSince > 0);
	assert.equal(s.toolResult("read", { path: "d" }, true), false, "already at risk");
	s.toolResult("read", { path: "e" }, false);
	assert.equal(s.phase, "risk", "one success is not enough");
	s.toolResult("read", { path: "f" }, false);
	assert.equal(s.phase, "running");
	assert.equal(s.riskSince, 0);
});

test("signal: the same call repeated with failures in between is a loop; successes alone are not", () => {
	const s = new RunState();
	s.agentStart(0);
	// A busy edit session: five edits of one file, all succeeding.
	for (let i = 0; i < 5; i++) s.toolResult("edit", { path: "a.ts" }, false);
	assert.equal(s.phase, "running");
	s.agentStart(0);
	// edit, failing test, edit, failing test, edit: the same patch over and over.
	s.toolResult("edit", { path: "a.ts" }, false);
	s.toolResult("bash", { command: "pnpm test" }, true);
	s.toolResult("edit", { path: "a.ts" }, false);
	assert.equal(s.phase, "running", "two failures are needed");
	s.toolResult("bash", { command: "pnpm test" }, true);
	s.toolResult("edit", { path: "a.ts" }, false);
	assert.equal(s.phase, "risk");
});

test("signal: nested calls and results outside a run are ignored; the run's end sets the outcome", () => {
	const s = new RunState();
	assert.equal(s.toolResult("read", {}, true), false, "no run");
	s.agentStart(0);
	for (let i = 0; i < 5; i++) s.toolResult("read", {}, true, "parent");
	assert.equal(s.phase, "running", "codemode children do not count");
	s.toolStart("c1");
	s.toolStart("c2", "c1");
	assert.equal(s.currentCall, "c1", "nested starts do not move the playhead");
	s.agentEnd("aborted", 5000);
	assert.equal(s.phase, "paused");
	assert.equal(s.currentCall, undefined);
	s.touch();
	assert.equal(s.phase, "idle", "typing hands the editor back");
	s.agentStart(0);
	s.agentEnd("error", 1);
	assert.equal(s.phase, "failed");
	s.touch();
	assert.equal(s.phase, "failed", "touch only ends a pause");
	s.agentStart(0);
	s.agentEnd("stop", 1);
	assert.equal(s.phase, "done");
});

test("flash: lit, off, lit, off, then settled; never before it began", () => {
	const lit = (since: number, now: number) => isLit(flashStep(since, now));
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	assert.equal(flashStep(0, 5000), -1, "no flash was started");
	assert.deepEqual(
		Array.from({ length: flashSteps }, (_, k) => lit(1000, 1000 + k * flashStepMs + 1)),
		[true, false, true, false],
	);
	assert.equal(flashStep(1000, 1000 + flashSteps * flashStepMs), -1, "settled");
	assert.equal(flashStep(1000, 999), -1);
});

test("flash: a failure asks for a frame at each step boundary, nothing else does", async () => {
	// Let the flashes earlier tests started finish, so only this test's frames are counted.
	await new Promise((r) => setTimeout(r, DREAMWALKER.signal.flashStepMs * (DREAMWALKER.signal.flashSteps + 2)));
	let frames = 0;
	setFlashRender(() => frames++);
	const s = new RunState();
	s.agentStart(0);
	for (let i = 0; i < 20; i++) s.toolResult("read", { path: `f${i}` }, false);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(frames, 0, "successful calls schedule nothing");
	for (let i = 0; i < 3; i++) s.toolResult("read", { path: `x${i}` }, true);
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	await new Promise((r) => setTimeout(r, flashStepMs * (flashSteps + 2)));
	setFlashRender(undefined);
	assert.equal(frames, flashSteps);
});

test("elapsed time reads as seconds, minutes, hours", () => {
	assert.equal(formatElapsed(26), "26s");
	assert.equal(formatElapsed(65), "1m05s");
	assert.equal(formatElapsed(3720), "1h02m");
});

// ── Result summaries ───────────────────────────────────────────────────────────────────────────

test("summary: edit diff, write, read, search and shell results", () => {
	const text = (t: string) => ({ content: [{ type: "text", text: t }] });
	const diff = "-1 old\n+1 new\n+2 more\n 3 same\n-4 gone";
	assert.deepEqual(diffStat(diff), { added: 2, removed: 2 });
	assert.equal(summaryText(summarizeResult("edit", {}, { ...text("ok"), details: { diff } }, false, glyphs)), "+2 -2");
	assert.equal(summaryText(summarizeResult("write", { content: "a\nb\nc\n" }, text("ok"), false, glyphs)), "+3");
	assert.equal(summaryText(summarizeResult("read", {}, text("a\nb\nc"), false, glyphs)), "3 lines");
	assert.equal(
		summaryText(summarizeResult("read", {}, text("x\n\n[Showing lines 1-2000 of 5400. Use offset=2001 to continue.]"), false, glyphs)),
		"5400 lines",
	);
	assert.equal(summaryText(summarizeResult("grep", {}, text("a.ts:1: x\nb.ts:2: y"), false, glyphs)), "2 matches");
	assert.equal(summaryText(summarizeResult("grep", {}, text("No matches found"), false, glyphs)), "0 matches");
	assert.equal(summaryText(summarizeResult("ls", {}, text("a\nb\nc"), false, glyphs)), "3 entries");
	assert.equal(summaryText(summarizeResult("bash", { command: "ls" }, text("fine"), false, glyphs)), "", "plain commands show nothing");
	assert.equal(
		summaryText(summarizeResult("bash", { command: "false" }, text("\n\nCommand exited with code 2"), true, glyphs)),
		"exit 2",
	);
	assert.equal(summaryText(summarizeResult("mcp_thing", {}, text("x"), false, glyphs)), "");
	assert.equal(countLines("a\nb\n"), 2);
	assert.equal(countLines(""), 0);
});

test("summary: test counts from jest, vitest, pytest, node:test and cargo output", () => {
	assert.deepEqual(testCounts("Tests:       3 failed, 41 passed, 44 total"), { passed: 41, failed: 3 });
	assert.deepEqual(testCounts("Tests  3 failed | 41 passed (44)"), { passed: 41, failed: 3 });
	assert.deepEqual(testCounts("=== 3 failed, 41 passed in 1.2s ==="), { passed: 41, failed: 3 });
	assert.deepEqual(testCounts("ℹ tests 101\nℹ pass 98\nℹ fail 3"), { passed: 98, failed: 3 });
	assert.deepEqual(testCounts("test result: ok. 41 passed; 0 failed; 0 ignored"), { passed: 41, failed: 0 });
	const result = { content: [{ type: "text", text: "Tests: 3 failed, 41 passed, 44 total" }] };
	assert.equal(summaryText(summarizeResult("bash", { command: "pnpm test" }, result, true, glyphs)), "✓ 41 ✕ 3");
	assert.equal(summaryText(summarizeResult("bash", { command: "echo 41 passed" }, result, false, glyphs)), "", "only test commands are read");
	// Only the tail is read: a huge log costs the same.
	const big = { content: [{ type: "text", text: `${"noise 7 passed\n".repeat(50_000)}Tests: 2 passed` }] };
	assert.equal(summaryText(summarizeResult("bash", { command: "vitest" }, big, false, glyphs)), "✓ 2");
});

// ── Tool rows ──────────────────────────────────────────────────────────────────────────────────

const inner = (...rows: string[]) => new Text(rows.join("\n"), 0, 0);
const read = { toolName: "read", args: { path: "a.ts" } };

test("summary line: a failed tool gets a `↳ failed` in the error color; a running or quick one stays one row", () => {
	const row = (status: "running" | "done" | "error", ms?: number) =>
		new ToolFrame("call").update(inner("read a.ts"), theme(), status, ms, 1, { callId: status, ...read }).render(40);
	assert.equal(row("running").length, 1);
	assert.equal(row("done", 50).length, 1);
	const failed = row("error", 50);
	assert.equal(plain(failed[1]!).trim(), "↳ failed");
	assert.ok(failed[1]!.includes(sgrOf("error")), "the error color");
	assert.ok(!row("done", 1500)[1]!.includes(sgrOf("error")), "a slow success is not an error");
});

test("flash: a live failure blinks its ↳ in steps, then settles; rows rebuilt from history never blink", () => {
	let now = 50_000;
	clock.now = () => now;
	const lit = (line: string) => line.includes("\x1b[7m");
	const state = {};
	const call = new ToolFrame("call");
	const feed = (status: "running" | "error") =>
		call.update(inner("read a.ts"), theme(), status, undefined, 1, { callId: "t", state, live: true, ...read });
	feed("running");
	assert.ok(!call.render(40).some(lit));
	feed("error");
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	const seen: boolean[] = [];
	for (let k = 0; k <= flashSteps; k++) {
		now = 50_000 + k * flashStepMs + 1;
		seen.push(lit(call.render(40)[1]!));
	}
	assert.deepEqual(seen, [true, false, true, false, false]);
	assert.equal(plain(call.render(40)[1]!).trim(), "↳ failed", "settled: the plain mark");

	const history = new ToolFrame("call");
	history.update(inner("read a.ts"), theme(), "pending", undefined, 1, { callId: "h", state: {}, live: false, ...read });
	history.update(inner("read a.ts"), theme(), "error", undefined, 1, { callId: "h", state: {}, live: false, ...read });
	for (let k = 0; k < flashSteps; k++) {
		now = 90_000 + k * flashStepMs;
		assert.ok(!history.render(40).some(lit), "resumed sessions do not replay failures");
	}
});

test("summary line: summary then duration under the call row, cached until the summary changes", () => {
	const state: { dreamSummary?: { result: unknown; summary: never } } = {};
	const call = new ToolFrame("call");
	const feed = () =>
		call.update(inner("edit a.ts"), theme(), "done", 1500, 1, { callId: "t", state: state as never, toolName: "edit", args: { path: "a.ts" } });
	feed();
	const bare = call.render(60);
	assert.deepEqual(bare.map(plain), [" Edit a.ts", "   ↳ 1.5s"]);
	state.dreamSummary = { result: {}, summary: { parts: [{ text: "+12", tone: "ok" }, { text: "-4", tone: "bad" }] } as never };
	feed();
	const row = call.render(60);
	assert.notEqual(row, bare);
	assert.deepEqual(row.map(plain), [" Edit a.ts", "   ↳ +12 -4 · 1.5s"]);
	assert.ok(row[1]!.includes(sgrOf("success") + "+12") && row[1]!.includes(sgrOf("error") + "-4"));
	assert.equal(call.render(60), row, "unchanged inputs reuse the rows");
	DREAMWALKER.features.resultLine = false;
	try {
		call.invalidate();
		assert.deepEqual(call.render(60).map(plain), [" Edit a.ts"], "switchable");
	} finally {
		DREAMWALKER.features.resultLine = true;
	}
});

test("summary line: a real edit tool and a group card show their summaries", () => {
	const ui = { requestRender() {} };
	const make = (name: string, id: string, args: Record<string, unknown>, text: string, details?: unknown) => {
		// pi's edit draws its own card (`renderShell: "self"`), which the tool rows unbox.
		const builtIn = { ...withBuiltInRenderers(name, undefined), ...(name === "edit" ? { renderShell: "self" } : {}) };
		const def = createToolRenderers(name, builtIn as never);
		const c = new ToolExecutionComponent(name, id, args, { showImages: false, outputPad: 1 }, { name, ...def } as never, ui as never, "/tmp");
		c.setArgsComplete();
		c.markExecutionStarted();
		c.updateResult({ content: [{ type: "text", text }], details, isError: false } as never, false);
		return c;
	};
	const edit = make("edit", "e1", { path: "/tmp/a.ts", edits: [] }, "ok", { diff: "-1 a\n+1 b\n+2 c" });
	const rows = edit.render(80).map(plain).filter((l) => l.trim());
	assert.match(rows[0]!, /^ {3}Edit \/tmp\/a\.ts/);
	assert.match(rows[1]!, /^ {5}↳ \+2 -1$/);

	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(theme());
	try {
		const chat = new Container();
		for (let i = 0; i < 3; i++) chat.addChild(make("read", `r${i}`, { path: `/tmp/${i}.ts` }, "a\nb\nc\nd"));
		assert.equal(chat.children.length, 1, "three reads fold into one card");
		const card = chat.render(80).map(plain);
		assert.match(card.find((l) => l.trim())!, /^Read ×3 · ctrl\+o/, card.join("\n"));
		assert.equal(card.filter((l) => /^ {2}↳ \/tmp\/\d\.ts\s+4 lines$/.test(l)).length, 3, card.join("\n"));
	} finally {
		grouping.shutdown();
	}
});

// ── Editor frame ───────────────────────────────────────────────────────────────────────────────

function makeEditor() {
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} } as unknown as TUI;
	return new DreamEditor(tui, getEditorTheme(), { matches: () => false } as unknown as KeybindingsManager, theme, () => ({}), 0);
}

// Row 0 is the rule, row 1 the status row; the card starts at row 2.
test("editor frame: pi's border color (thinking level), error-colored at risk (after its blink)", () => {
	const editor = makeEditor();
	// pi drives `borderColor` from the thinking level (and `!` mode); the card follows it.
	editor.borderColor = (text) => theme().fg("thinkingHigh", text);
	assert.ok(editor.render(100)[2]!.startsWith(sgrOf("thinkingHigh") + "╭"), "idle: pi's border color");
	editor.borderColor = (text) => theme().fg("thinkingLow", text);
	assert.ok(editor.render(100)[2]!.startsWith(sgrOf("thinkingLow") + "╭"), "a new level changes it");
	signal.agentStart();
	for (let i = 0; i < 3; i++) signal.toolResult("read", { path: `f${i}` }, true);
	assert.equal(signal.phase, "risk");
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	// Flash: error, usual, error, usual.
	const starts: boolean[] = [];
	for (let k = 0; k < flashSteps; k++) {
		clock.now = () => signal.riskSince + k * flashStepMs + 1;
		starts.push(editor.render(100)[2]!.startsWith(sgrOf("error") + "╭"));
	}
	assert.deepEqual(starts, [true, false, true, false]);
	clock.now = () => signal.riskSince + 10_000;
	const risk = editor.render(100);
	for (const line of [risk[2]!, risk[3]!, risk.at(-1)!]) assert.ok(line.includes(sgrOf("error")), "every edge of the frame");
	assert.equal(visibleWidth(risk[2]!), 100);
	assert.match(plain(risk[1]!), /^ ● at risk \d+s/, "the status row names it");
	signal.agentEnd("aborted");
	assert.ok(editor.render(100)[2]!.startsWith(sgrOf("thinkingLow") + "╭"), "paused: the frame is back to normal");
	DREAMWALKER.features.runSignal = false;
	try {
		signal.agentStart();
		for (let i = 0; i < 3; i++) signal.toolResult("read", { path: `f${i}` }, true);
		clock.now = () => signal.riskSince + 10_000;
		assert.ok(editor.render(100)[2]!.startsWith(sgrOf("thinkingLow") + "╭"), "switchable");
	} finally {
		DREAMWALKER.features.runSignal = true;
	}
});

// ── Status row chip ────────────────────────────────────────────────────────────────────────────

test("status row chip: idle has none; running, risk, paused and done each have a stable one", () => {
	const editor = makeEditor();
	const row = () => plain(editor.render(100)[1]!);
	assert.equal(row().trim(), "", "no chip while idle");
	clock.now = () => 1_000_000;
	signal.agentStart(1_000_000);
	clock.now = () => 1_026_100;
	assert.match(row(), /^ ● running 26s\s*$/);
	for (let i = 0; i < 3; i++) signal.toolResult("read", { path: `f${i}` }, true);
	assert.match(row(), /^ ● at risk 26s\s*$/);
	signal.agentEnd("aborted", 1_030_000);
	clock.now = () => 5_000_000;
	assert.match(row(), /^ ❚❚ paused 30s\s*$/);
	signal.agentStart(5_000_000);
	signal.agentEnd("stop", 5_065_000);
	assert.match(row(), /^ ✓ done 1m05s\s*$/);
	assert.equal(visibleWidth(editor.render(100)[1]!), 100);
	assert.ok(visibleWidth(editor.render(8)[1]!) <= 8);
});

test("status row chip: the blink dims the dot; switchable", () => {
	const editor = makeEditor();
	clock.now = () => 700_000;
	signal.agentStart(700_000);
	const first = editor.render(100)[1]!;
	clock.now = () => 701_000; // floor(701000 / 700) = 1001 is odd, floor(700000 / 700) = 1000 is even
	const next = editor.render(100)[1]!;
	assert.ok(first.includes(sgrOf("success") + "●"), "lit half");
	assert.ok(next.includes(sgrOf("dim") + "●"), "dim half");
	DREAMWALKER.features.statusChip = false;
	try {
		assert.equal(plain(makeEditor().render(100)[1]!).trim(), "", "switchable");
	} finally {
		DREAMWALKER.features.statusChip = true;
	}
});

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────

test("extension: pi's events drive the signal (start, tool results, abort), and quitting resets it", async () => {
	const { default: dreamwalker } = await import("../extensions/index.ts");
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
	const pi = {
		on: (name: string, fn: (event: unknown, ctx?: unknown) => void) => void handlers.set(name, fn),
		registerCommand() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
	};
	dreamwalker(pi as never);
	const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event);
	fire("agent_start");
	assert.equal(signal.phase, "running");
	fire("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
	assert.equal(signal.currentCall, "c1");
	for (let i = 0; i < 3; i++) fire("tool_result", { toolName: "bash", input: { command: `x${i}` }, isError: true });
	assert.equal(signal.phase, "risk");
	fire("agent_end", { messages: [{ role: "user" }, { role: "assistant", stopReason: "aborted" }, { role: "toolResult" }] });
	assert.equal(signal.phase, "paused", "the last assistant message decides, not the last message");
	fire("session_shutdown", { reason: "quit" });
	assert.equal(signal.phase, "idle");
});
