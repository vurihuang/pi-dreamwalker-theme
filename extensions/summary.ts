/**
 * One-glance results for the right-hand column of a tool row, after Aphelion's event stream:
 *
 *   ● edit src/cart/total.ts                                  +12 -4  0.4s
 *   ● $ pnpm test                                             ✓ 41 ✕ 3  6.1s
 *   ● read extensions/index.ts                                212 lines  0.1s
 *
 * Pure functions of the finished result, computed once per result (the caller caches by result
 * identity). Everything is bounded: the diff is counted line by line once, a test summary is read from
 * the last 1.2 KB of output.
 */
export type SummaryTone = "ok" | "bad" | "dim";

export interface SummaryPart {
	text: string;
	tone: SummaryTone;
}

export interface ToolSummary {
	parts: SummaryPart[];
}

interface ResultLike {
	content?: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
}

export interface SummaryGlyphs {
	pass: string;
	fail: string;
}

const TEST_COMMAND = /\b(?:test|tests|jest|vitest|pytest|mocha|tap|ava|rspec|phpunit)\b/i;
const TAIL = 1200;

function text(result: ResultLike): string {
	let out = "";
	for (const part of result.content ?? []) if (part.type === "text" && part.text) out += (out ? "\n" : "") + part.text;
	return out;
}

/** Lines in `value`, counting a last line without a trailing newline. */
export function countLines(value: string): number {
	if (!value) return 0;
	let n = 1;
	for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) n++;
	return value.endsWith("\n") ? n - 1 : n;
}

/** Added and removed lines of pi's display diff (`+12 text` / `-13 text` per line). */
export function diffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	let at = 0;
	while (at < diff.length) {
		const c = diff.charCodeAt(at);
		if (c === 43) added++; // +
		else if (c === 45) removed++; // -
		const next = diff.indexOf("\n", at);
		if (next === -1) break;
		at = next + 1;
	}
	return { added, removed };
}

function last(tail: string, pattern: RegExp): number | undefined {
	let value: number | undefined;
	for (const match of tail.matchAll(pattern)) value = Number(match[1]);
	return value;
}

/** Passed / failed counts from the end of a test runner's output (jest, vitest, pytest, node:test, cargo). */
export function testCounts(output: string): { passed?: number; failed?: number } {
	const tail = output.slice(-TAIL);
	const passed = last(tail, /(\d+)\s+(?:passed|passing)\b/gi) ?? last(tail, /\bpass\s+(\d+)\b/gi);
	const failed = last(tail, /(\d+)\s+(?:failed|failing)\b/gi) ?? last(tail, /\bfail\s+(\d+)\b/gi);
	return { passed, failed };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summarizeResult(
	toolName: string,
	args: unknown,
	result: ResultLike | undefined,
	isError: boolean,
	glyphs: SummaryGlyphs,
): ToolSummary | undefined {
	if (!result) return undefined;
	const input = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "edit": {
			const diff = (result.details as { diff?: unknown } | undefined)?.diff;
			if (typeof diff !== "string") return undefined;
			const { added, removed } = diffStat(diff);
			if (!added && !removed) return undefined;
			return { parts: [{ text: `+${added}`, tone: "ok" }, { text: `-${removed}`, tone: "bad" }] };
		}
		case "write": {
			if (isError || typeof input.content !== "string") return undefined;
			return { parts: [{ text: `+${countLines(input.content)}`, tone: "ok" }] };
		}
		case "read": {
			if (isError) return undefined;
			const body = text(result);
			if (!body) return undefined;
			// pi's truncation notice names the real size: `[Showing lines 1-2000 of 5400. ...]`.
			const shown = /\[Showing lines \d+-\d+ of (\d+)/.exec(body.slice(-300));
			const lines = shown ? Number(shown[1]) : countLines(body);
			return { parts: [{ text: plural(lines, "line"), tone: "dim" }] };
		}
		case "grep":
		case "find":
		case "ls": {
			if (isError) return undefined;
			const body = text(result);
			const kind = toolName === "grep" ? ["match", "matches"] : toolName === "find" ? ["file", "files"] : ["entry", "entries"];
			if (!body || /^No /i.test(body)) return { parts: [{ text: `0 ${kind[1]}`, tone: "dim" }] };
			let n = 0;
			for (const line of body.split("\n")) if (line && line[0] !== "[") n++;
			return { parts: [{ text: plural(n, kind[0]!, kind[1]), tone: "dim" }] };
		}
		case "bash": {
			const command = typeof input.command === "string" ? input.command : "";
			const body = text(result);
			if (TEST_COMMAND.test(command)) {
				const { passed, failed } = testCounts(body);
				const parts: SummaryPart[] = [];
				if (passed !== undefined) parts.push({ text: `${glyphs.pass} ${passed}`, tone: "ok" });
				if (failed) parts.push({ text: `${glyphs.fail} ${failed}`, tone: "bad" });
				if (parts.length) return { parts };
			}
			if (isError) {
				const code = /Command exited with code (\d+)/.exec(body.slice(-200));
				if (code) return { parts: [{ text: `exit ${code[1]}`, tone: "bad" }] };
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/** Visible text of a summary, for cache keys and tests. */
export const summaryText = (summary: ToolSummary | undefined): string => summary?.parts.map((p) => p.text).join(" ") ?? "";
