/**
 * Syntax-highlighted bash call line:
 *
 *   $ cd repo && cat > tests/a.test.ts <<'EOF'     ← bash
 *   import assert from "node:assert/strict";       ← typescript (from the redirect target)
 *   EOF                                            ← bash
 *
 * pi's shell renderer draws the whole command as one bold `toolTitle` string. This keeps pi's
 * renderer for its side effects (the elapsed-time state), then swaps the displayed text for one that
 * is highlighted with the theme's `syntax*` tokens (`highlight.ts`, falling back to pi's own
 * `highlightCode`). Heredoc bodies are highlighted in the language implied by their redirect target
 * or interpreter.
 *
 * Cost model: with the fast highlighter, a large heredoc body goes through an incremental session,
 * so a streamed delta re-lexes only its last lines and the call line is highlighted live while args
 * stream. With pi's highlighter (about 0.35 ms per KB, O(n²) over a stream: ~2 s for a 20 KB
 * heredoc) the caller only highlights once the args are complete. Either way a cache per theme and
 * command makes the 1 s timer ticks and partial results cost a lookup, and an unchanged text keeps
 * the Text's wrap cache.
 */
import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { fastHighlight, fastHighlightReady } from "./highlight.ts";
import { LineText } from "./line.ts";

const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
const REDIRECT = /(?:>>?|\btee(?:\s+-a)?)\s*['"]?([^\s'";|&<>()]+)/g;
const INTERPRETERS: [RegExp, string][] = [
	[/\b(?:python3?|uv run|pypy3?)\b/, "python"],
	[/\b(?:tsx|ts-node)\b/, "typescript"],
	[/\b(?:node|bun|deno)\b/, "javascript"],
	[/\bruby\b/, "ruby"],
	[/\bperl\b/, "perl"],
	[/\bphp\b/, "php"],
	[/\blua\b/, "lua"],
	[/\b(?:psql|mysql|sqlite3|duckdb)\b/, "sql"],
	[/\b(?:bash|sh|zsh)\b/, "bash"],
];

/** Language of a heredoc body, from the line that opens it. */
export function heredocLanguage(line: string): string | undefined {
	const head = line.slice(0, line.search(HEREDOC));
	let target: string | undefined;
	for (const match of head.matchAll(REDIRECT)) target = match[1];
	if (target && target !== "/dev/null") {
		const lang = getLanguageFromPath(target);
		if (lang) return lang;
	}
	for (const [pattern, lang] of INTERPRETERS) if (pattern.test(head)) return lang;
	return undefined;
}

type Segment = { lang: string | undefined; lines: string[] };

/** Splits a command into shell chunks and heredoc bodies. An unterminated body runs to the end. */
export function splitHeredocs(command: string): Segment[] {
	const segments: Segment[] = [];
	let shell: string[] = [];
	const lines = command.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		shell.push(line);
		const open = HEREDOC.exec(line);
		if (!open) continue;
		const stripTabs = open[1] === "-";
		const delimiter = open[3]!;
		const body: string[] = [];
		let j = i + 1;
		while (j < lines.length && (stripTabs ? lines[j]!.replace(/^\t+/, "") : lines[j]) !== delimiter) {
			body.push(lines[j]!);
			j++;
		}
		segments.push({ lang: "bash", lines: shell });
		shell = [];
		if (body.length) segments.push({ lang: heredocLanguage(line), lines: body });
		i = j - 1; // the delimiter line (if any) starts the next shell chunk
	}
	if (shell.length) segments.push({ lang: "bash", lines: shell });
	return segments;
}

/** Highlights each segment; `theme` enables the fast highlighter (pi's global theme otherwise). */
export function highlightCommand(command: string, theme?: Theme): string[] {
	const out: string[] = [];
	for (const segment of splitHeredocs(command)) {
		const code = segment.lines.join("\n");
		out.push(...((theme && fastHighlight(code, segment.lang, theme)) ?? highlightCode(code, segment.lang)));
	}
	return out;
}

/** Commands above this size are shown plain: one highlight pass would block the UI too long. */
export const MAX_HIGHLIGHT_CHARS = 64 * 1024;
/** The same limit for the fast highlighter (512 KB: ~13 ms for one full pass). */
export const MAX_FAST_HIGHLIGHT_CHARS = 512 * 1024;

type Entry = { prompt: string; timeout: unknown; text: string };
const cache = new WeakMap<Theme, Map<string, Entry>>();
const CACHE_LIMIT = 32;

function highlighted(theme: Theme, prompt: string, command: string, timeout: unknown): string {
	let entries = cache.get(theme);
	if (!entries) cache.set(theme, (entries = new Map()));
	const hit = entries.get(command);
	if (hit && hit.prompt === prompt && hit.timeout === timeout) return hit.text;
	const max = fastHighlightReady() ? MAX_FAST_HIGHLIGHT_CHARS : MAX_HIGHLIGHT_CHARS;
	const lines =
		command.length > max ? command.split("\n").map((l) => theme.fg("toolTitle", l)) : highlightCommand(command, theme);
	const suffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	lines[0] = `${theme.fg("toolTitle", theme.bold(prompt))} ${lines[0] ?? ""}`;
	lines[lines.length - 1] += suffix;
	const text = lines.join("\n");
	if (entries.size >= CACHE_LIMIT) entries.delete(entries.keys().next().value as string);
	entries.set(command, { prompt, timeout, text });
	return text;
}

/** Shell tools whose call line is a single `command` string. */
export const SHELL_TOOLS: Record<string, string> = { bash: "$" };

/**
 * Highlighted replacement for a shell call component. It returns undefined when the args do not
 * hold a plain command string; the caller then keeps pi's own component.
 */
export function shellCallComponent(
	toolName: string,
	args: unknown,
	theme: Theme,
	last: Component | undefined,
): Component | undefined {
	const prompt = SHELL_TOOLS[toolName];
	const record = args as { command?: unknown; timeout?: unknown } | undefined;
	if (!prompt || typeof record?.command !== "string" || !record.command) return undefined;
	// LineText keeps each line's wrapped rows: while args stream only the last lines are re-wrapped,
	// and pi's 1 s elapsed timer (which invalidates the row) costs nothing.
	const text = last instanceof LineText ? last : new LineText();
	text.update(highlighted(theme, prompt, record.command, record.timeout));
	return text;
}
