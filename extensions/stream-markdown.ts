/**
 * Streaming Markdown, after @lobehub/streamdown's block lexer, remend pass and per-char fade.
 *
 * Pi 1.5 reuses Markdown instances and rendered blocks, but still lexes the whole text when it
 * changes. `StreamMarkdown` freezes completed prefixes so only the open tail is lexed, and adds
 * markup completion and fade while standing in for the growing block's `Markdown`:
 *
 * - **Frozen prefix.** Top-level blocks that can no longer change (paragraph, heading, fenced code,
 *   table, blockquote, hr, followed by a blank line and more content) move into frozen chunks, each a
 *   plain pi `Markdown` that caches its lines. Only the open tail is lexed and wrapped per update.
 *   pi renders a block from its own tokens plus "is a next token present / is it a space", so a
 *   chunk ending on its space token renders exactly like the same text inside the whole document.
 *   Reference-style definitions (`[x]: url`) resolve across blocks, so they turn this off.
 * - **remend.** The open tail is completed before rendering (`**bol` → `**bol**`, `` `co `` →
 *   `` `co` ``, `[li` → `li`), so markup never flashes as raw source and then snaps into style.
 *   Only closing completions are used: the final render never differs from the last streamed one.
 * - **Fade.** Terminals have no opacity, so a new character rises from the background to its own
 *   color in a few steps (a true-color gradient) over `fadeMs`, then settles; a character whose color
 *   is unknown (a default or palette color) is drawn faint (SGR 2) instead. Births are tracked per
 *   rendered visible character (not per source char: markup and link URLs would skew them) and diffed
 *   by common prefix and suffix. Like streamdown, `word` granularity fades whole words together, and
 *   code blocks skip the fade: they reveal as a block, prose resumes the fade after the fence.
 *
 * Tokens are read from the tail `Markdown`'s own token cache, so pi's parser (with its LaTeX and
 * strikethrough extensions) decides block boundaries and no second lexer runs.
 */
import { type Color, type Component, colorToRgb, foregroundAnsi, indexedColor, mixColors, rgbColor, type TerminalColorMode } from "@earendil-works/pi-tui";
import remend, { type RemendOptions } from "remend";
import { type CodeTheme, CodeTailRenderer, openFence } from "./code-tail.ts";
import { findOpenFenceLanguage } from "./drip.ts";
import { trace, tracing } from "./trace.ts";

/** Below this size an open code block renders through pi's Markdown (cheap either way). */
export const OPEN_CODE_MIN_CHARS = 1024;

/** The pi `Markdown` fields this module reads. */
interface MarkdownInternals extends Component {
	text: string;
	paddingX: number;
	paddingY: number;
	theme: unknown;
	defaultTextStyle?: unknown;
	options?: unknown;
	cachedTokens?: WeakRef<{ source: string; tokens: Token[] }>;
}
interface Token {
	type: string;
	raw: string;
	codeBlockStyle?: string;
}
type MarkdownCtor = new (
	text: string,
	paddingX: number,
	paddingY: number,
	theme: unknown,
	defaultTextStyle?: unknown,
	options?: unknown,
) => MarkdownInternals;

/** Colors the gradient fade works from; built per theme. */
export interface FadePalette {
	/** What a fresh character rises from: the (estimated) terminal background. */
	from?: Color;
	/** The text color of characters that carry none of their own. */
	base?: Color;
	mode: TerminalColorMode;
}

export interface StreamFadeConfig {
	/** How long a new character takes to settle. 0 = no fade. */
	fadeMs: number;
	/** Fade each character, or whole words together. */
	granularity?: "char" | "word";
	/** Steps of the gradient between the background and the text color (then the text color itself). */
	steps?: number;
	/** The theme's colors; without them (or for a character of unknown color) the fade is SGR 2 faint. */
	palette?: () => FadePalette | undefined;
	/** remend options layered over `REMEND_OPTIONS` (streamdown's `remend` prop). */
	remend?: Partial<RemendOptions>;
}

/** Closing completions only: escapes and placeholders would differ from the final render. */
export const REMEND_OPTIONS: RemendOptions = {
	linkMode: "text-only",
	images: false,
	katex: false,
	inlineKatex: false,
	htmlTags: false,
	setextHeadings: false,
	singleTilde: false,
	comparisonOperators: false,
};

