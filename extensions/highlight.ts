/**
 * Fast syntax highlighting with `@pierre/highlights` (hand-written Wasm lexers), painted with the
 * active pi theme's `syntax*` colors. It is a drop-in for pi's `highlightCode` (cli-highlight /
 * highlight.js): same input, one ANSI string per `\n`-separated line.
 *
 * - **Theme first.** The lexer runs with a sentinel theme whose colors encode a style slot, not a
 *   color. Slots map scope names onto the same pi tokens pi's own highlight.js theme uses, and are
 *   painted with `theme.fg(...)` at call time, so theme switches still apply.
 * - **Cost.** One-shot highlighting is ~30× faster than cli-highlight (16 KB TS: 2.8 → 0.09 ms
 *   lexing). Text at or above `INCREMENTAL_MIN_CHARS` goes through a small pool of `LiveTokenizer`
 *   sessions: a growing or edited text (a streaming code block or heredoc) re-lexes and repaints
 *   only the lines whose text or lexer state changed. The pool is bounded and evicts (disposes)
 *   its least recently used session, so there is no per-component lifecycle to leak.
 * - **Pierre colors.** With `features.pierreSyntax`, tokens are colored by a bundled
 *   `@pierre/highlights` theme (`pierreSyntax.dark` / `.light`) instead of the nine `syntax*`
 *   slots, so every scope keeps its own color. If that theme did not load, the slots are used.
 * - **Fallback.** The Wasm module loads asynchronously at startup (~7 ms, off the first frame).
 *   Until it is ready, if it fails, for unknown languages, or for text with `\r`, the caller's
 *   fallback (pi's highlighter) runs.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, parseColor } from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";

type Highlights = typeof import("@pierre/highlights");
type LiveTokenizer = InstanceType<Highlights["LiveTokenizer"]>;
type ThemedToken = { content: string; color?: string };
type Color = Parameters<Theme["fg"]>[0];

let hl: Highlights | undefined;
type PierreTheme = { name: string; appearance: string; style: object };
const pierreThemes = new Map<string, PierreTheme>();

async function loadPierreTheme(name: string): Promise<void> {
	if (!name || pierreThemes.has(name)) return;
	try {
		const spec = `@pierre/highlights/themes/${name}`;
		const module = (await import(spec)) as { default: PierreTheme };
		pierreThemes.set(name, module.default);
	} catch {
		// Unknown name or load error: that appearance keeps the `syntax*` slots.
	}
}

/** Resolves to whether the fast highlighter loaded (and the configured Pierre themes were tried). */
export const highlighterReady: Promise<boolean> = import("@pierre/highlights").then(
	async (module) => {
		hl = module;
		await Promise.all([loadPierreTheme(DREAMWALKER.pierreSyntax.dark), loadPierreTheme(DREAMWALKER.pierreSyntax.light)]);
		return true;
	},
	() => false,
);

/** The Pierre theme that colors code under `theme`, if enabled and loaded. */
function pierreFor(theme: Theme): PierreTheme | undefined {
	if (!DREAMWALKER.features.pierreSyntax) return undefined;
	const { dark, light } = DREAMWALKER.pierreSyntax;
	return pierreThemes.get(theme.appearance === "light" ? light : dark);
}

export function fastHighlightReady(): boolean {
	return !!hl && DREAMWALKER.features.fastHighlight;
}

// --- Scope → pi style ---------------------------------------------------------------------------

type Style = { color?: Color; italic?: boolean; bold?: boolean; underline?: boolean };

/**
 * Mirrors pi's cli-highlight theme (`buildCliHighlightTheme`): keyword, built_in/class/type → type,
 * literal/number → number, string/regexp → string, comment/doctag → comment, title/function →
 * function, attr/params/variable → variable, tag → punctuation, meta → muted. Plain identifiers
 * (`variable`, `property`) stay uncolored, as highlight.js leaves them.
 */
