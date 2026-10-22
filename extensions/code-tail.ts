/**
 * An open fenced code block at the end of a streaming message, rendered line by line.
 *
 * pi's `Markdown` re-renders a growing code block in full on every update: it highlights the whole
 * block and wraps every line (ANSI-aware, the dominant cost: ~17 ms per paint for 64 KB). While the
 * open tail of a streaming message is
 *
 *     <head: blocks ending in a blank line>  ```lang  <code, no closing fence yet>
 *
 * the head is rendered by its own cached `Markdown` (its text no longer changes), and the code is
 * rendered here exactly as pi's code token would be (border, indent, highlighted lines, closing
 * border, then per-line wrap, margins, and padding), with each line's wrapped rows cached by its
 * highlighted text. pi wraps rendered lines one by one, so caching per line is exact. With the
 * incremental highlighter only the last lines change, so a paint costs O(changed lines).
 *
 * Anything this does not model exactly (indented or nested fences, info strings with escapes,
 * markdown transformers, backgrounds, vertical padding, raw escapes in the code) returns undefined, and the
 * caller renders the whole tail with pi's `Markdown`.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface OpenFence {
	/** Text before the fence: empty, or ending in a blank line. */
	head: string;
	marker: string;
	lang: string;
	/** The code as pi's lexer sees it (trailing newline and partial closing fence trimmed). */
	text: string;
}

const OPENER = /^(`{3,}|~{3,})([^\n]*)$/gm;
const SIMPLE_INFO = /^[\w+#.-]*$/;
/** Closing-fence patterns by opening marker; a stream reuses one marker for many paints. */
const closers = new Map<string, RegExp>();

function closer(marker: string): RegExp {
	let close = closers.get(marker);
	if (!close) {
		close = new RegExp(`^ {0,3}${marker}[~\`]* *$`, "m");
		if (closers.size >= 32) closers.clear();
		closers.set(marker, close);
	}
	return close;
}

/** The open fence ending `source` (tabs already expanded), or undefined. */
export function openFence(source: string): OpenFence | undefined {
	let start = -1;
	let match: RegExpExecArray | null = null;
	OPENER.lastIndex = 0;
	for (let m = OPENER.exec(source); m; m = OPENER.exec(source)) {
		if (m.index === 0 || source.startsWith("\n\n", m.index - 2)) {
			start = m.index;
			match = m;
		}
	}
	if (!match) return undefined;
	const marker = match[1]!;
	const info = match[2]!.trim();
	if (!SIMPLE_INFO.test(info) || (marker[0] === "`" && match[2]!.includes("`"))) return undefined;
	const openerEnd = start + match[0].length;
	const body = openerEnd < source.length ? source.slice(openerEnd + 1) : "";
	if (closer(marker).test(body) || body.includes("\x1b")) return undefined;
	let text = body.endsWith("\n") ? body.slice(0, -1) : body;
	// pi's trimPartialClosingFences: a last line of fence chars shorter than the marker.
	const lastLine = source.slice(Math.max(start, source.lastIndexOf("\n") + 1));
	if (lastLine && lastLine.length < marker.length && lastLine === marker[0]!.repeat(lastLine.length)) {
		text = text.slice(0, -lastLine.length).replace(/\n$/, "");
	}
	return { head: source.slice(0, start), marker, lang: info, text };
}

/** The pi `MarkdownTheme` fields a code token reads. */
export interface CodeTheme {
	codeBlockBorder(text: string): string;
	codeBlock(text: string): string;
	codeBlockIndent?: string;
	highlightCode?: (code: string, lang?: string) => string[];
}

/** Renders the code of an open fence; each line's rows are cached by its text and width. */
export class CodeTailRenderer {
	private width = -1;
	private rows = new Map<string, string[]>();

	/** Drop cached rows (theme change: the border rows are keyed by text, not color). */
	clear(): void {
		this.rows.clear();
		this.width = -1;
	}

	render(fence: OpenFence, theme: CodeTheme, paddingX: number, width: number): string[] {
		const indent = theme.codeBlockIndent ?? "  ";
		const code = theme.highlightCode
			? theme.highlightCode(fence.text, fence.lang)
			: fence.text.split("\n").map((line) => theme.codeBlock(line));
		if (width !== this.width) {
			this.width = width;
			this.rows.clear();
		}
		const previous = this.rows;
		const next = new Map<string, string[]>();
		const contentWidth = Math.max(1, width - paddingX * 2);
		const margin = " ".repeat(paddingX);
		const out: string[] = [];
		const emit = (key: string, line: () => string) => {
			let rows = previous.get(key) ?? next.get(key);
			if (!rows) {
				rows = [];
				for (const wrapped of wrapTextWithAnsi(line(), contentWidth)) {
					const withMargins = margin + wrapped + margin;
					rows.push(withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins))));
				}
			}
			next.set(key, rows);
			for (const row of rows) out.push(row);
		};
		const open = `\u0000open:${fence.lang}`;
		emit(open, () => theme.codeBlockBorder(`\`\`\`${fence.lang}`));
		for (const line of code) emit(line, () => `${indent}${line}`);
		emit("\u0000close", () => theme.codeBlockBorder("```"));
		this.rows = next;
		return out;
	}
}