const FROZEN = new Set(["blockquote", "code", "heading", "hr", "paragraph", "table"]);
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:/m;

/** Character offset in `source` up to which tokens can no longer change, or 0. */
export function frozenCut(tokens: readonly Token[]): number {
	let offset = 0;
	let cut = 0;
	// The boundary needs a block, its space token, and more content after both.
	for (let i = 0; i < tokens.length - 2; i++) {
		const token = tokens[i]!;
		offset += token.raw.length;
		const next = tokens[i + 1]!;
		if (next.type === "space" && FROZEN.has(token.type) && token.codeBlockStyle !== "indented") {
			cut = offset + next.raw.length;
		}
	}
	return cut;
}

/**
 * One rendered segment (a fading frozen chunk or the tail) with per-visible-char births. Visible
 * chars are counted in UTF-16 units; a surrogate pair's birth is read from its first unit.
 */
interface FadeSegment {
	lines: string[];
	/** Visible (non-space) UTF-16 units per line. */
	counts: number[];
	/** The visible chars of each line. */
	chars: string[];
	births: number[];
	/** Whether the row after each row is inside a fenced code block (code rows have no chars). */
	after: boolean[];
	/** No char before this index can be young (Infinity: none can). */
	youngFrom: number;
	/** Upper bound of every birth; the segment is settled once it is `fadeMs` old. */
	maxBirth: number;
}

export class StreamMarkdown implements Component {
	private template: MarkdownInternals;
	private text = "";
	private incremental: boolean;
	/** False with markdown transformers: the text pi renders is not the text streamed. */
	private readonly splittable: boolean;
	private readonly fadeMs: number;
	private readonly fade: StreamFadeConfig;
	private readonly remendOptions: RemendOptions;

	private chunks: MarkdownInternals[] = [];
	private frozenRaw = "";
	private frozenLines: string[] = [];
	private frozenWidth = -1;

	private tail: MarkdownInternals | undefined;
	/** Open-code-block tail: the head's cached Markdown and the per-line code renderer. */
	private codeHead: MarkdownInternals | undefined;
	private readonly codeTail = new CodeTailRenderer();
	private readonly scanMemo: ScanMemo = { lines: new Map() };
	private tailDirty = true;
	/** The text last tested for reference definitions (`hasRefDef`). */
	private refChecked = "";
	private width = -1;
	private output: string[] = [];

	/** Fading segments: the tail, plus frozen chunks whose chars are still young. */
	private tailFade: FadeSegment | undefined;
	private chunkFades: { start: number; segment: FadeSegment }[] = [];
	private lastCommit = 0;
	/** The newest birth handed out; the next commit's chars chain on from it (streamdown's wave). */
	private lastBirth = -Infinity;
	/** The first text of a new block fades in; text re-rendered after a resize does not. */
	private started = false;

	constructor(template: MarkdownInternals, incremental: boolean, fade: StreamFadeConfig) {
		this.template = template;
		this.incremental = incremental;
		this.splittable = incremental;
		this.fadeMs = fade.fadeMs;
		this.fade = fade;
		this.remendOptions = fade.remend ? { ...REMEND_OPTIONS, ...fade.remend } : REMEND_OPTIONS;
		this.update(template);
	}

	/** Take the current text of pi's `Markdown` for the growing block. */
	update(markdown: MarkdownInternals): void {
		this.template = markdown;
		if (markdown.text === this.text) return;
		this.text = markdown.text;
		this.tailDirty = true;
	}

	/** Characters of the open tail (what is not frozen yet): the cost of the next commit grows with it. */
	tailLength(): number {
		return Math.max(0, this.text.length - this.frozenRaw.length);
	}

	/** Whether the open tail ends inside an unclosed code fence (code reveals without a fade). */
	inOpenCode(): boolean {
		const tail = this.text.slice(this.frozenRaw.length);
		return tail.includes("```") && findOpenFenceLanguage(tail) !== null;
	}

