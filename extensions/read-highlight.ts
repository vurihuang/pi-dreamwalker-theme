/**
 * Expanded `read` results highlighted with the fast highlighter.
 *
 * pi's read renderer highlights the whole file with highlight.js whenever an expanded result is
 * rendered (64 KB of TypeScript: ~11 ms). Its layout (trimmed trailing blank lines, tab expansion,
 * truncation notices, key hints) stays pi's: the renderer runs without a path, so it skips
 * highlighting, and with a theme whose `toolOutput` color records each body line and leaves a
 * placeholder. The recorded lines are then highlighted as one text (so lexer state carries across
 * lines, as in pi) and put back in place. Results are cached per theme and text.
 */
import { getLanguageFromPath, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { canHighlight, fastHighlight } from "./highlight.ts";
import { LineText } from "./line.ts";

type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type ResultContext = Parameters<RenderResult>[3];

const MARK = "\u0000dw:";
const PLACEHOLDER = /\u0000dw:(\d+)\u0000/g;
const CACHE_LIMIT = 8;
const cache = new WeakMap<Theme, Map<string, string>>();

function readPath(args: unknown): string | undefined {
	const record = args as { path?: unknown; file_path?: unknown } | undefined;
	const path = record?.file_path ?? record?.path;
	return typeof path === "string" && path ? path : undefined;
}

/**
 * Render a read result through pi's renderer with fast highlighting, or return undefined when the
 * fast path does not apply (collapsed, error, no language, highlighter unavailable).
 */
export function fastReadResult(
	base: RenderResult,
	result: Parameters<RenderResult>[0],
	options: Parameters<RenderResult>[1],
	theme: Theme,
	context: ResultContext,
	last: Component | undefined,
): Component | undefined {
	if (!options.expanded || context.isError) return undefined;
	const path = readPath(context.args);
	const lang = path ? getLanguageFromPath(path) : undefined;
	if (!lang || !canHighlight(lang)) return undefined;

	const body: string[] = [];
	const recorder = Object.create(theme) as Theme;
	recorder.fg = (color, text) => {
		if (color !== "toolOutput") return theme.fg(color, text);
		body.push(text);
		return `${MARK}${body.length - 1}\u0000`;
	};
	const args = { ...(context.args as object), path: undefined, file_path: undefined };
	const probe = base(result, options, recorder, { ...context, args, lastComponent: undefined } as ResultContext);
	const layout = (probe as unknown as { text?: unknown }).text;
	if (typeof layout !== "string") return undefined;

	const code = body.join("\n");
	let entries = cache.get(theme);
	if (!entries) cache.set(theme, (entries = new Map()));
	const key = `${lang}\u0000${layout}\u0000${code}`;
	let text = entries.get(key);
	if (text === undefined) {
		const lines = fastHighlight(code, lang, theme);
		if (!lines || lines.length !== body.length) return undefined;
		text = layout.replace(PLACEHOLDER, (_, i: string) => lines[Number(i)] ?? "");
		if (entries.size >= CACHE_LIMIT) entries.delete(entries.keys().next().value as string);
		entries.set(key, text);
	}
	const component = last instanceof LineText ? last : new LineText();
	component.update(text);
	return component;
}
