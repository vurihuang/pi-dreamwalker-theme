/**
 * Group card behavior against the real pi components: consecutive groupable tools fold into one
 * card, the card lists each tool on a `↳` row, ctrl+o (`setExpanded`) expands it back into the
 * children's own components, and a singleton never groups.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	initTheme,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { Container } from "@earendil-works/pi-tui";
import { installToolGrouping, ToolGroupComponent } from "../extensions/grouping.ts";
import { DREAMWALKER } from "../extensions/config.ts";

initTheme("dark");

const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07/g;
const WIDTH = 100;
const ui = { requestRender() {} };

const plain = (lines: string[]) =>
	lines.map((l) => l.replace(ANSI, "").replace(/\s+$/, ""));

function tool(name: string, args: Record<string, unknown>, result?: string, isError = false): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		name,
		`call-${Math.random()}`,
		args,
		{ showImages: false, outputPad: 1 },
		withBuiltInRenderers(name, undefined) as never,
		ui as never,
		"/tmp",
	);
	if (result !== undefined) {
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: result }], isError } as never, false);
	}
	return component;
}

test("consecutive reads fold into one group card with a row per child", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "2"));
		chat.addChild(tool("read", { path: "/tmp/c.ts" }, "3"));

		assert.equal(chat.children.length, 1, "three reads fold into a single group");
		const group = chat.children[0]!;
		assert.ok(group instanceof ToolGroupComponent);
		assert.equal((group as ToolGroupComponent).children.length, 3);

		const lines = plain((group as ToolGroupComponent).render(WIDTH));
		const text = lines.join("\n");
		assert.match(text, /Read ×3/, "header shows count");
		assert.ok(lines.some((l) => l.includes("a.ts")), "child a listed");
		assert.ok(lines.some((l) => l.includes("c.ts")), "child c listed");
		assert.equal(lines.filter((l) => l.startsWith("  ↳ ")).length, 3, "a `↳` row per child");
	} finally {
		grouping.shutdown();
	}
});

test("runs under three never group; non-groupable tools break the run", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
		chat.addChild(tool("write", { path: "/tmp/w.ts", content: "x" }, "w")); // NON_GROUPABLE
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "2"));
		chat.addChild(tool("read", { path: "/tmp/c.ts" }, "3"));
		assert.equal(chat.children.length, 4, "two reads after the write stay two cards");
		assert.ok(!chat.children.some((c) => c instanceof ToolGroupComponent));

		chat.addChild(tool("grep", { pattern: "x" }, "4"));
		// read→write breaks the run; the third tool after it folds the run.
		const groups = chat.children.filter((c) => c instanceof ToolGroupComponent);
		assert.equal(groups.length, 1);
		assert.equal((groups[0] as ToolGroupComponent).children.length, 3);
		assert.equal(chat.children.length, 3, "read, write, group");
		chat.addChild(tool("ls", { path: "/tmp" }, "5"));
		assert.equal((groups[0] as ToolGroupComponent).children.length, 4, "later tools join the group");
		assert.equal(chat.children.length, 3);
	} finally {
		grouping.shutdown();
	}
});

test("setExpanded expands the group into the children's own components", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "line a\nline a2\nline a3"));
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "line b\nline b2\nline b3"));
		chat.addChild(tool("read", { path: "/tmp/c.ts" }, "line c\nline c2\nline c3"));
		const group = chat.children[0] as ToolGroupComponent;

		const collapsed = plain(group.render(WIDTH)).filter((l) => l.trim());
		const expanded = plain((group.setExpanded(true), group.render(WIDTH))).filter((l) => l.trim());
		// Expanded shows each child's own rendered card (path line), so it's taller than collapsed.
		assert.ok(expanded.length > collapsed.length, "expanded taller than collapsed");
		assert.ok(
			(group.children as ToolExecutionComponent[]).every((t) => (t as unknown as { expanded: boolean }).expanded),
			"children inherit expanded state",
		);
		group.setExpanded(false);
		assert.equal(group.render(WIDTH).length > 0, true);
	} finally {
		grouping.shutdown();
	}
});

test("disabled patch is a pass-through (no grouping)", () => {
	const grouping = installToolGrouping({ enabled: false });
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "2"));
		assert.equal(chat.children.length, 2);
		assert.ok(!chat.children.some((c) => c instanceof ToolGroupComponent));
	} finally {
		grouping.shutdown();
	}
});

test("shutdown ungroups existing cards and restores the Container prototype", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	const chat = new Container();
	chat.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
	chat.addChild(tool("read", { path: "/tmp/b.ts" }, "2"));
	chat.addChild(tool("read", { path: "/tmp/c.ts" }, "3"));
	assert.ok(chat.children[0] instanceof ToolGroupComponent);
	grouping.shutdown();
	assert.equal(chat.children.length, 3, "shutdown restores the tools");
	assert.ok(!chat.children.some((c) => c instanceof ToolGroupComponent));
	// After shutdown, new adds are not grouped.
	chat.addChild(tool("read", { path: "/tmp/d.ts" }, "4"));
	assert.equal(chat.children.length, 4);
});

test("a tool with streamed partial output is still running, not done", () => {
	let streamingRef: ToolExecutionComponent | undefined;
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "a"));
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "b"));
		const streaming = tool("grep", { pattern: "x" });
		streamingRef = streaming;
		streaming.markExecutionStarted();
		// A tool streaming through onUpdate: pi stores its output as a *partial* result.
		streaming.updateResult({ content: [{ type: "text", text: "partial" }], isError: false } as never, true);
		chat.addChild(streaming);

		const group = chat.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		const text = plain(group.render(WIDTH)).join("\n");
		assert.match(text, /1 running/, "partial result counts as running");
		assert.equal(text.split("\n").filter((l) => l.startsWith("  ↳ ")).length, 2, "two settled rows; the running one has a spinner");

		streaming.updateResult({ content: [{ type: "text", text: "final" }], isError: false } as never, false);
		const settled = plain(group.render(WIDTH)).join("\n");
		assert.doesNotMatch(settled, /running/, "final result settles it");
		assert.equal(settled.split("\n").filter((l) => l.startsWith("  ↳ ")).length, 3);
	} finally {
		// A partial result may arm pi's elapsed-time interval; settle it so node can exit.
		streamingRef?.updateResult({ content: [], isError: false } as never, false);
		grouping.shutdown();
	}
});

test("bash never groups: its output is the point", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		for (const cmd of ["git status", "git diff", "ls"]) chat.addChild(tool("bash", { command: cmd }, "ok"));
		assert.equal(chat.children.length, 3);
		assert.ok(!chat.children.some((c) => c instanceof ToolGroupComponent));
	} finally {
		grouping.shutdown();
	}
});

test("one-type rows drop the repeated name; mixed rows keep it; a failure shows its first line", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
		chat.addChild(tool("read", { path: "/tmp/missing.ts" }, "\nENOENT: no such file\nstack…", true));
		chat.addChild(tool("read", { path: "/tmp/c.ts" }, "3"));
		const same = plain((chat.children[0] as ToolGroupComponent).render(WIDTH));
		assert.match(same[1] ?? "", /^Read ×3 · 1 failed · ctrl\+o$/);
		assert.match(same[2] ?? "", /^ {2}↳ \/tmp\/a\.ts$/, "no repeated `read`");
		assert.match(same[3] ?? "", /^ {2}↳ \/tmp\/missing\.ts$/);
		assert.match(same[4] ?? "", /^ {4}ENOENT: no such file$/, "error line under the failed row");
		assert.ok(!same.some((l) => l.includes("stack")), "only the first error line");
		assert.match(same[5] ?? "", /^ {2}↳ \/tmp\/c\.ts$/);

		const mixed = new Container();
		mixed.addChild(tool("read", { path: "/tmp/a.ts" }, "1"));
		mixed.addChild(tool("grep", { pattern: "x" }, "2"));
		mixed.addChild(tool("ls", { path: "/tmp" }, "3"));
		const rows = plain((mixed.children[0] as ToolGroupComponent).render(WIDTH));
		assert.match(rows[1] ?? "", /^Tools ×3 · read, grep, ls · ctrl\+o$/);
		assert.match(rows[2] ?? "", /^ {2}↳ read \/tmp\/a\.ts$/);
		assert.match(rows[3] ?? "", /^ {2}↳ grep "x"$/);
	} finally {
		grouping.shutdown();
	}
});

test("render caches: settled rows survive a running sibling, expanded output tracks its children, durations freeze", () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	const realNow = Date.now;
	try {
		const chat = new Container();
		chat.addChild(tool("read", { path: "/tmp/a.ts" }, "a"));
		chat.addChild(tool("read", { path: "/tmp/b.ts" }, "b"));
		const running = tool("read", { path: "/tmp/c.ts" });
		running.markExecutionStarted();
		chat.addChild(running);
		const group = chat.children[0] as ToolGroupComponent;

		const first = group.render(WIDTH);
		const second = group.render(WIDTH);
		assert.notEqual(first, second, "a running group is redrawn each frame");
		assert.equal(first[2], second[2], "settled rows are reused");

		running.updateResult({ content: [{ type: "text", text: "c" }], isError: false } as never, false);
		const settled = plain(group.render(WIDTH));
		assert.doesNotMatch(settled[1] ?? "", /running/);
		assert.equal(settled.filter((l) => l.startsWith("  ↳ ")).length, 3);

		// A later cache miss (resize) must not recompute durations against the new clock.
		Date.now = () => realNow() + 3_600_000;
		const resized = plain(group.render(WIDTH - 10));
		assert.ok(!resized.some((l) => /\d+m|\d+h/.test(l)), resized.join("\n"));
		Date.now = realNow;

		group.setExpanded(true);
		const open1 = group.render(WIDTH);
		assert.equal(group.render(WIDTH), open1, "unchanged expanded group reuses its output");
		const child = group.children[0] as ToolExecutionComponent;
		child.updateResult({ content: [{ type: "text", text: "a changed\nsecond line" }], isError: false } as never, false);
		const open2 = group.render(WIDTH);
		assert.notEqual(open2, open1);
		assert.ok(plain(open2).some((l) => l.includes("a changed")), "a child change shows up");
	} finally {
		Date.now = realNow;
		grouping.shutdown();
	}
});