	private make(text: string): MarkdownInternals {
		const t = this.template;
		const Ctor = t.constructor as MarkdownCtor;
		return new Ctor(text, t.paddingX, t.paddingY, t.theme, t.defaultTextStyle, t.options);
	}

	private reset(): void {
		this.chunks = [];
		this.frozenRaw = "";
		this.frozenLines = [];
		this.chunkFades = [];
	}

	render(width: number): string[] {
		const now = Date.now();
		if (width !== this.width) {
			this.width = width;
			this.tailDirty = true;
			this.tailFade = undefined;
			this.chunkFades = [];
		}
		if (this.tailDirty) this.rebuild(width, now);
		if (this.fadeMs <= 0) return this.output;
		return this.applyFade(now);
	}

	private rebuild(width: number, now: number): void {
		this.tailDirty = false;
		let text = this.text;
		if (!text.startsWith(this.frozenRaw)) this.reset();
		let rest = text.slice(this.frozenRaw.length);
		if (this.incremental && this.hasRefDef(text, this.frozenRaw.length)) {
			this.incremental = false;
			this.reset();
			rest = text;
		}

		let source = remend(rest, this.remendOptions);
		// Also after a reference definition turned freezing off: code cannot define or use references,
		// so a head + open code split renders like the whole text.
		const code = this.splittable ? this.renderOpenCode(source, width) : undefined;
		let tail = code?.head ?? this.make(source);
		let tailLines = code?.lines ?? tail.render(width);

		if (this.incremental && !code) {
			const cached = tail.cachedTokens?.deref();
			const cut = cached && cached.source === source ? frozenCut(cached.tokens) : 0;
			// remend only touches the end; never freeze text it changed.
			if (cut > 0 && rest.startsWith(source.slice(0, cut))) {
				const chunk = this.make(rest.slice(0, cut));
				const chunkLines = chunk.render(width);
				this.chunks.push(chunk);
				this.frozenRaw += rest.slice(0, cut);
				rest = rest.slice(cut);
				source = source.slice(cut);
				tail = this.make(source);
				tailLines = tail.render(width);
				this.appendFrozen(chunkLines, width, now);
				// A new block starts its own wave at `now` (streamdown keeps births per block).
				this.lastBirth = -Infinity;
			}
		}
		this.tail = tail;

		if (this.frozenWidth !== width) {
			this.frozenLines = [];
			for (const chunk of this.chunks) for (const line of chunk.render(width)) this.frozenLines.push(line);
			this.frozenWidth = width;
		}
		// pi returns [""] for text that renders no lines (a lone `>`); inside the whole document that
		// block adds nothing, and real lines are always padded to width, never "".
		if (this.chunks.length && tailLines.length === 1 && tailLines[0] === "") tailLines = [];
		this.output = this.frozenLines.length ? this.frozenLines.concat(tailLines) : tailLines;
		if (this.fadeMs > 0) this.trackTail(tailLines, now);
	}

	/**
	 * Whether `text` from `from` (a line start) holds a reference definition. A definition is one
	 * line, so when `text` extends the last checked text only its last line and the new lines are
	 * tested, instead of the whole open tail on every paint.
	 */
	private hasRefDef(text: string, from: number): boolean {
		const checked = this.refChecked;
		let start = from;
		if (checked.length > from && text.startsWith(checked)) {
			start = Math.max(from, checked.lastIndexOf("\n", checked.length - 1) + 1);
		}
		this.refChecked = text;
		return REF_DEF.test(start === 0 ? text : text.slice(start));
	}

