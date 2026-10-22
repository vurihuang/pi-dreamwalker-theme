/**
 * TUI hot-path reproduction. Run: `node bench/perf.ts`
 *
 * 1. group spinner tick: a running tool group re-ran every child's renderers every 80 ms.
 * 2. drip on provider deltas: a delta that does not move the reveal cursor still rebuilt the
 *    message, so the next frame re-parsed the whole Markdown.
 * 3. drip on hidden thinking: ~30 fps rebuild + frame requests for a static "Thinking..." label.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { Container, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DreamEditor } from "../extensions/editor.ts";
import { DreamFooter } from "../extensions/footer.ts";
import { Chronicle } from "../extensions/chronicle.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { installToolGrouping } from "../extensions/grouping.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";
import { disposeHighlightSessions, highlighterReady } from "../extensions/highlight.ts";
import { createToolRenderers } from "../extensions/tools.ts";

initTheme("dark");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDTH = 120;

// Count tool renderer runs: ToolExecutionComponent.updateDisplay runs renderCall + renderResult.
const proto = ToolExecutionComponent.prototype as unknown as { updateDisplay(): void };
const originalUpdate = proto.updateDisplay;
let updateDisplays = 0;
let updateMs = 0;
proto.updateDisplay = function (this: unknown) {
	updateDisplays++;
	const t = performance.now();
	try {
		return originalUpdate.call(this);
	} finally {
		updateMs += performance.now() - t;
	}
};

async function groupTick(expanded: boolean) {
	const grouping = installToolGrouping({ enabled: true });
	grouping.setTheme(piTheme as Theme);
	let frames = 0;
	grouping.setRequestRender?.(() => frames++);
	const ui = { requestRender() {} };
	const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
	const make = (i: number, done: boolean) => {
		const def = createToolRenderers("read", withBuiltInRenderers("read", undefined) as never);
		const c = new ToolExecutionComponent("read", `c${i}`, { path: `/tmp/${i}.ts` }, { showImages: false, outputPad: 1 }, { name: "read", ...def } as never, ui as never, "/tmp");
		c.setArgsComplete();
		c.markExecutionStarted();
		if (done) c.updateResult({ content: [{ type: "text", text: big }], isError: false } as never, false);
		return c;
	};
	const chat = new Container();
	for (let i = 0; i < 8; i++) chat.addChild(make(i, i < 7)); // 7 settled + 1 running
	if (expanded) (chat.children[0] as unknown as { setExpanded(e: boolean): void }).setExpanded(true);
	// Warm up: measure steady-state frames, not JIT compilation.
	for (let i = 0; i < 200; i++) chat.render(WIDTH);
	updateDisplays = 0;
	updateMs = 0;
	const t0 = performance.now();
	let renderMs = 0;
	const end = t0 + 1000;
	while (performance.now() < end) {
		const r = performance.now();
		chat.render(WIDTH);
		renderMs += performance.now() - r;
		await sleep(16);
	}
	console.log(`[group tick]   ${expanded ? "expanded " : "collapsed"} 1s running group (8 reads, 4k-line outputs): child updateDisplay=${updateDisplays} (${updateMs.toFixed(1)}ms), render CPU=${renderMs.toFixed(1)}ms, frames requested by tick=${frames}`);
	grouping.shutdown();
}

function assistant(content: unknown[]) {
	return { role: "assistant", content, timestamp: 1, stopReason: "stop", model: "m", usage: undefined } as never;
}

/** `defaults`: the shipped config (streamRender + fade); otherwise pi's own Markdown per paint. */
async function dripDeltas(defaults: boolean) {
	let frames = 0;
	installMessageChrome({
		theme: () => piTheme as Theme,
		chronicle: new Chronicle(),
		notify() {},
		showRunStats: false,
		smooth: DREAMWALKER.smoothStreaming,
		streamRender: defaults,
		fade: defaults ? DREAMWALKER.streamFade : undefined,
		requestRender: () => (frames++, true),
	});
	const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
	const paragraph = "Some **markdown** text with `code` and words, ".repeat(6) + "\n\n```ts\nconst x = 1;\nfunction f() { return x; }\n```\n\n";
	let text = paragraph.repeat(60); // ~25 KB already streamed
	c.updateContent(assistant([{ type: "text", text }]), true);
	await sleep(400); // let the drip catch up
	c.render(WIDTH);
	// Provider sends many tiny deltas per frame (common with fast models).
	let renderMs = 0;
	const t0 = performance.now();
	for (let f = 0; f < 60; f++) {
		for (let d = 0; d < 5; d++) {
			text += "tok ";
			c.updateContent(assistant([{ type: "text", text }]), true);
		}
		const r = performance.now();
		c.render(WIDTH);
		renderMs += performance.now() - r;
		await sleep(16);
	}
	console.log(`[drip deltas]  60 frames x 5 deltas on a 25 KB message (${defaults ? "default: streamRender + fade" : "streamRender off"}): render CPU=${renderMs.toFixed(1)}ms (wall ${(performance.now() - t0).toFixed(0)}ms)`);
	c.updateContent(assistant([{ type: "text", text }]), false);
	uninstallMessageChrome();
}

