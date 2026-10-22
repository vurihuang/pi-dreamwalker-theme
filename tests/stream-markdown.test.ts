import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import remend from "remend";
import { faint, REMEND_OPTIONS, StreamMarkdown, scan } from "../extensions/stream-markdown.ts";

initTheme("dark");
const theme = getMarkdownTheme();
const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g;

const md = (text: string) => new Markdown(text, 3, 0, theme);
const pi = (text: string, width: number) => md(text).render(width);

const CORPUS = [
	[
		"# 标题 Title",
		"First paragraph with **bold**, *em*, `code`, ~~del~~ and a [link](https://example.com/a).",
		"中文段落：流式输出时，已完成的块会被冻结缓存，只有末尾的块重新渲染。这是一个足够长、需要折行的句子，用来检查宽度变化。",
		"- item one\n- item **two**\n  - nested item\n\n- loose item",
		"1. first\n2. second",
		"```ts\nconst x = 1;\n\nfunction f(a: number) {\n  return a ** 2;\n}\n```",
		"| col a | col b |\n| --- | --- |\n| 1 | **2** |\n| long cell text here | x |",
		"> quoted line one\n> quoted **two**",
		"---",
		"Setext heading\n---",
		"Final paragraph after everything, with inline math $x^2$ and a tail.",
	].join("\n\n"),
	[
		"Plain start.",
		"$$\n\\frac{a}{b}\n\n= c\n$$",
		"Para between.",
		"<div>html block</div>",
		"    indented code block",
		"Last words.",
	].join("\n\n"),
];

/** Drive a StreamMarkdown through prefixes of `text`, checking every frame against pi. */
function drive(text: string, widths: number[], step: number) {
	const stream = new StreamMarkdown(md("") as never, true, { fadeMs: 0 });
	let frame = 0;
	for (let end = 1; end <= text.length; end = end === text.length ? end + 1 : Math.min(text.length, end + step)) {
		const prefix = text.slice(0, end).trim();
		if (!prefix) continue;
		stream.update(md(prefix) as never);
		const width = widths[frame++ % widths.length]!;
		const expected = pi(remend(prefix, REMEND_OPTIONS), width);
		assert.deepEqual(stream.render(width), expected, `prefix ${end} at width ${width}: ${JSON.stringify(prefix.slice(-40))}`);
	}
	return stream;
}

test("stream markdown: every streamed prefix renders exactly like pi", () => {
	for (const [i, text] of CORPUS.entries()) {
		const stream = drive(text, [100], 1);
		const frozen = (stream as unknown as { frozenRaw: string }).frozenRaw.length;
		// Corpus 1 is all freezable blocks; corpus 2 has math/html/indented code, which never freeze.
		assert.ok(frozen > (i === 0 ? text.length * 0.8 : 0), `finished blocks were frozen: ${frozen}/${text.length}`);
		// The complete text is pi's own final render, so the final build never jumps.
		assert.deepEqual(stream.render(100), pi(text, 100));
	}
});

test("stream markdown: parity holds across width changes mid-stream", () => {
	for (const text of CORPUS) drive(text, [100, 40, 72, 100, 23], 7);
});

test("stream markdown: remend closes open markup in the tail", () => {
	const stream = new StreamMarkdown(md("hello **wor") as never, true, { fadeMs: 0 });
	const plain = stream.render(80).map((line) => line.replace(ANSI, "")).join("");
	assert.ok(plain.includes("hello wor") && !plain.includes("**"), plain);
	stream.update(md("see [li") as never);
	assert.ok(!stream.render(80).join("").includes("["), "incomplete link shows as text");
});

test("stream markdown: reference definitions fall back to whole-document rendering", () => {
	const text = "Intro uses [the docs][d].\n\nMore text here.\n\nAnother paragraph.\n\n[d]: https://example.com/docs";
	const stream = drive(text, [90], 3);
	assert.deepEqual(stream.render(90), pi(text, 90));
});