	/**
	 * The tail when it ends in an open fenced code block: its head through a cached `Markdown`, its
	 * code line by line (`code-tail.ts`). Undefined when pi's `Markdown` must render the tail.
	 */
	private renderOpenCode(source: string, width: number): { head: MarkdownInternals; lines: string[] } | undefined {
		const t = this.template;
		// pi always passes a transform; it is the identity without transformers (`splittable`).
		const style = t.defaultTextStyle as { bgColor?: unknown } | undefined;
		if (style?.bgColor || t.paddingY !== 0) return undefined;
		const fence = openFence(source.includes("\t") ? source.replace(/\t/g, "   ") : source);
		if (!fence || fence.text.length < OPEN_CODE_MIN_CHARS) return undefined;
		let head = this.codeHead;
		if (!head || head.text !== fence.head || head.theme !== t.theme || head.paddingX !== t.paddingX) {
			head = this.codeHead = this.make(fence.head);
		}
		const headLines = fence.head ? head.render(width) : [];
		if (fence.head) {
			// The head must end on its blank line, so the fence starts a new top-level block.
			const tokens = head.cachedTokens?.deref()?.tokens;
			if (tokens?.at(-1)?.type !== "space") return undefined;
		}
		const codeLines = this.codeTail.render(fence, t.theme as CodeTheme, t.paddingX, width);
		return { head, lines: headLines.length ? headLines.concat(codeLines) : codeLines };
	}

	/** Move the freshly frozen chunk's births out of the tail segment. */
	private appendFrozen(chunkLines: string[], width: number, now: number): void {
		const start = this.frozenWidth === width ? this.frozenLines.length : -1;
		if (start >= 0) for (const line of chunkLines) this.frozenLines.push(line);
		const prev = this.tailFade;
		if (this.fadeMs <= 0 || !prev) return;
		const segment = scan(chunkLines, this.template.paddingX);
		const total = segment.chars.join("").length;
		const n = Math.min(total, prev.births.length);
		const prevYoung = this.young(prev, now);
		segment.births = prev.births.slice(0, n);
		while (segment.births.length < total) segment.births.push(now);
		const fresh = total > n;
		segment.youngFrom = Math.min(prevYoung ? prev.youngFrom : Infinity, fresh ? n : Infinity);
		segment.maxBirth = Math.max(prevYoung ? prev.maxBirth : -Infinity, fresh ? now : -Infinity);
		if (start >= 0 && this.young(segment, now)) this.chunkFades.push({ start, segment });
		// What is left of the tail no longer lines up with rendered rows: keep it as one text row.
		const rest = prev.chars.join("").slice(n);
		prev.lines = [];
		prev.chars = [rest];
		prev.counts = [rest.length];
		prev.after = [];
		prev.births = prev.births.slice(n);
		prev.youngFrom = Math.max(0, prev.youngFrom - n);
	}

