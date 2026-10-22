/** Fast highlighter: text parity with pi, incremental sessions, Markdown and read integration. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { DREAMWALKER } from "../extensions/config.ts";
import {
	disposeHighlightSessions,
	fastHighlight,
	highlighterReady,
	INCREMENTAL_MIN_CHARS,
	scopeStyle,
	withFastCodeBlocks,
} from "../extensions/highlight.ts";
import { fastReadResult } from "../extensions/read-highlight.ts";

initTheme("dark");
const theme = piTheme as Theme;
const ANSI = /\x1b\[[0-9;:]*m/g;
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, ""));
const TS = readFileSync(new URL("../extensions/stream-markdown.ts", import.meta.url), "utf8");

test("the highlighter loads", async () => {
	assert.equal(await highlighterReady, true);
});

test("output keeps every line's text and colors code", () => {
	const samples: [string, string][] = [
		["typescript", 'const x: number = 1; // c\n/* a\nb */\nexport function f() { return "s"; }\n'],
		["python", "def f(x):\n    return x + 1  # c\n"],
		["bash", 'echo "$HOME" | grep -n foo > out.txt'],
		["json", '{"a": [1, true, null]}'],
		["go", "package main\nfunc main() {}"],
	];
	for (const [lang, code] of samples) {
		const lines = fastHighlight(code, lang, theme)!;
		assert.ok(lines, lang);
		assert.deepEqual(plain(lines), code.split("\n"), lang);
		assert.match(lines.join(""), ANSI, `${lang} colored`);
	}
});

test("unsupported input falls back", () => {
	assert.equal(fastHighlight("x", undefined, theme), undefined);
	assert.equal(fastHighlight("x", "no-such-language", theme), undefined);
	assert.equal(fastHighlight("a\r\nb", "ts", theme), undefined);
	const features = DREAMWALKER.features as { fastHighlight: boolean };
	features.fastHighlight = false;
	try {
		assert.equal(fastHighlight("const x = 1", "ts", theme), undefined);
	} finally {
		features.fastHighlight = true;
	}
});

test("scopes map onto pi's syntax tokens", () => {
	assert.deepEqual(scopeStyle("keyword.control"), { color: "syntaxKeyword" });
	assert.deepEqual(scopeStyle("comment.doc"), { color: "syntaxComment" });
	assert.deepEqual(scopeStyle("constructor"), { color: "syntaxType" });
	assert.equal(scopeStyle("variable"), undefined);
	assert.equal(scopeStyle("toString"), undefined);
});

test("Pierre colors: own hex per scope, slots when off, one cache per mode", () => {
	const features = DREAMWALKER.features as { pierreSyntax: boolean };
	features.pierreSyntax = true;
	const code = 'const a = fn("x", 1); // c';
	disposeHighlightSessions();
	const pierre = fastHighlight(code, "ts", theme)!.join("");
	assert.deepEqual(plain([pierre]), [code]);
	// pierre-dark-soft: keyword #ff91a8, string #8cda94, number #96d9f6, comment #636363.
	for (const rgb of ["255;145;168", "140;218;148", "150;217;246", "99;99;99"]) assert.ok(pierre.includes(`38;2;${rgb}m`), rgb);
	features.pierreSyntax = false;
	try {
		const slots = fastHighlight(code, "ts", theme)!.join("");
		assert.notEqual(slots, pierre);
		assert.deepEqual(plain([slots]), [code]);
		// A big text uses a tokenizer made for the active mode, never one cached under the other.
		const big = `${TS}\n`;
		const bigSlots = fastHighlight(big, "ts", theme)!;
		features.pierreSyntax = true;
		const bigPierre = fastHighlight(big, "ts", theme)!;
		assert.notDeepEqual(bigPierre, bigSlots);
		assert.deepEqual(plain(bigPierre), plain(bigSlots));
	} finally {
		features.pierreSyntax = false;
		disposeHighlightSessions();
	}
});

test("incremental sessions match a fresh pass for appends and mid-text edits", () => {
	assert.ok(TS.length > INCREMENTAL_MIN_CHARS * 2);
	const fresh = (code: string) => {
		disposeHighlightSessions();
		const lines = fastHighlight(code, "ts", theme)!;
		disposeHighlightSessions();
		return lines;
	};
	disposeHighlightSessions();
	for (let i = INCREMENTAL_MIN_CHARS; i <= TS.length; i += 997) {
		const prefix = TS.slice(0, i);
		const grown = fastHighlight(prefix, "ts", theme)!;
		if (i % 7 === 0) assert.deepEqual(grown, fresh(prefix), `append at ${i}`);
	}
	assert.deepEqual(fastHighlight(TS, "ts", theme), fresh(TS), "append");

	// Opening a block comment mid-file changes the lexer state of every later line.
	fastHighlight(TS, "ts", theme);
	const middle = TS.indexOf("\n", TS.length >> 1) + 1;
	const edited = `${TS.slice(0, middle)}/* open\n${TS.slice(middle)}`;
	assert.deepEqual(fastHighlight(edited, "ts", theme), fresh(edited), "insert");
	fastHighlight(edited, "ts", theme);
	assert.deepEqual(fastHighlight(TS, "ts", theme), fresh(TS), "delete");
	disposeHighlightSessions();
});

test("Markdown code blocks: same text as pi, fast colors", () => {
	const md = "Intro\n\n```ts\nconst a = 1; // c\nfunction f() {}\n```\n\nafter\n\n```\nno lang\n```";
	const base = getMarkdownTheme();
	const piLines = new Markdown(md, 1, 0, base).render(60);
	const fast = withFastCodeBlocks(base, () => theme);
	assert.notEqual(fast, base);
	assert.equal(withFastCodeBlocks(base, () => theme), fast, "one wrapper per theme");
	assert.equal(withFastCodeBlocks(fast, () => theme), fast, "never wrapped twice");
	const fastLines = new Markdown(md, 1, 0, fast).render(60);
	assert.deepEqual(plain(fastLines), plain(piLines));
	assert.notDeepEqual(fastLines, piLines, "code colored by the fast highlighter");
});

test("expanded read results keep pi's layout with fast colors", () => {
	const renderers = withBuiltInRenderers("read", undefined) as unknown as {
		renderResult: Parameters<typeof fastReadResult>[0];
	};
	const content = `${TS}\n\n\n`;
	const result = {
		content: [{ type: "text", text: content }],
		details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 400, totalLines: 900, maxLines: 400 } },
	};
	const context = {
		args: { path: "src/a.ts" },
		isError: false,
		showImages: false,
		cwd: "/tmp",
		lastComponent: undefined,
	} as never;
	const options = { expanded: true, isPartial: false };
	const pi = renderers.renderResult(result as never, options, theme, context).render(100);
	const fast = fastReadResult(renderers.renderResult, result as never, options, theme, context, undefined)!;
	assert.ok(fast);
	const lines = fast.render(100);
	assert.deepEqual(plain(lines), plain(pi));
	assert.match(lines.at(-1)!, /Truncated/);
	assert.equal(
		fastReadResult(renderers.renderResult, result as never, { ...options, expanded: false }, theme, context, undefined),
		undefined,
		"collapsed results stay pi's",
	);
	const again = fastReadResult(renderers.renderResult, result as never, options, theme, context, fast);
	assert.equal(again, fast, "component reused");
});
