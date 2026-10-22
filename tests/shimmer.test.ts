/** Editor border shimmer: band shape, tone rules (hue kept, sides and bottom undimmed, track clear of the background), only while busy. */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { theme as piTheme, getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { colorToOkhsl, parseColor, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { DreamEditor } from "../extensions/editor.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { parseForeground, shimmerInterval, shimmerPainter, type Tone } from "../extensions/shimmer.ts";

initTheme("dark");
const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
/** A truecolor foreground painter for `#rrggbb`, like pi's `borderColor`. */
const fgOf = (hex: string) => {
	const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
	return (s: string) => `\x1b[38;2;${rgb}m${s}\x1b[39m`;
};
const border = fgOf("#9776e5");
const DARK: Tone = { light: false, mode: "truecolor", backgroundL: colorToOkhsl(parseColor("#21262F")!).l };
const LIGHT: Tone = { light: true, mode: "truecolor", backgroundL: colorToOkhsl(parseColor("#FAFAFA")!).l };
const { swing, minGap } = DREAMWALKER.shimmer;

/** OKHSL of every column of `out` (one entry per glyph). */
function columns(out: string) {
	const cols: { h: number; s: number; l: number }[] = [];
	for (const m of out.matchAll(/(\x1b\[38;2;\d+;\d+;\d+m)([^\x1b]+)/g)) {
		const okhsl = colorToOkhsl(parseForeground(m[1]!)!);
		for (const _ of m[2]!) cols.push(okhsl);
	}
	return cols;
}
const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const okhslOf = (fn: (s: string) => string) => colorToOkhsl(parseForeground(fn("x"))!);

test("shimmer: glyphs outside the BMP stay whole and one column each", () => {
	const { at } = shimmerPainter(border, DARK, 100, 900)!; // mid-sweep
	const glyph = "\u{1FB82}";
	const plain = strip(at(glyph.repeat(100), 0));
	assert.ok(!plain.includes("\uFFFD") && !/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/.test(plain.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "no split surrogates");
	assert.equal([...plain].length, 100);
	assert.ok([...plain].every((c) => c === glyph), plain);
});

test("shimmer: a symmetric band over a dimmed track, heavy core, same width", () => {
	const { at } = shimmerPainter(border, DARK, 100, 900)!; // mid-sweep
	const out = at("─".repeat(100), 0);
	const plain = strip(out);
	assert.equal(plain.length, 100);
	assert.equal(plain, [...plain].reverse().join(""));
	assert.ok(plain.includes("━") && plain.startsWith("─"), "heavy core, light edges");
	const cols = columns(out);
	assert.equal(cols.length, 100);
	const base = okhslOf(border);
	const trackL = Math.max(base.l - DREAMWALKER.shimmer.trackDim, Math.min(base.l, DARK.backgroundL + minGap));
	assert.ok(Math.abs(cols[0]!.l - trackL) < 0.01, "outside the band the track is `trackDim` darker, clear of the background");
	const peak = Math.max(...cols.map((c) => c.l));
	assert.ok(peak - base.l >= swing - 0.02, `peak is at least swing lighter (${peak} vs ${base.l})`);
	assert.deepEqual(cols.map((c) => c.l), [...cols].reverse().map((c) => c.l));
});

test("shimmer: outside the band the segment is the track color", () => {
	const { at, track } = shimmerPainter(border, DARK, 100, 900)!;
	assert.equal(at("──", 0), track("──"));
});

// Thinking-level colors from the user's themes and pi's own: warm, gray, pale, saturated.
const LEVELS = ["#5a524b", "#c45a3a", "#bd94f9", "#d93a2e", "#474d68", "#c2afff", "#ff79c6", "#4c4c4c", "#56b6c2", "#98c379", "#fe5462"];

test("shimmer: every ramp keeps the border's hue, the track stays clear of the background, and the band has full swing", () => {
	for (const hex of LEVELS) {
		const color = fgOf(hex);
		const base = colorToOkhsl(parseColor(hex)!);
		const { at, track } = shimmerPainter(color, DARK, 100, 900)!;
		const cols = columns(at("─".repeat(100), 0));
		// Below ~0.2 saturation 8-bit rounding alone moves the hue a few degrees.
		if (base.s > 0.2) {
			for (const c of cols) assert.ok(hueGap(c.h, base.h) < 4, `${hex}: hue ${c.h} drifted from ${base.h}`);
		}
		const t = okhslOf(track);
		assert.ok(t.l <= base.l + 0.01, `${hex}: track is never lighter than the border`);
		assert.ok(t.l >= Math.min(base.l, DARK.backgroundL + minGap) - 0.01, `${hex}: track ${t.l} sinks into the background`);
		const peak = Math.max(...cols.map((c) => c.l));
		assert.ok(peak - t.l >= swing - 0.02, `${hex}: band swing ${peak - t.l}`);
	}
});

test("shimmer: a near-white border moves only the track down, and only as far as needed", () => {
	const base = colorToOkhsl(parseColor("#c2afff")!);
	const t = okhslOf(shimmerPainter(fgOf("#c2afff"), DARK, 100, 900)!.track);
	assert.ok(t.l < base.l - 0.05 && t.l >= base.l - Math.max(swing, DREAMWALKER.shimmer.trackDim) - 0.01, `track ${t.l} vs border ${base.l}`);
});

test("shimmer: a dim border (dark hairline) still gets a bright band, track kept clear of the background", () => {
	const base = colorToOkhsl(parseColor("#2f3658")!);
	const { at, track } = shimmerPainter(fgOf("#2f3658"), DARK, 100, 900)!;
	const peak = Math.max(...columns(at("─".repeat(100), 0)).map((c) => c.l));
	assert.ok(peak >= DARK.backgroundL + DREAMWALKER.shimmer.peakGap - 0.02, `peak ${peak}`);
	assert.ok(Math.abs(okhslOf(track).l - base.l) < 0.01, "track already at the background gap stays the border color");
});

test("shimmer: light themes glow darker, same hue", () => {
	const color = fgOf("#a2b7e0");
	const base = colorToOkhsl(parseColor("#a2b7e0")!);
	const cols = columns(shimmerPainter(color, LIGHT, 100, 900)!.at("─".repeat(100), 0));
	const peak = cols.reduce((a, c) => (c.l < a.l ? c : a));
	assert.ok(peak.l < base.l - swing + 0.02, "peak is darker");
	assert.ok(hueGap(peak.h, base.h) < 4);
});

test("shimmer: the editor glows only while busy; sides and bottom keep the border color", () => {
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} } as unknown as TUI;
	const editor = new DreamEditor(tui, getEditorTheme(), { matches: () => false } as unknown as KeybindingsManager, () => piTheme as Theme, () => ({}), 0);
	editor.shimmerNow = () => 900;
	// The frame is pi's `borderColor` (the editor theme's); row 0 is the rule, row 1 the status row.
	const frame = (text: string) => (piTheme as Theme).fg("border", text);
	editor.borderColor = frame;
	const idle = editor.render(100);
	let kind = "working";
	(editor as unknown as { setWorkingStatusIndicator(i: unknown): void }).setWorkingStatusIndicator({
		get kind() {
			return kind;
		},
		renderInBorder: () => "⠋ Working…",
	});
	const busy = editor.render(100);
	const base = okhslOf(frame);
	const lightest = (line: string) => Math.max(...columns(line).map((c) => c.l));
	assert.ok(lightest(busy[2]!) > base.l + swing - 0.03, "busy border has a light band");
	assert.ok(busy[3]!.startsWith(frame("│")), "busy sides keep the border color");
	const sgr = frame("").replace("\x1b[39m", "");
	assert.ok(busy.at(-1)!.startsWith(`${sgr}╰`), "busy bottom keeps the border color");
	assert.equal(visibleWidth(busy[2]!), 100);
	assert.equal(visibleWidth(idle[2]!), 100);
	assert.ok(strip(busy[1]!).includes("⠋ Working…"), "the working message sits in the status row");
	kind = "idle";
	const after = editor.render(100);
	assert.ok(lightest(after[2]!) < base.l + 0.01, "idle border has no band");
	assert.ok(after[3]!.startsWith(frame("│")), "idle sides are the border color");
});

test("shimmer: the frame interval grows with the repaint cost, within tickMs..maxTickMs", () => {
	const { tickMs, maxTickMs, frameBudget } = DREAMWALKER.shimmer;
	assert.equal(shimmerInterval(0), tickMs);
	assert.equal(shimmerInterval(0.5), tickMs);
	assert.equal(shimmerInterval(tickMs * frameBudget * 1.5), Math.round(tickMs * 1.5));
	assert.equal(shimmerInterval(50), maxTickMs);
});

/** A busy editor on fake timers and a fake frame clock; returns the frames it requested. */
function tickedEditor() {
	let requests = 0;
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender: () => requests++ } as unknown as TUI;
	const editor = new DreamEditor(tui, getEditorTheme(), { matches: () => false } as unknown as KeybindingsManager, () => piTheme as Theme, () => ({}), 0);
	let now = 0;
	editor.frameNow = () => now;
	editor.shimmerNow = () => now;
	let kind = "working";
	(editor as unknown as { setWorkingStatusIndicator(i: unknown): void }).setWorkingStatusIndicator({
		get kind() {
			return kind;
		},
		renderInBorder: () => "⠋ Working…",
	});
	const advance = (ms: number) => {
		now += ms;
		mock.timers.tick(ms);
	};
	return { editor, advance, requests: () => requests, idle: () => (kind = "idle") };
}

test("shimmer ticker: requests frames only when nothing else painted, and stops when idle", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { tickMs } = DREAMWALKER.shimmer;
		const t = tickedEditor();
		t.editor.render(100); // first busy paint starts the ticker
		t.advance(tickMs);
		assert.equal(t.requests(), 1, "no other paint: the ticker asks for a frame");
		t.editor.render(100);
		// Another source (e.g. streaming) paints halfway through the next interval.
		t.advance(tickMs / 2);
		t.editor.render(100);
		t.advance(tickMs / 2);
		assert.equal(t.requests(), 1, "a recent paint covers this tick");
		t.advance(tickMs);
		assert.equal(t.requests(), 2, "then it resumes once the interval has passed since that paint");
		t.idle();
		t.advance(tickMs * 2);
		assert.equal(t.requests(), 3, "one last frame repaints the plain border");
		t.advance(tickMs * 10);
		assert.equal(t.requests(), 3, "stopped while idle");
	} finally {
		mock.timers.reset();
	}
});

test("shimmer ticker: stops when the editor is no longer painted (replaced), restarts on the next paint", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { tickMs } = DREAMWALKER.shimmer;
		const t = tickedEditor();
		t.editor.render(100);
		// Never painted again (requests go to a TUI that no longer holds this editor).
		t.advance(2_000);
		const stalled = t.requests();
		t.advance(10_000);
		assert.equal(t.requests(), stalled, "a detached editor stops asking for frames");
		assert.ok(stalled <= Math.ceil(600 / tickMs) + 1, `stopped soon (${stalled} requests)`);
		t.editor.render(100);
		t.advance(tickMs);
		assert.equal(t.requests(), stalled + 1, "painting it again restarts the ticker");
	} finally {
		mock.timers.reset();
	}
});