	/**
	 * Diff the tail's visible chars against the previous paint by common prefix and suffix, and carry
	 * births over. Leading rows equal to the previous paint's are skipped whole (their chars are equal),
	 * so a growing tail costs O(changed rows), not O(tail).
	 */
	private trackTail(lines: string[], now: number): void {
		const prev = this.tailFade;
		let row = 0;
		let base = 0;
		if (prev) {
			const same = Math.min(prev.lines.length, lines.length);
			while (row < same && prev.lines[row] === lines[row]) base += prev.counts[row++]!;
		}
		const next: FadeSegment = {
			lines,
			counts: prev ? prev.counts.slice(0, row) : [],
			chars: prev ? prev.chars.slice(0, row) : [],
			after: prev ? prev.after.slice(0, row) : [],
			births: [],
			youngFrom: Infinity,
			maxBirth: -Infinity,
		};
		const memo = this.scanMemo.lines;
		const fresh = new Map<string, string>();
		const padding = this.template.paddingX;
		let inCode = row > 0 && (next.after[row - 1] ?? false);
		for (let i = row; i < lines.length; i++) {
			const line = lines[i]!;
			const border = isFenceBorder(line, padding);
			// A fenced code block (borders included) has no chars: it reveals as a block.
			let chars = "";
			if (!inCode && !border) {
				chars = memo.get(line) ?? fresh.get(line) ?? visibleChars(line);
				fresh.set(line, chars);
			}
			if (border) inCode = !inCode;
			next.chars.push(chars);
			next.counts.push(chars.length);
			next.after.push(inCode);
		}
		this.scanMemo.lines = fresh;
		const old = prev ? prev.chars.slice(row).join("") : "";
		const seq = next.chars.slice(row).join("");
		const max = Math.min(old.length, seq.length);
		const q = commonPrefix(old, seq);
		let s = 0;
		while (s < max - q && old.charCodeAt(old.length - 1 - s) === seq.charCodeAt(seq.length - 1 - s)) s++;
		const p = base + q;
		const inserted = seq.length - q - s;
		// Reuse the previous births in place: a growing tail keeps its prefix, so only new births are written.
		const births = prev?.births ?? [];
		const suffix = s > 0 ? births.slice(births.length - s) : undefined;
		births.length = p;
		const prevYoung = !!prev && this.young(prev, now);
		// Young chars of the previous paint keep their index (prefix) or move right (suffix), never left of p.
		let youngFrom = prevYoung ? Math.min(prev!.youngFrom, p) : Infinity;
		let maxBirth = prevYoung ? prev!.maxBirth : -Infinity;
		if (inserted > 0 && !prev && this.started) {
			// Re-rendered after a resize or theme change: already on screen, show as-is.
			for (let i = 0; i < inserted; i++) births.push(now - this.fadeMs);
		} else if (inserted > 0) {
			// Spread a commit's chars over the gap to the previous commit, chained on from the previous
			// commit's last birth, so the reveal front moves as one wave across commits (streamdown's
			// `births[i] = min(now + gap + fade, max(births[i - 1] + pace, now))`).
			const gap = this.lastCommit ? Math.min(Math.max(now - this.lastCommit, 16), 160) : 16;
			const pace = Math.min(Math.max(gap / inserted, 2), 18);
			const cap = now + gap + this.fadeMs;
			let birth = this.lastBirth;
			for (let i = 0; i < inserted; i++) {
				birth = Math.min(cap, Math.max(birth + pace, now));
				births.push(birth);
				if (birth > maxBirth) maxBirth = birth;
			}
			this.lastBirth = birth;
			if (tracing) trace("births", { inserted, gap, span: Math.round(birth - now) });
			if (p < youngFrom) youngFrom = p;
			this.lastCommit = now;
		}
		if (suffix) for (const birth of suffix) births.push(birth ?? now);
		next.births = births;
		next.youngFrom = youngFrom;
		next.maxBirth = maxBirth;
		this.tailFade = next;
		this.started = true;
	}

	private young(segment: FadeSegment | undefined, now: number): boolean {
		return !!segment && segment.youngFrom < segment.births.length && now - segment.maxBirth < this.fadeMs;
	}

	/** Whether any character is still faint; the ticker keeps frames coming while it is. */
	fading(now = Date.now()): boolean {
		if (this.fadeMs <= 0) return false;
		return this.young(this.tailFade, now) || this.chunkFades.some((f) => this.young(f.segment, now));
	}

	private applyFade(now: number): string[] {
		this.chunkFades = this.chunkFades.filter((f) => this.young(f.segment, now));
		const tail = this.tailFade;
		const tailYoung = this.young(tail, now);
		if (!tailYoung && this.chunkFades.length === 0) return this.output;
		const out = this.output.slice();
		const style: FadeStyle = {
			palette: this.fade.palette?.(),
			steps: this.fade.steps ?? 1,
			granularity: this.fade.granularity ?? "char",
			skipFg: this.inlineCodeFg(),
			skipLead: this.bulletFg(),
		};
		const fadeAt = (segment: FadeSegment, offset: number) => {
			let index = 0;
			for (let row = 0; row < segment.lines.length; row++) {
				const count = segment.counts[row]!;
				// Rows wholly before the first possibly-young char are settled: skip their chars.
				if (index + count <= segment.youngFrom) {
					index += count;
					continue;
				}
				let young = false;
				for (let i = index; i < index + count; i++) {
					if (now - segment.births[i]! < this.fadeMs) {
						young = true;
						break;
					}
				}
				if (young) out[offset + row] = faint(segment.lines[row]!, segment.births, index, now, this.fadeMs, style);
				index += count;
			}
		};
		for (const { start, segment } of this.chunkFades) fadeAt(segment, start);
		if (tail && tailYoung) fadeAt(tail, this.frozenLines.length);
		return out;
	}

	private codeFg: { theme: unknown; seq: string | undefined } | undefined;
	private bulletSeq: { theme: unknown; seq: string | undefined } | undefined;