const EXACT: Record<string, Style> = {
	"keyword.operator": { color: "syntaxOperator" },
	"keyword.jsdoc": { color: "syntaxComment" },
	"type.jsdoc": { color: "syntaxComment" },
	"variable.jsdoc": { color: "syntaxComment" },
	"variable.parameter": { color: "syntaxVariable" },
	"variable.special": { color: "syntaxVariable" },
	"property.json_key": { color: "syntaxVariable" },
	"string.special.symbol": { color: "syntaxNumber" },
	"punctuation.list_marker": { color: "syntaxKeyword" },
	"diff.plus": { color: "toolDiffAdded" },
	"diff.minus": { color: "toolDiffRemoved" },
	"emphasis.strong": { bold: true },
	"tag.component.jsx": { color: "syntaxType" },
	"text.literal": { color: "syntaxString" },
	link_uri: { underline: true },
	link_text: { color: "syntaxFunction" },
};
const BY_ROOT = new Map<string, Style>([
	["keyword", { color: "syntaxKeyword" }],
	["type", { color: "syntaxType" }],
	["constructor", { color: "syntaxType" }],
	["enum", { color: "syntaxType" }],
	["namespace", { color: "syntaxType" }],
	["number", { color: "syntaxNumber" }],
	["boolean", { color: "syntaxNumber" }],
	["constant", { color: "syntaxNumber" }],
	["string", { color: "syntaxString" }],
	["comment", { color: "syntaxComment" }],
	["function", { color: "syntaxFunction" }],
	["title", { color: "syntaxFunction" }],
	["attribute", { color: "syntaxVariable" }],
	["label", { color: "syntaxVariable" }],
	["operator", { color: "syntaxOperator" }],
	["punctuation", { color: "syntaxPunctuation" }],
	["tag", { color: "syntaxKeyword" }],
	["selector", { color: "syntaxKeyword" }],
	["preproc", { color: "muted" }],
	["emphasis", { italic: true }],
]);

export function scopeStyle(name: string): Style | undefined {
	return (Object.hasOwn(EXACT, name) ? EXACT[name] : undefined) ?? BY_ROOT.get(name.split(".")[0]!);
}

/** Distinct styles; slot 0 is plain. Each scope name maps to one slot. */
interface Slots {
	styles: (Style | undefined)[];
	theme: object;
}
let slots: Slots | undefined;

function getSlots(lib: Highlights): Slots {
	if (slots) return slots;
	const styles: (Style | undefined)[] = [undefined];
	const keys = new Map<string, number>([["", 0]]);
	const syntax: Record<string, { color: string }> = {};
	for (const name of lib.tokenNames) {
		const style = scopeStyle(name);
		const key = style ? JSON.stringify(style) : "";
		let slot = keys.get(key);
		if (slot === undefined) {
			slot = styles.length;
			styles.push(style);
			keys.set(key, slot);
		}
		syntax[name] = { color: sentinel(slot) };
	}
	slots = { styles, theme: { name: "dreamwalker-slots", appearance: "dark", style: { foreground: sentinel(0), syntax } } };
	return slots;
}

/** What the lexer runs with, and a key that tells tokenizers made with different themes apart. */
function lexTheme(lib: Highlights, theme: Theme): { theme: object; key: string } {
	const pierre = pierreFor(theme);
	return pierre ? { theme: pierre, key: pierre.name } : { theme: getSlots(lib).theme, key: "slots" };
}

const sentinel = (slot: number) => `#0000${slot.toString(16).padStart(2, "0")}`;
const slotOf = (color: string | undefined) => (color ? Number.parseInt(color.slice(5, 7), 16) || 0 : 0);

/** Paints one token. A painter's identity changes when the theme or its mode changes. */
type Painter = (token: ThemedToken & { fontStyle?: number }) => string;
const painters = new WeakMap<Theme, Painter>();
const pierrePainters = new WeakMap<Theme, Painter>();

function painter(theme: Theme, styles: (Style | undefined)[]): Painter {
	let paint = painters.get(theme);
	if (paint) return paint;
	const slotPaint = styles.map((style) => {
		if (!style) return (text: string) => text;
		return (text: string) => {
			let out = style.color ? theme.fg(style.color, text) : text;
			if (style.bold) out = theme.bold(out);
			if (style.italic) out = theme.italic(out);
			if (style.underline) out = theme.underline(out);
			return out;
		};
	});
	paint = (token) => slotPaint[slotOf(token.color)]!(token.content);
	painters.set(theme, paint);
	return paint;
}

