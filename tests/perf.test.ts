/**
 * Render hot-path guards (see bench/perf.ts for the numbers):
 * - the group spinner tick requests a frame and never re-runs child renderers;
 * - the drip skips rebuilds that would not change the visible text;
 * - hidden thinking is never dripped;
 * - while streaming, earlier blocks keep their rendered Markdown and only the open tail re-renders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { Container, Markdown } from "@earendil-works/pi-tui";
import { Chronicle } from "../extensions/chronicle.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { installToolGrouping } from "../extensions/grouping.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";
import { TOOL_TICK_MS } from "../extensions/spinner.ts";

initTheme("dark");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("group spinner tick requests a frame without re-running child renderers", async () => {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	let frames = 0;
	grouping.setRequestRender(() => frames++);
	const proto = ToolExecutionComponent.prototype as unknown as { updateDisplay(): void };
	const original = proto.updateDisplay;
	let updates = 0;
	try {
		const ui = { requestRender() {} };
		const make = (i: number) =>
			new ToolExecutionComponent("read", `c${i}`, { path: `/tmp/${i}` }, { showImages: false }, withBuiltInRenderers("read", undefined) as never, ui as never, "/tmp");
		const chat = new Container();
		chat.addChild(make(1));
		chat.addChild(make(2));
		chat.addChild(make(3)); // all pending
		assert.equal(chat.children.length, 1);
		proto.updateDisplay = function (this: unknown) {
			updates++;
			return original.call(this);
		};
		chat.render(80); // arms the tick
		await sleep(TOOL_TICK_MS * 2);
		assert.equal(updates, 0, "children are not invalidated by the tick");
		assert.ok(frames >= 1, "the tick requests a frame");
	} finally {
		proto.updateDisplay = original;
		grouping.shutdown();
	}
});

const assistant = (content: unknown[]) =>
	({ role: "assistant", content, timestamp: 1, stopReason: "stop", model: "m" }) as never;

function withDrip(run: (frames: () => number) => Promise<void>) {
	return async () => {
		let frames = 0;
		installMessageChrome({
			theme: () => piTheme as Theme,
			chronicle: new Chronicle(),
			notify() {},
			showRunStats: false,
			smooth: DREAMWALKER.smoothStreaming,
			requestRender: () => (frames++, true),
		});
		try {
			await run(() => frames);
		} finally {
			uninstallMessageChrome();
		}
	};
}

test(
	"drip: a delta that does not move the cursor keeps the rendered components",
	withDrip(async () => {
		const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
		const content = (c as unknown as { contentContainer: Container }).contentContainer;
		const text = "hello world, this is a long streamed answer. ".repeat(40);
		c.updateContent(assistant([{ type: "text", text }]), true);
		await sleep(DREAMWALKER.smoothStreaming.minCommitMs * 2); // partly revealed, backlog left
		const before = [...content.children];
		assert.ok(before.length > 1, "some text is revealed");
		// The first text block sits in the `▲` mark's wrapper.
		const bodyOf = (child: unknown) => (child as { child?: unknown }).child ?? child;
		const markdown = before.map(bodyOf).find((child) => child instanceof Markdown);
		assert.ok(markdown instanceof Markdown);
		const rendered = markdown.render(120);
		c.updateContent(assistant([{ type: "text", text: `${text} more` }]), true);
		assert.deepEqual(content.children, before, "no rebuild while the reveal cursor is unchanged");
		assert.equal(markdown.render(120), rendered, "the unchanged delta keeps the render cache");
		// Pi 1.5 reuses Markdown instances; invalidation must still refresh their cached lines.
		c.invalidate();
		assert.ok(content.children.map(bodyOf).includes(markdown), "the Markdown instance survives the replay");
		const refreshed = markdown.render(120);
		assert.notEqual(refreshed, rendered, "invalidation drops the rendered-line cache");
		assert.deepEqual(refreshed, rendered, "the replay preserves the revealed text");
		c.updateContent(assistant([{ type: "text", text: "done" }]), false);
	}),
);

test(
	"drip: hidden thinking renders at once and requests no frames",
	withDrip(async (frames) => {
		const c = new AssistantMessageComponent(undefined, true, getMarkdownTheme());
		c.updateContent(assistant([{ type: "thinking", thinking: "a long chain of thought ".repeat(20) }]), true);
		await sleep(DREAMWALKER.smoothStreaming.tickMs * 3);
		assert.equal(frames(), 0);
		c.updateContent(assistant([{ type: "thinking", thinking: "done" }]), false);
	}),
);

test("stream render: earlier blocks keep their Markdown, the growing block re-renders only its tail", () => {
	installMessageChrome({
		theme: () => piTheme as Theme,
		chronicle: new Chronicle(),
		notify() {},
		showRunStats: false,
		streamRender: true,
	});
	try {
		const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
		const internals = c as unknown as {
			contentContainer: Container;
			__dreamwalkerStream?: { markdown?: { frozenRaw: string } };
		};
		const thinking = "plan the answer. ".repeat(50);
		let text = "A finished paragraph with **bold** text.\n\n".repeat(40);
		const update = () => c.updateContent(assistant([{ type: "thinking", thinking }, { type: "text", text }]), true);
		const innerOf = (child: unknown) => (child as { child?: unknown }).child ?? child;
		update();
		c.render(120);
		const first = internals.contentContainer.children.map(innerOf);
		text += "tail words";
		update();
		c.render(120);
		const second = internals.contentContainer.children.map(innerOf);
		const thinkingMd = first.find((child) => (child as { text?: string }).text === thinking.trim());
		assert.ok(thinkingMd && second.includes(thinkingMd), "the thinking Markdown survives the rebuild");
		const stream = internals.__dreamwalkerStream?.markdown;
		assert.ok(stream && second.includes(stream as never), "the growing block is the persistent StreamMarkdown");
		assert.ok(stream.frozenRaw.length > text.length * 0.9, `frozen ${stream.frozenRaw.length}/${text.length}`);
		c.updateContent(assistant([{ type: "text", text }]), false);
		assert.equal(internals.__dreamwalkerStream, undefined, "the final build is pi's own");
	} finally {
		uninstallMessageChrome();
	}
});