async function dripHiddenThinking() {
	let frames = 0;
	installMessageChrome({
		theme: () => piTheme as Theme,
		chronicle: new Chronicle(),
		notify() {},
		showRunStats: false,
		smooth: DREAMWALKER.smoothStreaming,
		requestRender: () => (frames++, true),
	});
	const c = new AssistantMessageComponent(undefined, true /* hide thinking */, getMarkdownTheme());
	let thinking = "";
	for (let i = 0; i < 20; i++) {
		thinking += "reasoning about the problem in depth. ".repeat(10);
		c.updateContent(assistant([{ type: "thinking", thinking }]), true);
		await sleep(50);
	}
	await sleep(300);
	console.log(`[drip hidden]  1.3s of hidden thinking: drip frame requests=${frames} (output never changes)`);
	c.updateContent(assistant([{ type: "thinking", thinking }]), false);
	uninstallMessageChrome();
}

function chrome() {
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} } as unknown as TUI;
	const editor = new DreamEditor(tui, getEditorTheme(), { matches: () => false } as unknown as KeybindingsManager, () => piTheme as Theme, () => ({ provider: "p", model: "m", thinking: "high" }), 0);
	editor.setText("hello\nworld");
	const data = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(Array.from({ length: 6 }, (_, i) => [`s${i}`, `status ${i}`])), onBranchChange: () => () => {} } as unknown as ReadonlyFooterDataProvider;
	const entries = Array.from({ length: 2000 }, () => ({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, cost: { total: 0.001 } } } }));
	const footer = new DreamFooter(() => piTheme as Theme, data, () => ({ cwd: () => "/tmp/x", sessionKey: () => "k", entries: () => entries, sessionName: () => "n" }), () => {});
	const N = 2000;
	// Warm up: measure steady-state frames, not JIT compilation.
	for (let i = 0; i < N; i++) {
		editor.render(WIDTH);
		footer.render(WIDTH);
	}
	let t = performance.now();
	for (let i = 0; i < N; i++) editor.render(WIDTH);
	const e = (performance.now() - t) / N;
	t = performance.now();
	for (let i = 0; i < N; i++) footer.render(WIDTH);
	const f = (performance.now() - t) / N;
	console.log(`[chrome]       per frame: editor ${(e * 1000).toFixed(0)}µs, footer ${(f * 1000).toFixed(0)}µs`);
}

await groupTick(false);
await groupTick(true);
await dripDeltas(false);
await dripDeltas(true);
await dripHiddenThinking();

/** Per-paint cost while a long answer streams: pi rebuilds the message on every reveal. */
function streamRender(kb: number, incremental: boolean) {
	installMessageChrome({
		theme: () => piTheme as Theme,
		chronicle: new Chronicle(),
		notify() {},
		showRunStats: false,
		streamRender: incremental,
	});
	const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
	const unit =
		"中文段落，包含 **加粗**、`code` 和 [链接](https://x.y)。The quick brown fox jumps over the lazy dog. ".repeat(3) +
		"\n\n- item a\n- item b\n\n```ts\nconst x = 1;\n```\n\n";
	let text = "";
	while (text.length < kb * 1024) text += unit;
	const thinking = "planning the answer step by step. ".repeat(60);
	const paint = (t: string) => {
		c.updateContent(assistant([{ type: "thinking", thinking }, { type: "text", text: t }]), true);
		c.render(WIDTH);
	};
	paint(text);
	const N = 120;
	const t0 = performance.now();
	for (let i = 0; i < N; i++) paint(`${text}${"word ".repeat(i)}`);
	const ms = (performance.now() - t0) / N;
	c.updateContent(assistant([{ type: "text", text }]), false);
	uninstallMessageChrome();
	return ms;
}

for (const kb of [2, 8, 32]) {
	const off = streamRender(kb, false);
	const on = streamRender(kb, true);
	console.log(`[stream paint] ${String(kb).padStart(2)} KB answer + thinking: rebuild+render per paint ${off.toFixed(2)} ms → ${on.toFixed(2)} ms (streamRender)`);
}

// --- Fast highlighting (features.fastHighlight) -------------------------------------------------