/** Colors tokens with the Pierre theme's own hex values, converted for the terminal's color mode. */
function pierrePainter(theme: Theme): Painter {
	let paint = pierrePainters.get(theme);
	if (paint) return paint;
	const mode = theme.getColorMode();
	const prefixes = new Map<string, string>();
	const prefixOf = (color: string): string => {
		let prefix = prefixes.get(color);
		if (prefix === undefined) {
			try {
				prefix = foregroundAnsi(parseColor(color.length === 9 ? color.slice(0, 7) : color), mode);
			} catch {
				prefix = "";
			}
			prefixes.set(color, prefix);
		}
		return prefix;
	};
	paint = (token) => {
		let out = token.content;
		if (token.color) {
			const prefix = prefixOf(token.color);
			if (prefix) out = `${prefix}${out}\x1b[39m`;
		}
		const flags = token.fontStyle ?? 0;
		if (flags & 2) out = theme.bold(out);
		if (flags & 1) out = theme.italic(out);
		if (flags & 4) out = theme.underline(out);
		return out;
	};
	pierrePainters.set(theme, paint);
	return paint;
}

function paintLine(tokens: readonly ThemedToken[], paint: Painter): string {
	let out = "";
	for (const token of tokens) out += paint(token);
	return out;
}

// --- Languages ----------------------------------------------------------------------------------

/** pi language ids (`getLanguageFromPath`, fence info) the lexer resolves under another name. */
const ALIASES: Record<string, string> = { golang: "go", "objective-c": "objc", objectivec: "objc" };

function lexerLanguage(lib: Highlights, lang: string | undefined): string | undefined {
	if (!lang) return undefined;
	const name = lang.trim().toLowerCase();
	const resolved = ALIASES[name] ?? name;
	return resolved && resolved !== "plain" && resolved !== "text" && lib.isSupportedLanguage(resolved) ? resolved : undefined;
}

/** Whether the fast highlighter is loaded, enabled, and has a lexer for `lang`. */
export function canHighlight(lang: string | undefined): boolean {
	return fastHighlightReady() && !!lexerLanguage(hl!, lang);
}

// --- Incremental sessions -------------------------------------------------------------------------

/** Below this size a one-shot pass is cheaper than diffing against a session. */
export const INCREMENTAL_MIN_CHARS = 4 * 1024;
const POOL_SIZE = 4;

class Session {
	text: string;
	/** Offset of each line start in `text`. */
	starts: number[];
	lines: string[];
	paint: Painter;
	used = 0;
	readonly lang: string;
	/** Which lexer theme produced the tokens (`lexTheme().key`). */
	readonly themeKey: string;
	readonly live: LiveTokenizer;
	constructor(lang: string, themeKey: string, live: LiveTokenizer, text: string, paint: Painter) {
		this.lang = lang;
		this.themeKey = themeKey;
		this.live = live;
		this.text = text;
		this.starts = lineStarts(text, 0, [0]);
		this.paint = paint;
		this.lines = [];
		for (let i = 0; i < live.lineCount; i++) this.lines.push(paintLine(live.getLineTokens(i).tokens, paint));
	}

	/** Replace the text from its first difference on; repaint only changed lines. */
	update(text: string, paint: Painter): void {
		if (paint !== this.paint) {
			this.paint = paint;
			for (let i = 0; i < this.lines.length; i++) this.lines[i] = paintLine(this.live.getLineTokens(i).tokens, paint);
		}
		if (text === this.text) return;
		const old = this.text;
		const p = commonPrefix(old, text);
		const start = position(this.starts, p);
		const end = position(this.starts, old.length);
		const update = this.live.applyEdits([{ range: { start, end }, newText: text.slice(p) }]);
		this.text = text;
		this.starts.length = start.line + 1;
		lineStarts(text, this.starts[start.line]!, this.starts);
		for (const change of update.lineChanges) {
			const fresh: string[] = [];
			for (let i = change.newStartLine; i < change.newEndLine; i++)
				fresh.push(paintLine(this.live.getLineTokens(i).tokens, paint));
			this.lines.splice(change.newStartLine, change.oldEndLine - change.oldStartLine, ...fresh);
		}
	}
}

function lineStarts(text: string, from: number, starts: number[]): number[] {
	for (let i = text.indexOf("\n", from); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	return starts;
}

function position(starts: readonly number[], offset: number): { line: number; character: number } {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, character: offset - starts[lo]! };
}