	/** The SGR that opens inline code in the current theme: streamdown never fades `code`. */
	/** The foreground of list markers (`- `, `1. `): like streamdown's `::marker`, they do not fade. */
	private bulletFg(): string | undefined {
		const theme = this.template.theme as { listBullet?: (text: string) => string };
		if (this.bulletSeq?.theme !== theme) {
			const open = theme.listBullet?.("\0").split("\0")[0] ?? "";
			this.bulletSeq = { theme, seq: /^\x1b\[38;[25];[\d;]+m$/.test(open) ? open : undefined };
		}
		return this.bulletSeq.seq;
	}

	private inlineCodeFg(): string | undefined {
		const theme = this.template.theme as { code?: (text: string) => string };
		if (this.codeFg?.theme !== theme) {
			const open = theme.code?.("\0").split("\0")[0] ?? "";
			const seq = /^\x1b\[38;[25];[\d;]+m$/.test(open) ? open : undefined;
			this.codeFg = { theme, seq };
		}
		return this.codeFg.seq;
	}

	invalidate(): void {
		for (const chunk of this.chunks) chunk.invalidate();
		this.tail?.invalidate();
		this.codeHead?.invalidate();
		this.codeTail.clear();
		this.frozenWidth = -1;
		this.width = -1;
		this.tailDirty = true;
	}
}

// --- ANSI helpers -----------------------------------------------------------------------------

const ESC = "\x1b";

/** Length of the escape sequence at `i` (CSI, OSC, APC, DCS, or a two-byte escape). */
function escapeLength(line: string, i: number): number {
	const kind = line[i + 1];
	if (kind === "[") {
		let j = i + 2;
		while (j < line.length) {
			const c = line.charCodeAt(j);
			if (c >= 0x40 && c <= 0x7e) return j + 1 - i;
			j++;
		}
		return line.length - i;
	}
	if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
		for (let j = i + 2; j < line.length; j++) {
			if (line[j] === "\x07") return j + 1 - i;
			if (line[j] === ESC && line[j + 1] === "\\") return j + 2 - i;
		}
		return line.length - i;
	}
	return Math.min(2, line.length - i);
}

/**
 * Not content for the fade: whitespace, and box drawing / block elements (table borders, rules).
 * A growing table re-lays out its borders on every row; fading them would flash the whole table.
 */
const isSpace = (code: number) =>
	code === 32 || code === 9 || code === 0xa0 || code === 0x3000 || (code >= 0x2500 && code <= 0x259f);
const isImage = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

/** The visible content characters of one rendered line, concatenated. */
function visibleChars(line: string): string {
	if (isImage(line)) return "";
	let chars = "";
	for (let i = 0; i < line.length; ) {
		if (line[i] === ESC) {
			i += escapeLength(line, i);
			continue;
		}
		const code = line.codePointAt(i)!;
		const size = code > 0xffff ? 2 : 1;
		if (!isSpace(code)) chars += size === 1 ? line[i] : line.slice(i, i + 2);
		i += size;
	}
	return chars;
}

/** Visible content characters of rendered lines, and their UTF-16 count, per line. Fenced code has none. */
export function scan(lines: string[], paddingX = 0): FadeSegment {
	const chars: string[] = [];
	const after: boolean[] = [];
	let inCode = false;
	for (const line of lines) {
		const border = isFenceBorder(line, paddingX);
		chars.push(inCode || border ? "" : visibleChars(line));
		if (border) inCode = !inCode;
		after.push(inCode);
	}
	const counts = chars.map((c) => c.length);
	return { lines, counts, chars, after, births: [], youngFrom: Infinity, maxBirth: -Infinity };
}

const SGR_ANY = /\x1b\[[0-9;:]*m/g;

/** A rendered code fence border row (pi draws it as ```lang at the margin; code rows sit deeper). */
function isFenceBorder(line: string, paddingX: number): boolean {
	if (!line.includes("```")) return false;
	const plain = line.replace(SGR_ANY, "");
	return plain.startsWith("```", paddingX) && plain.slice(0, paddingX).trim() === "";
}

/** Scan results of the previous tail render's changed rows; rows that move are not re-scanned. */
export interface ScanMemo {
	lines: Map<string, string>;
}

/** Length of the common prefix of `a` and `b`, in UTF-16 units. */
function commonPrefix(a: string, b: string): number {
	// The common case, a growing text, is one native comparison.
	if (b.length >= a.length && b.startsWith(a)) return a.length;
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i + 256 <= max && b.startsWith(a.slice(i, i + 256), i)) i += 256;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

/** What `faint` needs beyond the births: the palette, the gradient's steps and the unit that fades. */
export interface FadeStyle {
	palette?: FadePalette;
	steps: number;
	granularity: "char" | "word";
	/** Text drawn in this foreground (inline code) shows at once, like streamdown's skipped `code`. */
	skipFg?: string;
	/** Text in this foreground before the first other text of a row (a list marker) shows at once. */
	skipLead?: string;
}

/** The foreground a run of text currently has, as the sequence that restores it and its color if known. */
interface Fg {
	seq: string;
	color?: Color;
}

const DEFAULT_FG = "\x1b[39m";

/** An ANSI palette color is the user's to define: only the 256-color cube and ramp are known. */
const known = (color: Color | undefined): color is Color =>
	!!color && !(color.kind === "indexed" && color.index < 16);

/** Fg, bold and faint state after one SGR sequence (extended color arguments skipped). */
function sgrState(params: string, state: { fg: Fg; bold: boolean; faint: boolean; base: Fg; fgChanged: boolean }): void {
	const parts = params === "" ? ["0"] : params.split(/[;:]/);
	for (let k = 0; k < parts.length; k++) {
		const p = parts[k]!;
		if (p === "38") {
			if (parts[k + 1] === "2") {
				state.fg = { seq: `\x1b[38;2;${parts[k + 2]};${parts[k + 3]};${parts[k + 4]}m`, color: rgbColor(+parts[k + 2]!, +parts[k + 3]!, +parts[k + 4]!) };
				k += 4;
			} else {
				state.fg = { seq: `\x1b[38;5;${parts[k + 2]}m`, color: indexedColor(+parts[k + 2]!) };
				k += 2;
			}
			state.fgChanged = true;
		} else if (p === "48" || p === "58") k += parts[k + 1] === "5" ? 2 : 4;
		else if (p === "0" || p === "") {
			state.fg = state.base;
			state.bold = false;
			state.faint = false;
			state.fgChanged = true;
		} else if (p === "39") {
			state.fg = state.base;
			state.fgChanged = true;
		} else if (p === "22") {
			state.bold = false;
			state.faint = false;
		} else if (p === "1") state.bold = true;
		else if (p === "2") state.faint = true;
		else if (/^(3[0-7]|9[0-7])$/.test(p)) {
			const n = +p;
			state.fg = { seq: `\x1b[${p}m`, color: indexedColor(n >= 90 ? n - 90 + 8 : n - 30) };
			state.fgChanged = true;
		}
	}
}

const gradientCache = new Map<string, string>();

/** CSS `cubic-bezier(x1, 0, x2, 1)` at time `t` (streamdown's fade curve), by bisection on x. */
function easeInOut(t: number, x1 = 0.33, x2 = 0.67): number {
	const bez = (s: number, a: number, b: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, x1, x2) < t) lo = mid;
		else hi = mid;
	}
	return bez((lo + hi) / 2, 0, 1);
}