await highlighterReady;
const features = DREAMWALKER.features as { fastHighlight: boolean };
const SOURCE = readFileSync(new URL("../node_modules/typescript/lib/typescript.js", import.meta.url), "utf8");
const withFast = <T>(on: boolean, fn: () => T): T => {
	features.fastHighlight = on;
	try {
		return fn();
	} finally {
		features.fastHighlight = true;
		disposeHighlightSessions();
	}
};

/**
 * An answer whose open ```ts block grows by 40 chars per paint. With fade, the clock advances 33 ms
 * per paint (the drip's cadence), so only the last few paints' chars are still fading, as on screen.
 */
function codeStream(kb: number, fast: boolean, fade = false) {
	const realNow = Date.now;
	let clock = realNow();
	if (fade) Date.now = () => clock;
	try {
		return codeStreamPaints(kb, fast, fade, () => (clock += 33));
	} finally {
		Date.now = realNow;
	}
}

function codeStreamPaints(kb: number, fast: boolean, fade: boolean, tick: () => void) {
	return withFast(fast, () => {
		installMessageChrome({ theme: () => piTheme as Theme, chronicle: new Chronicle(), notify() {}, showRunStats: false, streamRender: true, smooth: fade ? DREAMWALKER.smoothStreaming : undefined, fade: fade ? DREAMWALKER.streamFade : undefined });
		const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
		const code = SOURCE.slice(0, kb * 1024 + 120 * 40);
		const paint = (n: number) => {
			tick();
			c.updateContent(assistant([{ type: "text", text: `Here:\n\n\`\`\`ts\n${code.slice(0, n)}` }]), true);
			c.render(WIDTH);
		};
		paint(kb * 1024);
		const N = 120;
		const t0 = performance.now();
		for (let i = 1; i <= N; i++) paint(kb * 1024 + i * 40);
		const ms = (performance.now() - t0) / N;
		uninstallMessageChrome();
		return ms;
	});
}
for (const kb of [4, 16, 64]) {
	console.log(`[code stream]  open \`\`\`ts block at ${String(kb).padStart(2)} KB, per paint (line-by-line tail): pi highlighter ${codeStream(kb, false).toFixed(2)} ms → fast ${codeStream(kb, true).toFixed(2)} ms (with fade ${codeStream(kb, true, true).toFixed(2)} ms)`);
}

/** A bash heredoc whose args stream in 40-char deltas; highlighted live with the fast path. */
function bashStream(kb: number, fast: boolean) {
	return withFast(fast, () => {
		const def = withBuiltInRenderers("bash", undefined) as never as Record<string, unknown>;
		const renderers = { ...def, ...createToolRenderers("bash", def as never) };
		const c = new ToolExecutionComponent("bash", "b", { command: "" }, { showImages: false, outputPad: 1 }, renderers as never, { requestRender() {} } as never, "/tmp");
		const command = `cat > a.ts <<'EOF'\n${SOURCE.slice(0, kb * 1024)}\nEOF`;
		const t0 = performance.now();
		for (let i = 40; i < command.length; i += 40) {
			c.updateArgs({ command: command.slice(0, i) });
			c.render(WIDTH);
		}
		c.updateArgs({ command });
		c.setArgsComplete();
		c.render(WIDTH);
		return performance.now() - t0;
	});
}
for (const kb of [4, 16]) {
	console.log(`[bash stream]  ${String(kb).padStart(2)} KB heredoc in 40-char deltas, total CPU: pi (plain until complete) ${bashStream(kb, false).toFixed(0)} ms → fast (live highlight) ${bashStream(kb, true).toFixed(0)} ms`);
}

/** Expanding a read result: pi highlights the whole file on each render of a new result. */
function readExpand(kb: number, fast: boolean) {
	return withFast(fast, () => {
		const def = withBuiltInRenderers("read", undefined) as never as Record<string, unknown>;
		const renderers = { ...def, ...createToolRenderers("read", def as never) } as unknown as { renderResult: Function };
		const content = SOURCE.slice(0, kb * 1024);
		const N = 20;
		const t0 = performance.now();
		for (let i = 0; i < N; i++) {
			const result = { content: [{ type: "text", text: `${content}// ${i}` }] };
			const context = { args: { path: "a.ts" }, isError: false, isPartial: false, showImages: false, cwd: "/tmp", outputPad: 1, executionStarted: true, state: {} };
			renderers.renderResult(result, { expanded: true, isPartial: false }, piTheme, context).render(WIDTH);
		}
		return (performance.now() - t0) / N;
	});
}
for (const kb of [16, 64]) {
	console.log(`[read expand]  ${String(kb).padStart(2)} KB .ts result, build+render: pi ${readExpand(kb, false).toFixed(2)} ms → fast ${readExpand(kb, true).toFixed(2)} ms`);
}

// Last: its warm-up loop shifts JIT state enough to skew the sections above (read expand 6 → 9 ms).
chrome();