test("fade: prose fades, a fenced code block reveals as a block, prose after it fades again", () => {
	let now = 1_000_000;
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const stream = new StreamMarkdown(md("Hello") as never, true, { fadeMs: 150 });
		assert.ok(stream.render(80).join("").includes("\x1b[2m"), "a new block fades in");
		now += 200;
		assert.ok(!stream.render(80).join("").includes("\x1b[2m"), "then settles");
		assert.equal(stream.fading(), false);

		stream.update(md("Hello\n\n```ts\nconst a = 1;\nlet b = 2;") as never);
		const open = stream.render(80);
		assert.ok(open.some((line) => line.replace(ANSI, "").includes("let b = 2;")));
		assert.ok(!open.some((line) => line.includes("\x1b[2m")), "open code has no fade");
		assert.equal(stream.fading(), false);

		stream.update(md("Hello\n\n```ts\nconst a = 1;\nlet b = 2;\n```\n\nAfter the block") as never);
		const done = stream.render(80);
		const faintRows = done.filter((line) => line.includes("\x1b[2m"));
		assert.equal(faintRows.length, 1, "only the prose after the fence fades");
		assert.ok(faintRows[0]!.replace(ANSI, "").includes("After the block"));
		assert.equal(stream.fading(), true);
		now += 1000;
		assert.equal(stream.fading(), false);
	} finally {
		Date.now = realNow;
	}
});

test("fade: faint keeps text and width, restores bold after the run", () => {
	const line = `  \x1b[1mbold\x1b[22m and \x1b]8;;https://x.y\x07link\x1b]8;;\x07 中文 🙂 \x1b[38;5;1mred\x1b[39m`;
	const { chars, counts } = scan([line]);
	const text = chars.join("");
	assert.equal(text, "boldandlink中文🙂red");
	assert.deepEqual(counts, [text.length]);
	// Births are per UTF-16 unit: "bo" young, "ld…🙂" old, "red" young.
	const red = text.indexOf("red");
	const births = Array.from({ length: text.length }, (_, i) => (i < 2 || i >= red ? 1000 : 0));
	const out = faint(line, births, 0, 1000, 150);
	assert.equal(out.replace(ANSI, ""), line.replace(ANSI, ""));
	assert.equal(visibleWidth(out), visibleWidth(line));
	assert.ok(out.includes("\x1b[1m\x1b[2mbo\x1b[22m\x1b[1mld"), JSON.stringify(out));
	// 38;5;1 is a color, not bold: leaving faint after it must not re-enable bold.
	assert.ok(out.endsWith("\x1b[38;5;1m\x1b[2mred\x1b[39m\x1b[2m\x1b[22m"), JSON.stringify(out));
});

test("fade: a growing table fades only its new cells, never the re-laid-out borders", () => {
	let now = 1_000_000;
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const head = "| a | b |\n| --- | --- |\n| 1 | 2 |";
		const stream = new StreamMarkdown(md(head) as never, true, { fadeMs: 150 });
		stream.render(80);
		now += 1000;
		stream.update(md(`${head}\n| a much wider cell | 3 |`) as never); // column a widens: every border moves
		const lines = stream.render(80);
		const faintLines = lines.filter((line) => line.includes("\x1b[2m"));
		assert.equal(faintLines.length, 1, "only the new row has faint text");
		assert.ok(faintLines[0]!.replace(ANSI, "").includes("a much wider cell"));
		for (const line of lines) {
			const runs = line.match(/\x1b\[2m[^\x1b]*/g) ?? [];
			for (const run of runs) assert.ok(!/[\u2500-\u257f]/.test(run.slice(4).trimEnd().slice(0, 1)), `border faded: ${JSON.stringify(line)}`);
		}
	} finally {
		Date.now = realNow;
	}
});