/**
 * SGR of `color` at gradient `step` of `steps`, mixed from the palette's background: opacity 0 → 1
 * on streamdown's curve, so a new char starts invisible and eases in. Cached.
 */
function gradientSgr(fg: Fg, step: number, steps: number, palette: FadePalette): string | undefined {
	if (!palette.from || !known(fg.color)) return undefined;
	const key = `${fg.seq}|${step}|${steps}|${palette.mode}|${JSON.stringify(palette.from)}`;
	let sgr = gradientCache.get(key);
	if (sgr === undefined) {
		const rise = easeInOut(step / steps);
		const mixed = mixColors(palette.from, fg.color, rise, "srgb");
		const { r, g, b } = colorToRgb(mixed);
		sgr = foregroundAnsi(rgbColor(r, g, b), palette.mode);
		if (gradientCache.size > 2048) gradientCache.clear();
		gradientCache.set(key, sgr);
	}
	return sgr;
}

const wordSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : undefined;

/**
 * Births with every word's chars carrying the word's first birth, so a word fades as one unit and
 * chars that join it later take its current step (streamdown's word spans). Words are split like
 * streamdown's (`Intl.Segmenter`: CJK by word, punctuation on its own).
 */
function wordBirths(line: string, births: readonly number[], index: number): number[] {
	let plain = "";
	for (let i = 0; i < line.length; ) {
		if (line[i] === ESC) i += escapeLength(line, i);
		else plain += line[i++];
	}
	const segments = wordSegmenter ? Array.from(wordSegmenter.segment(plain), (s) => s.segment) : (plain.match(/\s+|\S+/g) ?? []);
	const out: number[] = [];
	for (const segment of segments) {
		let first: number | undefined;
		for (const ch of segment) {
			if (isSpace(ch.codePointAt(0)!)) continue;
			first ??= births[index + out.length]!;
			for (let u = 0; u < ch.length; u++) out.push(first);
		}
	}
	return out;
}