function commonPrefix(a: string, b: string): number {
	// The common case, a growing text, is one native comparison.
	if (b.length >= a.length && b.startsWith(a)) return a.length;
	const max = Math.min(a.length, b.length);
	let i = 0;
	// Skip equal 256-char blocks natively, then finish char by char.
	while (i + 256 <= max && b.startsWith(a.slice(i, i + 256), i)) i += 256;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

const pool: Session[] = [];
let clock = 0;

function sessionFor(lib: Highlights, lang: string, code: string, paint: Painter, lex: { theme: object; key: string }): Session {
	let best: Session | undefined;
	let bestPrefix = 0;
	for (const session of pool) {
		if (session.lang !== lang || session.themeKey !== lex.key) continue;
		const prefix = commonPrefix(session.text, code);
		// Reuse only when most of the old text survives (a growing or locally edited document).
		if (prefix > bestPrefix && prefix * 2 >= session.text.length) {
			best = session;
			bestPrefix = prefix;
		}
	}
	if (best) best.update(code, paint);
	else {
		if (pool.length >= POOL_SIZE) {
			let oldest = 0;
			for (let i = 1; i < pool.length; i++) if (pool[i]!.used < pool[oldest]!.used) oldest = i;
			pool.splice(oldest, 1)[0]!.live.dispose();
		}
		const live = new lib.LiveTokenizer({ lang: lang as never, theme: lex.theme as never, code });
		best = new Session(lang, lex.key, live, code, paint);
		pool.push(best);
	}
	best.used = ++clock;
	return best;
}

/** Dispose every pooled tokenizer (tests, reload). */
export function disposeHighlightSessions(): void {
	for (const session of pool.splice(0)) session.live.dispose();
}

// --- Entry point ----------------------------------------------------------------------------------

/**
 * Highlight `code` as `lang`, one ANSI string per `\n` line, or undefined when the fast path does
 * not apply (not loaded, disabled, unknown language, `\r` in the text). The caller then falls back
 * to pi's `highlightCode`.
 */
export function fastHighlight(code: string, lang: string | undefined, theme: Theme): string[] | undefined {
	if (!fastHighlightReady()) return undefined;
	const lib = hl!;
	const lexer = lexerLanguage(lib, lang);
	if (!lexer || code.includes("\r")) return undefined;
	const lex = lexTheme(lib, theme);
	const paint = pierreFor(theme) ? pierrePainter(theme) : painter(theme, getSlots(lib).styles);
	try {
		if (code.length >= INCREMENTAL_MIN_CHARS) return sessionFor(lib, lexer, code, paint, lex).lines.slice();
		const { tokens } = lib.codeToTokens(code, { lang: lexer as never, theme: lex.theme as never });
		return tokens.map((line) => paintLine(line, paint));
	} catch {
		// A failed edit can leave a session out of sync with its text; start over.
		disposeHighlightSessions();
		return undefined;
	}
}

// --- Markdown code blocks ---------------------------------------------------------------------------

type CodeHighlighter = (code: string, lang?: string) => string[];
type MarkdownThemeLike = { highlightCode?: CodeHighlighter };
const wrappedThemes = new WeakSet<object>();
const wrappers = new WeakMap<object, MarkdownThemeLike>();

/**
 * A pi `MarkdownTheme` whose code blocks use the fast highlighter, painted with `theme()`; the
 * original `highlightCode` handles everything else. Wrappers are cached per original, so Markdown
 * instances built from the same theme keep sharing one object.
 */
export function withFastCodeBlocks<T extends MarkdownThemeLike>(markdownTheme: T, theme: () => Theme): T {
	const original = markdownTheme.highlightCode;
	if (!original || wrappedThemes.has(markdownTheme)) return markdownTheme;
	let wrapped = wrappers.get(markdownTheme) as T | undefined;
	if (!wrapped) {
		wrapped = {
			...markdownTheme,
			highlightCode: (code: string, lang?: string) =>
				(canHighlight(lang) && fastHighlight(code, lang, theme())) || original(code, lang),
		};
		wrappedThemes.add(wrapped);
		wrappers.set(markdownTheme, wrapped);
	}
	return wrapped;
}
