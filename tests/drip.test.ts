import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Chronicle } from "../extensions/chronicle.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { advance, commitInterval, createPace, findOpenFenceLanguage, noteInput, revealMessage, trailingStreamBlock } from "../extensions/drip.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";

const config = DREAMWALKER.smoothStreaming;
const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g;

/**
 * Feed `bursts` of `size` chars every `every` ms, tick every tickMs, end at `endAt` (or after the
 * last burst). Returns the cursor after every tick and the tick index of the end.
 */
function simulate(size: number, every: number, bursts: number) {
	const text = "lorem ipsum dolor sit amet ".repeat(Math.ceil((size * bursts) / 27)).slice(0, size * bursts);
	let length = 0;
	let now = 1000;
	const state = createPace(0, now, config);
	const shown: number[] = [];
	const lags: number[] = [];
	let ending = false;
	let endTick = -1;
	for (let tick = 0; tick < 2000; tick++) {
		now += config.tickMs;
		const due = Math.min(bursts, Math.floor((now - 1000) / every) + 1);
		if (due * size > length) {
			length = due * size;
			noteInput(state, length, now, config);
		}
		if (!ending && length === text.length && now - 1000 >= (bursts - 1) * every + 1) {
			ending = true;
			endTick = tick;
		}
		advance(state, text.slice(0, length), now, config, ending);
		shown.push(state.shown);
		lags.push(length - state.shown);
		if (ending && state.shown >= text.length) break;
	}
	return { text, shown, lags, endTick };
}

test("pacer: bursty input reveals continuously, without stalls between bursts", () => {
	// 240 chars every 400 ms: the burst pattern that makes plain rendering jump.
	const { shown, text, endTick } = simulate(240, 400, 10);
	assert.equal(shown.at(-1), text.length);
	// From the first visible text to the end of input, the cursor must not stall for > 150 ms.
	const first = shown.findIndex((v) => v > 0);
	let stall = 0;
	let worst = 0;
	for (let i = first + 1; i < endTick; i++) {
		stall = shown[i] === shown[i - 1] ? stall + config.tickMs : 0;
		worst = Math.max(worst, stall);
	}
	assert.ok(worst <= 150, `longest stall ${worst} ms`);
	assert.ok(shown.every((v, i) => i === 0 || v >= shown[i - 1]!), "monotonic");
});

test("pacer: lag stays bounded for fast models and drains quickly after the end", () => {
	// ~1200 chars/s in 60-char chunks every 50 ms.
	const { lags, shown, text, endTick } = simulate(60, 50, 80);
	const worst = Math.max(...lags.slice(0, endTick));
	assert.ok(worst < 1200 * (config.maxLagMs / 1000) + 120, `worst lag ${worst} chars`);
	const drainTicks = shown.length - 1 - endTick;
	assert.ok(drainTicks * config.tickMs <= config.settleDrainMaxMs + 2 * config.tickMs, `drained in ${drainTicks} ticks`);
	assert.equal(shown.at(-1), text.length);
});

test("pacer: a huge single append is shown at once", () => {
	const state = createPace(0, 0, config);
	noteInput(state, config.largeAppendChars + 1, 10, config);
	assert.equal(state.shown, config.largeAppendChars + 1);
	assert.equal(createPace(config.largeAppendChars + 5, 0, config).shown, config.largeAppendChars + 5);
});

test("pacer: stops on word boundaries, never splits a surrogate pair, handles CJK", () => {
	const words = "word ".repeat(200);
	const state = createPace(0, 0, config);
	noteInput(state, words.length, 1, config);
	for (let now = 34; state.shown < words.length; now += 33) {
		advance(state, words, now, config, true);
		if (state.shown < words.length) assert.equal(words[state.shown - 1], " ", `cut at ${state.shown}`);
	}
	const emoji = "🙂".repeat(80);
	const e = createPace(0, 0, config);
	noteInput(e, emoji.length, 1, config);
	for (let now = 34; e.shown < emoji.length; now += 33) {
		advance(e, emoji, now, config, true);
		const code = emoji.charCodeAt(e.shown - 1);
		assert.ok(!(code >= 0xd800 && code <= 0xdbff), `cut inside a pair at ${e.shown}`);
	}
	const cjk = "中文流式输出测试".repeat(20);
	const c = createPace(0, 0, config);
	noteInput(c, cjk.length, 1, config);
	assert.ok(advance(c, cjk, 400, config, true) > 0);
});

