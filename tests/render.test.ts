import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
// The theme proxy is not exported from the package root; the dist file is the same module instance.
import {
	getEditorTheme,
	theme as piTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { type AssistantLike, Chronicle } from "../extensions/chronicle.ts";
import { DreamEditor } from "../extensions/editor.ts";
import { DreamFooter, type FooterSource, sumSessionUsage } from "../extensions/footer.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";
import { createToolRenderers, ToolFrame, toolStatus, toolTarget, toolVerb } from "../extensions/tools.ts";

const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g;
const plain = (line: string) => line.replace(ANSI, "");
const theme = () => piTheme as Theme;
const chronicle = new Chronicle();

before(() => {
	initTheme("dark");
	installMessageChrome({ theme, chronicle, notify: () => {}, showRunStats: true });
});
after(() => uninstallMessageChrome());

type Loose = AssistantLike & Record<string, unknown>;
const finalMessage = (timestamp: number): Loose => ({
	role: "assistant",
	content: [{ type: "text", text: "Done. All good." }],
	timestamp,
	durationMs: 2_000,
	stopReason: "stop",
	model: "devin/swe-2",
	provider: "magpie",
	api: "openai-completions",
	usage: { input: 1000, output: 120, cacheRead: 3000, cacheWrite: 0, cost: { total: 0.0123 } },
} as unknown as Loose);

test("user message: bar before every row, indented body, no header, no background block", () => {
	chronicle.reindex([{ type: "message", message: { role: "user", content: "hello world", timestamp: Date.UTC(2026, 0, 1, 9, 5) } as never }]);
	const lines = new UserMessageComponent("hello world", getMarkdownTheme(), 1).render(60);
	const text = lines.map(plain);
	assert.deepEqual(text.map((line) => line.trimEnd()), [" ▎ hello world"]);
	assert.ok(!lines.some((line) => /\x1b\[48/.test(line)), "no background color");
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);

	const multi = new UserMessageComponent("one\n\ntwo", getMarkdownTheme(), 1).render(60).map(plain);
	assert.deepEqual(multi.map((line) => line.trimEnd()), [" ▎ one", " ▎", " ▎ two"], "the bar runs through blank rows");
});

test("assistant: mark on the first row, final stats line", () => {
	const message = finalMessage(5_000);
	chronicle.reindex([
		{ type: "message", message: { role: "user", content: "go", timestamp: 1_000 } as never },
		{ type: "message", message: message as never },
	]);
	const component = new AssistantMessageComponent(message as never, false, getMarkdownTheme(), "Thinking…", 1);
	const text = component.render(80).map(plain);
	assert.ok(!text.some((line) => line.includes("devin/swe-2")), "no model header");
	assert.equal(text.filter((line) => line.includes("▲")).length, 1);
	assert.ok(text.some((line) => line.trimEnd() === " ▲ Done. All good."), JSON.stringify(text));
	const stats = text.find((line) => line.includes("●"));
	assert.ok(stats, "stats line");
	assert.match(stats, /● 6s · \$0\.012 · 4\.0k in · 120 out · ⛁ 75% cached · 60 tok\/s/);
	assert.match(stats, /⧉ copy\s*$/);
	for (const line of component.render(80)) assert.ok(visibleWidth(line) <= 80);
});

test("assistant message in the middle of a run has no stats", () => {
	const step = {
		...finalMessage(7_000),
		content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: "t", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as unknown as Loose;
	chronicle.reindex([
		{ type: "message", message: { role: "user", content: "go", timestamp: 6_000 } as never },
		{ type: "message", message: { ...step, timestamp: 6_500 } as never },
		{ type: "message", message: step as never },
	]);
	const text = new AssistantMessageComponent(step as never, false, getMarkdownTheme(), "Thinking…", 1)
		.render(80)
		.map(plain);
	assert.ok(!text.some((line) => line.includes("●")));
	assert.ok(text.some((line) => line.startsWith(" ▲ Looking.")));
});

test("finished thinking is shown in full, with no fold row; ctrl+o has nothing to open", () => {
	const thinking = Array.from({ length: 12 }, (_, i) => `thought ${i}`).join("\n\n");
	const message = {
		...finalMessage(9_000),
		content: [{ type: "thinking", thinking }, { type: "text", text: "Answer." }],
	} as unknown as Loose;
	chronicle.reindex([]);
	const component = new AssistantMessageComponent(message as never, false, getMarkdownTheme(), "Thinking…", 1);
	const text = component.render(60).map(plain);
	assert.ok(text.some((line) => line.trim() === "thought 0"));
	assert.ok(text.some((line) => line.trim() === "thought 11"));
	assert.ok(!text.some((line) => /more lines/.test(line)));
	assert.ok(text.some((line) => line.trim() === "▲ Answer."), "the mark sits on the answer, not on the thinking");
	assert.ok(!("setExpanded" in component), "no expand hook");
});

test("uninstall restores pi's own rendering", () => {
	uninstallMessageChrome();
	const text = new UserMessageComponent("plain", getMarkdownTheme(), 1).render(40).map(plain);
	assert.ok(!text.some((line) => line.includes("▎")));
	installMessageChrome({ theme, chronicle, notify: () => {}, showRunStats: true });
});

const fakeTui = { terminal: { rows: 40, columns: 80 }, requestRender() {} } as unknown as TUI;
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

const labels = { provider: "magpie", model: "devin/swe-2", thinking: "high" };

test("editor: status row, rounded card, prompt, exact width", () => {
	const editor = new DreamEditor(fakeTui, getEditorTheme(), keybindings, theme, () => labels, 0);
	editor.focused = true;
	editor.setText("hello");
	for (const width of [80, 30]) {
		const lines = editor.render(width);
		const text = lines.map(plain);
		assert.match(text[0] ?? "", /^ ─+$/, "a hairline above the status row");
		assert.match(text[1] ?? "", /magpie\/devin\/swe-2 \(High\) $/, "model and level on the right of the status row");
		assert.match(text[2] ?? "", /^╭─+╮$/);
		assert.match(text[3] ?? "", /^│ › hello\s+│$/);
		assert.ok(text.at(-1)?.startsWith("╰") && text.at(-1)?.endsWith("╯"));
		assert.equal(lines.length, 5, "rule, status row, top, one input row, bottom");
		for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(plain(line)));
		for (const line of lines.slice(2)) assert.equal(visibleWidth(line), width, JSON.stringify(plain(line)));
	}
});

test("editor: no thinking level, no model: the status row stays within width", () => {
	const plainModel = new DreamEditor(fakeTui, getEditorTheme(), keybindings, theme, () => ({ model: "m1", thinking: "off" }), 0);
	assert.match(plain(plainModel.render(60)[1] ?? ""), /m1 $/);
	const bare = new DreamEditor(fakeTui, getEditorTheme(), keybindings, theme, () => ({}), 0);
	assert.equal(plain(bare.render(60)[1] ?? "").trim(), "");
	assert.ok(visibleWidth(plainModel.render(12)[1] ?? "") <= 12);
});

test("editor: empty input has no placeholder, no mode badge", () => {
	const editor = new DreamEditor(fakeTui, getEditorTheme(), keybindings, theme, () => ({}), 0);
	editor.focused = true;
	const text = editor.render(80).map(plain);
	assert.equal(text.length, 5);
	assert.match(text[3] ?? "", /^│ › {2}\s+│$/);
	assert.ok(!text.some((line) => /AGENT|BASH|STEER|Ask anything/.test(line)));
});

test("editor: multi-line content keeps the frame aligned", () => {
	const editor = new DreamEditor(fakeTui, getEditorTheme(), keybindings, theme, () => ({}), 0);
	editor.setText("one\ntwo\nthree");
	const text = editor.render(40).map(plain);
	assert.equal(text.length, 7);
	assert.match(text[4] ?? "", /^│ {3}two\s+│$/);
	for (const line of text.slice(2)) assert.equal(visibleWidth(line), 40);
	assert.ok(text.every((line, i) => i < 3 || i === text.length - 1 || line.startsWith("│")));
});

const footerData = (branch: string | null, statuses: Map<string, string>) =>
	({
		getGitBranch: () => branch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	}) as unknown as ReadonlyFooterDataProvider;

test("footer: place left, context and spend right, single line within width", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, cost: { total: 0.17 } } } },
		{ type: "message", message: { role: "user" } },
	];
	assert.deepEqual(sumSessionUsage(entries), { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, cost: 0.17 });
	let entryReads = 0;
	const source: FooterSource = {
		sessionKey: () => "s|leaf",
		entries: () => {
			entryReads++;
			return entries;
		},
		sessionName: () => undefined,
		cwd: () => `${process.env.HOME}/repo`,
		context: () => ({ tokens: 12_000, contextWindow: 200_000, percent: 6 }),
	};
	const footer = new DreamFooter(theme, footerData("main", new Map([["fast", "⚡ fast"]])), () => source, () => {});
	const [line] = footer.render(120);
	assert.ok(line);
	assert.equal(visibleWidth(line), 120);
	assert.match(plain(line), /^ ~\/repo ⎇ main · ⚡ fast\s+6% \/ 200k · 4\.0k in · 200 out · 75% cached · \$0\.17 $/);
	footer.render(120);
	footer.render(60);
	assert.equal(entryReads, 1, "totals are cached per session key");
	assert.ok(visibleWidth(footer.render(30)[0] ?? "") <= 30);
});