test("stream markdown: a large open code block renders line by line, exactly like pi", async () => {
	const { highlighterReady } = await import("../extensions/highlight.ts");
	const { withFastCodeBlocks } = await import("../extensions/highlight.ts");
	const { theme: piTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
	const { CodeTailRenderer } = await import("../extensions/code-tail.ts");
	await highlighterReady;
	const proto = CodeTailRenderer.prototype as unknown as { render: (...a: unknown[]) => string[] };
	const original = proto.render;
	let used = 0;
	proto.render = function (this: unknown, ...a: unknown[]) {
		used++;
		return original.apply(this, a);
	};
	const code = Array.from({ length: 80 }, (_, i) => `\tconst value${i}: number = ${i}; // a fairly long comment that wraps at narrow widths ${i}`).join("\n");
	const texts = [
		`Intro paragraph.\n\n- a list\n- items\n\n\`\`\`ts\n${code}\n\n/* open\ncomment */\n\`\`\`\n\nAfter the block.`,
		`~~~python\n${code.replace(/const |: number/g, "")}\n~~~~\n\nDone.`,
		`Before.\n\n\`\`\`\n${code}\n\`\`\``,
	];
	for (const fast of [false, true]) {
		const base = fast ? withFastCodeBlocks(theme, () => piTheme as never) : theme;
		const mk = (text: string) => new Markdown(text, 3, 0, base);
		for (const text of texts) {
			const stream = new StreamMarkdown(mk("") as never, true, { fadeMs: 0 });
			let frame = 0;
			used = 0;
			for (let end = 1; end <= text.length; end += end > 1200 ? 37 : 113) {
				const prefix = text.slice(0, end).trim();
				if (!prefix) continue;
				stream.update(mk(prefix) as never);
				const width = [100, 60, 33][frame++ % 3]!;
				const expected = mk(remend(prefix, REMEND_OPTIONS)).render(width);
				assert.deepEqual(stream.render(width), expected, `fast=${fast} prefix ${end} at ${width}: ${JSON.stringify(prefix.slice(-30))}`);
			}
			stream.update(mk(text) as never);
			assert.deepEqual(stream.render(80), mk(text).render(80), "complete text");
			assert.ok(used > 10, `line-by-line path used (${used} frames)`);
		}
	}
	proto.render = original;
});

const palette = { from: rgbColor(16, 16, 20), base: rgbColor(220, 220, 218), mode: "truecolor" as const };

test("fade: with a palette a char rises from the background to its color in steps, then settles", () => {
	const line = "  \x1b[38;2;200;100;50mabc\x1b[39m";
	const style = { palette, steps: 4, granularity: "char" as const };
	const at = (age: number) => faint(line, [1000, 1000, 1000], 0, 1000 + age, 180, style);
	const sgrOf = (out: string) => out.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)!.map((m) => m.slice(7, -1).split(";").map(Number));
	const first = sgrOf(at(0))[1]!;
	const last = sgrOf(at(170))[1]!;
	assert.ok(first[0]! < last[0]! && last[0]! < 200, "brighter each step, short of the final color");
	assert.ok(!at(0).includes("\x1b[2m"), "a known color needs no faint");
	assert.equal(at(180).replace(ANSI, ""), "  abc");
	assert.equal(at(180), line, "settled: the line is untouched");
	// The line's own reset ends the override: nothing to restore.
	assert.ok(at(0).endsWith("abc\x1b[39m"), JSON.stringify(at(0)));
	// A run that ends before the line's color changes restores that color.
	const mid = faint("\x1b[38;2;200;100;50mab", [1000, 0], 0, 1000, 180, style);
	assert.match(mid, /^\x1b\[38;2;200;100;50m\x1b\[38;2;\d+;\d+;\d+ma\x1b\[38;2;200;100;50mb$/, JSON.stringify(mid));
	const early = faint("\x1b[38;2;200;100;50mab", [0, 1000], 0, 1000, 180, style);
	assert.ok(early.startsWith("\x1b[38;2;200;100;50ma"), JSON.stringify(early));
	// A default-colored char fades from the theme's text color; a palette color is unknown: faint.
	const plain = faint("  hi", [1000, 1000], 0, 1000, 180, style);
	assert.ok(plain.includes("\x1b[38;2;"), JSON.stringify(plain));
	const ansi = faint("  \x1b[31mhi\x1b[39m", [1000, 1000], 0, 1000, 180, style);
	assert.ok(ansi.includes("\x1b[2m"), "an ANSI palette color falls back to faint");
	assert.equal(visibleWidth(plain), visibleWidth("  hi"));
});

test("fade: word granularity fades a word as one unit, by its newest char", () => {
	const line = "ab cd";
	const births = [0, 900, 0, 0];
	const char = faint(line, births, 0, 1000, 150, { palette: undefined, steps: 1, granularity: "char" });
	assert.equal(char, "a\x1b[2mb \x1b[22mcd");
	const word = faint(line, births, 0, 1000, 150, { palette: undefined, steps: 1, granularity: "word" });
	assert.equal(word, "\x1b[2mab \x1b[22mcd", "the whole word follows its newest char");
});

test("stream markdown: remend options can be overridden", () => {
	const opened = new StreamMarkdown(md("a <b>x") as never, true, { fadeMs: 0 }).render(80).join("\n");
	assert.ok(opened.includes("<b>"));
	const stream = new StreamMarkdown(md("a ~~del") as never, true, { fadeMs: 0, remend: { strikethrough: false } });
	const off = stream.render(80).join("\n");
	assert.ok(off.includes("~~del"), "strikethrough completion off: the marker stays literal");
});