test("revealMessage: copies the trailing block only, never mutates", () => {
	const message = {
		content: [
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "hello world" },
		],
	};
	const block = trailingStreamBlock(message.content)!;
	assert.deepEqual(block, { index: 1, field: "text", length: 11 });
	const copy = revealMessage(message, block, 5);
	assert.equal((copy.content[1] as { text: string }).text, "hello");
	assert.equal(message.content[1]!.text, "hello world");
	assert.equal(copy.content[0], message.content[0]);
	assert.equal(revealMessage(message, block, 11), message, "fully revealed → same object");
	assert.equal(trailingStreamBlock([{ type: "toolCall" }]), undefined);
});

test("presets: realtime, balanced and silky set the reserve and the commit interval", () => {
	const smooth = DREAMWALKER.smoothStreaming;
	const original = smooth.preset;
	try {
		const seen = (["realtime", "balanced", "silky"] as const).map((preset) => {
			smooth.preset = preset;
			return [smooth.targetBufferMs, smooth.minCommitMs];
		});
		assert.deepEqual(seen, [[40, 32], [120, 48], [170, 56]]);
	} finally {
		smooth.preset = original;
	}
});

test("commit pacing: the interval widens with the open tail, up to the cap", () => {
	const interval = (tail: number) => commitInterval(config, tail);
	assert.equal(interval(0), config.minCommitMs);
	assert.ok(interval(400) > interval(40) && interval(40) > interval(0));
	assert.equal(interval(1_000_000), config.maxCommitMs);
	assert.equal(commitInterval({ ...config, commitPerChars: 0 }, 5000), config.minCommitMs, "0 = never widen");
});

test("findOpenFenceLanguage: the last unclosed ``` fence, like streamdown", () => {
	assert.equal(findOpenFenceLanguage("text"), null);
	assert.equal(findOpenFenceLanguage("a\n```html\n<p>"), "html");
	assert.equal(findOpenFenceLanguage("a\n```\ncode"), "", "a fence without a language");
	assert.equal(findOpenFenceLanguage("```ts\nx\n```\ntext"), null, "closed");
	assert.equal(findOpenFenceLanguage("```ts\nx\n```\n```html\n<p>"), "html", "the last one counts");
});

const chronicle = new Chronicle();
let frames = 0;
before(() => {
	initTheme("dark");
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
	installMessageChrome({
		theme: () => piTheme as Theme,
		chronicle,
		notify() {},
		showRunStats: false,
		smooth: config,
		streamRender: true,
		fade: DREAMWALKER.streamFade,
		requestRender: () => {
			frames++;
			return true;
		},
	});
});
after(() => {
	uninstallMessageChrome();
	mock.timers.reset();
});

/** Advance mocked time frame by frame: one big tick would show every callback the final Date.now(). */
const run = (ms: number) => {
	for (let t = 0; t < ms; t += config.tickMs) mock.timers.tick(config.tickMs);
};

/** The rendered text, without the `▲` mark on its first row. */
const visible = (component: AssistantMessageComponent) =>
	component
		.render(200)
		.map((line) => line.replace(ANSI, "").replace(DREAMWALKER.glyph.assistant, "").trim())
		.filter(Boolean)
		.join(" ");

const msg = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 7,
	stopReason,
	model: "m",
});