test("footer: the cached line follows status, branch, name, width and session changes", () => {
	const statuses = new Map([["a", "one"]]);
	let branch: string | null = "main";
	let name: string | undefined;
	let key = "s|1";
	const entries = [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }];
	const data = { getGitBranch: () => branch, getExtensionStatuses: () => statuses, onBranchChange: () => () => {} } as unknown as ReadonlyFooterDataProvider;
	const source: FooterSource = { sessionKey: () => key, entries: () => entries, sessionName: () => name, cwd: () => "/repo" };
	const footer = new DreamFooter(theme, data, () => source, () => {});
	const line = () => plain(footer.render(100)[0] ?? "");
	const first = footer.render(100);
	assert.equal(footer.render(100), first, "unchanged inputs reuse the line");
	assert.match(line(), /\/repo ⎇ main · one\s+10 in · 5 out $/);
	statuses.set("a", "two");
	assert.match(line(), / two\s/);
	statuses.set("b", "three");
	assert.match(line(), / two · three\s/);
	branch = "dev";
	assert.match(line(), /⎇ dev/);
	branch = null;
	assert.match(line(), /^ \/repo · two/);
	name = "my session";
	assert.match(line(), /my session/);
	entries.push({ type: "message", message: { role: "assistant", usage: { input: 90, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	key = "s|2";
	assert.match(line(), /100 in · 10 out $/);
	assert.equal(visibleWidth(footer.render(40)[0] ?? ""), 40);
});

test("tool rows: verb, target, summary line, caching", () => {
	assert.equal(toolStatus({ isPartial: true, isError: false, executionStarted: false }), "pending");
	assert.equal(toolStatus({ isPartial: true, isError: false, executionStarted: true }), "running");
	assert.equal(toolStatus({ isPartial: false, isError: false, executionStarted: true }), "done");
	assert.equal(toolStatus({ isPartial: false, isError: true, executionStarted: true }), "error");
	assert.equal(toolVerb("read"), "Read");
	assert.equal(toolVerb("bash"), "Execute");
	assert.equal(toolVerb("web_search"), "Web Search");
	assert.equal(toolVerb("mcp__magpie__web_fetch"), "Web Fetch");
	assert.equal(toolTarget("read", { path: "a.ts", offset: 1 }), "a.ts");
	assert.equal(toolTarget("grep", { pattern: "foo", path: "src" }), '"foo" in src');
	assert.equal(toolTarget("bash", { command: "pnpm test" }), "pnpm test");
	assert.equal(toolTarget("bash", { command: "cat > a <<'EOF'\nbody\nEOF" }), "cat > a <<'EOF' …");
	assert.equal(toolTarget("x", { x: 1 }), '{"x":1}');

	const meta = { toolName: "read", args: { path: "a.ts" } };
	const call = new ToolFrame("call").update(new Text("read a.ts", 0, 0), theme(), "done", 1234, 3, meta);
	const first = call.render(50);
	assert.deepEqual(first.map(plain), ["   Read a.ts", "     ↳ 1.2s"]);
	assert.equal(call.render(50), first, "same input → same cached array");
	const quick = new ToolFrame("call").update(new Text("read a.ts", 0, 0), theme(), "done", 80, 3, meta);
	assert.deepEqual(quick.render(50).map(plain), ["   Read a.ts"], "a quick call stays one row");
	const running = new ToolFrame("call").update(new Text("read a.ts", 0, 0), theme(), "running", undefined, 3, meta);
	assert.deepEqual(running.render(50).map(plain), ["   Read a.ts"]);
	const failed = new ToolFrame("call").update(new Text("read a.ts", 0, 0), theme(), "error", 80, 3, meta);
	assert.deepEqual(failed.render(50).map(plain), ["   Read a.ts", "     ↳ failed"]);
	assert.deepEqual(
		new ToolFrame("call").update(new Text("x", 0, 0), theme(), "done", 1, 3, { toolName: "read", args: { path: "a-long-path.ts" } }).render(10).map(plain),
		["   Read a…"],
		"the row truncates instead of wrapping",
	);

	const result = new ToolFrame("result").update(new Text("line 1\nline 2", 0, 0), theme(), "done", undefined, 3);
	assert.deepEqual(result.render(40).map(plain).map((line) => line.trimEnd()), [` ${"─".repeat(38)}`, "     line 1", "     line 2"], "a hairline parts the output from the call row");

	const padded = new ToolFrame("result").update(new Text("\nout\n\nmore\n", 0, 0), theme(), "done", undefined, 1);
	assert.deepEqual(padded.render(30).map(plain).map((line) => line.trimEnd()), [` ${"─".repeat(28)}`, "   out", "", "   more"]);

	const took = new ToolFrame("result").update(new Text("hi\n\nTook 1.2s", 0, 0), theme(), "done", undefined, 1);
	assert.deepEqual(took.render(30).map(plain).map((line) => line.trimEnd()), [` ${"─".repeat(28)}`, "   hi"], "the duration lives on the summary line");
});

test("tool rows: a call's own rows stay folded until ctrl+o, except a diff", () => {
	const inner = new Text("edit a.ts\n\n+1 added\n-2 gone", 0, 0);
	const meta = { toolName: "edit", args: { path: "a.ts" } };
	const folded = new ToolFrame("call").update(inner, theme(), "done", 5, 1, meta);
	assert.deepEqual(folded.render(40).map(plain).map((line) => line.trimEnd()), [" Edit a.ts"]);
	const open = new ToolFrame("call").update(inner, theme(), "done", 5, 1, { ...meta, expanded: true });
	assert.deepEqual(open.render(40).map(plain).map((line) => line.trimEnd()), [" Edit a.ts", "   +1 added", "   -2 gone"]);
	const diff = new ToolFrame("call", { bodyShown: true }).update(inner, theme(), "done", 5, 1, meta);
	assert.deepEqual(diff.render(40).map(plain).map((line) => line.trimEnd()), [" Edit a.ts", "   +1 added", "   -2 gone"]);
});

test("tool rows: keeps tool renderers, respects self-framed tools", () => {
	const self = { renderShell: "self" as const };
	assert.equal(createToolRenderers("x", self), self);

	const renderers = createToolRenderers("mcp_tool", undefined);
	assert.ok(renderers?.renderCall && renderers.renderResult);
	const context = {
		args: { query: "weather" },
		toolCallId: "1",
		keyText: () => "",
		keyHint: (_keybinding: unknown, description: string) => description,
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: 50,
		outputPad: 1,
	};
	const call = renderers.renderCall({ query: "weather" }, theme(), context);
	assert.deepEqual(call.render(60).map(plain), ["   Mcp Tool weather"]);
	const body = renderers.renderResult(
		{ content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `row ${i}`).join("\n") }], details: undefined },
		{ expanded: false, isPartial: false },
		theme(),
		context,
	);
	const rows = body.render(60).map(plain).map((line) => line.trimEnd());
	assert.equal(rows.length, 8);
	assert.match(rows[0]!, /^ ─+$/);
	assert.equal(rows[1], "     row 0");
	assert.equal(rows[7], "     … 4 more lines");
	// Reuses the frame passed back as lastComponent.
	assert.equal(renderers.renderCall({ query: "weather" }, theme(), { ...context, lastComponent: call }), call);
});