/**
 * Draw the characters of `line` born less than `fadeMs` ago in their fade; births start at `index`.
 * With a palette a char rises from the background to its own color in `steps` steps (true color);
 * a char of unknown color, or no palette, is drawn faint (SGR 2) until it settles.
 */
export function faint(
	line: string,
	births: readonly number[],
	index: number,
	now: number,
	fadeMs: number,
	style?: FadeStyle,
): string {
	const palette = style?.palette;
	const skipFg = style?.skipFg;
	const skipLead = style?.skipLead;
	let leading = true;
	const steps = Math.max(1, style?.steps ?? 1);
	const base: Fg = { seq: DEFAULT_FG, color: palette?.base };
	const state = { fg: base, bold: false, faint: false, base, fgChanged: false };
	const local = style?.granularity === "word" ? wordBirths(line, births, index) : undefined;
	let at = local ? 0 : index;
	const table = local ?? births;
	let out = "";
	/** The override on screen: faint, or a gradient color. */
	let active: { kind: "faint" | "color"; seq: string } | undefined;

	const leave = () => {
		if (!active) return;
		if (active.kind === "faint") out += state.bold ? "\x1b[22m\x1b[1m" : "\x1b[22m";
		else out += state.fg.seq;
		active = undefined;
	};
	const enter = (kind: "faint" | "color", seq: string) => {
		if (active?.kind === kind && active.seq === seq) return;
		// Leaving a faint run for a color (or the reverse) restores first; a new step just recolors.
		if (active && active.kind !== kind) leave();
		out += seq;
		active = { kind, seq };
	};

	for (let i = 0; i < line.length; ) {
		if (line[i] === ESC) {
			const length = escapeLength(line, i);
			const code = line.slice(i, i + length);
			out += code;
			if (line[i + 1] === "[" && code.endsWith("m")) {
				state.fgChanged = false;
				const before = state.faint;
				sgrState(code.slice(2, -1), state);
				// The terminal's own fg / intensity just changed: an override of that kind is gone.
				if (state.fgChanged && active?.kind === "color") active = undefined;
				if (before && !state.faint && active?.kind === "faint") active = undefined;
				// Re-assert faint: a reset or intensity change inside the run would cancel it.
				if (active?.kind === "faint") out += "\x1b[2m";
			}
			i += length;
			continue;
		}
		const cp = line.codePointAt(i)!;
		const size = cp > 0xffff ? 2 : 1;
		if (!isSpace(cp)) {
			const age = now - table[at]!;
			at += size;
			const marker: boolean = leading && !!skipLead && state.fg.seq === skipLead;
			leading = marker;
			if (age >= fadeMs || marker || (skipFg && state.fg.seq === skipFg)) leave();
			else {
				const step = Math.min(steps - 1, Math.floor((Math.max(0, age) / fadeMs) * steps));
				const sgr = palette ? gradientSgr(state.fg, step, steps, palette) : undefined;
				if (sgr) enter("color", sgr);
				else enter("faint", "\x1b[2m");
			}
		}
		out += line.slice(i, i + size);
		i += size;
	}
	leave();
	return out;
}