test("assistant: a burst is revealed over ticks; the end drains, then pi's final build runs", () => {
	const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	frames = 0;

	component.updateContent(msg(words) as never, true); // whole burst lands in one update
	assert.ok(visible(component).length < 10, "nothing dumped at once");

	const sizes: number[] = [];
	for (let i = 0; i < 24; i++) {
		mock.timers.tick(config.tickMs);
		sizes.push(visible(component).length);
	}
	assert.ok(sizes.at(-1)! > sizes[0]!, `grows: ${sizes}`);
	assert.ok(sizes.every((v, i) => i === 0 || v >= sizes[i - 1]!), `monotonic: ${sizes}`);
	assert.ok(sizes.at(-1)! < words.length, "still revealing");
	assert.ok(frames >= 6, "ticks request frames");
	// Commits are spaced by the preset's interval (48 ms, wider as the tail grows), not one per tick.
	assert.ok(new Set(sizes).size <= sizes.length / 2, `commits are rate-limited: ${sizes}`);

	// invalidate() (theme change) replays lastMessage = the revealed copy; must not lose the rest.
	component.invalidate();
	run(config.tickMs * 100);
	assert.equal(visible(component), words);

	// The final update drains the backlog within the settle window, then pi's own build runs.
	const longer = `${words} ${"tail ".repeat(40).trim()}`;
	component.updateContent(msg(longer) as never, true);
	component.updateContent(msg(longer) as never, false);
	assert.ok(visible(component).length < longer.length, "not dumped at the end");
	run(config.settleDrainMaxMs + 160 + DREAMWALKER.streamFade.fadeMs + config.tickMs * 2);
	assert.equal(visible(component), longer);
	assert.equal((component as unknown as { isStreaming: boolean }).isStreaming, false, "final build ran");
	assert.ok(!component.render(200).some((line) => line.includes("\x1b[2m")), "no faint left");

	// Nothing buffered → the ticker is idle: no more frames requested.
	const idle = frames;
	run(config.tickMs * 10);
	assert.equal(frames, idle);
});

test("assistant: abort and error flush at once", () => {
	for (const stopReason of ["aborted", "error"]) {
		const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
		const text = "partial answer ".repeat(30).trim();
		component.updateContent(msg(text) as never, true);
		component.updateContent(msg(text, stopReason) as never, false);
		assert.ok(visible(component).includes(text), stopReason);
	}
});

test("assistant: earlier blocks render in full, only the trailing block drips", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "first think this through" },
			{ type: "text", text: "answer ".repeat(30).trim() },
		],
		timestamp: 8,
		stopReason: "stop",
		model: "m",
	};
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	component.updateContent(message as never, true);
	const text = visible(component);
	assert.ok(text.includes("first think this through"), text);
	assert.ok(!text.includes("answer answer answer"), text);
	component.updateContent({ ...message, stopReason: "aborted" } as never, false);
});

test("assistant: new characters fade in, then settle to normal", () => {
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	const text = "fade ".repeat(40).trim();
	// A gradient step (true color) or, for a char of unknown color, faint.
	const fading = (line: string) => /\x1b\[2m|\x1b\[38;[25];/.test(line.replace(/\x1b\[[\d;]*m▲\x1b\[39m/, ""));
	component.updateContent(msg(text) as never, true);
	mock.timers.tick(config.tickMs * 6);
	assert.ok(component.render(120).some(fading), "leading edge is mid-fade");
	run(config.tickMs * 100); // input idle: drains, fades out
	assert.equal(visible(component), text);
	assert.ok(!component.render(120).some(fading), "settled text is normal");
	component.updateContent(msg(text, "aborted") as never, false);
});

test("assistant: text inside an open html fence is shown at once; other fences are paced", () => {
	const body = "<p>line</p>\n".repeat(30);
	const count = (c: AssistantMessageComponent) => (c.render(200).join("\n").replace(ANSI, "").match(/<p>line<\/p>/g) ?? []).length;
	const html = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	html.updateContent(msg(`Here:\n\n\`\`\`html\n${body}`) as never, true);
	mock.timers.tick(config.tickMs * 4);
	assert.equal(count(html), 30, "a live html preview sees every chunk");
	html.updateContent(msg("done", "aborted") as never, false);
	const ts = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
	ts.updateContent(msg(`Here:\n\n\`\`\`ts\n${body}`) as never, true);
	mock.timers.tick(config.tickMs * 4);
	assert.ok(count(ts) < 30, "other languages keep the pace");
	ts.updateContent(msg("done", "aborted") as never, false);
});
