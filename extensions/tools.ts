/**
 * Tool rows in the dreamwalker chrome: a verb and its target, one summary line under it, no shell.
 *
 *   Read extensions/index.ts
 *     ↳ 212 lines
 *   Edit src/cart/total.ts
 *     ↳ +12 -4
 *       <diff>
 *   Execute pnpm test
 *     ↳ ✓ 41 ✕ 3 · 6.1s
 *       <output>
 *
 * A renderer resolver keeps each tool's own `renderCall` / `renderResult` and only swaps pi's
 * colored shell: the call row is rebuilt from the tool's name and arguments, the rows its renderer
 * drew beneath that line stay folded until ctrl+o (a diff is the exception), and the result's
 * output hangs below, indented. Tools that already draw their own frame (`renderShell: "self"`)
 * are left alone, except pi's `edit`: its status-colored card is dropped so the diff hangs off the
 * same row (a full-width tinted card is what terminals such as Rex, with "Match program
 * backgrounds", take for the app background and paint across the whole pane).
 */
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";
import { rowRule } from "./line.ts";
import { formatShortDuration, oneLine } from "./format.ts";
import { humanizeToolLabel, toolCallSummary } from "./names.ts";
import { flashStep, isLit, startFlash } from "./signal.ts";
import { summarizeResult, type ToolSummary } from "./summary.ts";
import { fastHighlightReady } from "./highlight.ts";
import { fastReadResult } from "./read-highlight.ts";
import { highlightCommand, SHELL_TOOLS, shellCallComponent } from "./shell-highlight.ts";

export type ToolStatus = "pending" | "running" | "done" | "error";

export function toolStatus(context: {
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
}): ToolStatus {
	if (!context.isPartial) return context.isError ? "error" : "done";
	return context.executionStarted ? "running" : "pending";
}

/** Renderer state a tool's call and result rows (and its group card) share. */
export interface DreamState {
	dreamStartedAt?: number;
	/** The finished result's one-glance summary, computed once per result (`undefined` summary: nothing to show). */
	dreamSummary?: { result: unknown; summary: ToolSummary | undefined };
	/** When this tool's failure flash began (shared by its call and result rows). */
	dreamFlashAt?: number;
}

/** What a frame learns from pi's render context beyond the status. */
export interface FrameMeta {
	callId?: string;
	state?: DreamState;
	/** The tool ran live in this session (not rebuilt from history): only then does a failure flash. */
	live?: boolean;
	/** Call frames: the tool and its arguments (the row is rebuilt from them), and whether ctrl+o opened the rows below it. */
	toolName?: string;
	args?: unknown;
	expanded?: boolean;
}

const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

const VERBS: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	multi_edit: "Edit",
	apply_patch: "Patch",
	bash: "Execute",
	grep: "Grep",
	find: "Find",
	ls: "List",
};

/** `Read`, `Execute`, `Web Search`: what the tool does, as the call row's first word. */
export function toolVerb(toolName: string): string {
	return VERBS[toolName] ?? humanizeToolLabel(toolName.includes("__") ? toolName.split("__").pop()! : toolName);
}

/** The first line of a shell call's command, and whether more lines follow. */
function shellHead(toolName: string, args: unknown): { head: string; more: boolean } | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	if (!(toolName in SHELL_TOOLS) || typeof command !== "string") return undefined;
	const lines = command.split("\n").filter((line) => line.trim());
	return { head: oneLine(lines[0] ?? ""), more: lines.length > 1 };
}

/** The call row's target: a path, a pattern, the first line of a command (`…` when more follow). */
export function toolTarget(toolName: string, args: unknown): string {
	const shell = shellHead(toolName, args);
	if (shell) return shell.more ? `${shell.head} …` : shell.head;
	const summary = toolCallSummary(toolName, args);
	return summary.startsWith(toolName) ? summary.slice(toolName.length).trimStart() : summary;
}

/** Wraps a renderer's component. Output is cached per width and input. */
export class ToolFrame implements Component {
	inner: Component | undefined;
	private status: ToolStatus = "pending";
	private durationMs: number | undefined;
	private indent = 0;
	private callId: string | undefined;
	private state: DreamState | undefined;
	private flashAt = 0;
	private cacheSummary: ToolSummary | undefined;
	private meta: FrameMeta | undefined;

	private cacheWidth = -1;
	private cacheInner: string[] | undefined;
	private cacheKey = "";
	private cached: string[] = [];
	/** Inner rows dropped above the output (blank padding meant for pi's background shell). */
	private skipped = 0;
	/** 1 when a hairline row sits above the output rows. */
	private ruled = 0;

	private readonly kind: "call" | "result";
	/** Call frames only: rows below the call line are output (edit's diff), always drawn. */
	private readonly bodyShown: boolean;
	private theme: Theme | undefined;

	constructor(kind: "call" | "result", options: { bodyShown?: boolean } = {}) {
		this.kind = kind;
		this.bodyShown = options.bodyShown ?? false;
	}

	/** `theme` is the one pi passes to the renderer: the live theme, also during /reload. */
	update(
		inner: Component,
		theme: Theme,
		status: ToolStatus,
		durationMs: number | undefined,
		indent: number,
		meta?: FrameMeta,
	): this {
		if (status === "error" && this.status !== "error" && DREAMWALKER.features.runSignal && (this.status === "running" || meta?.live)) {
			// One flash per failed tool, shared by its call and result rows.
			const shared = meta?.state;
			this.flashAt = shared ? (shared.dreamFlashAt ??= startFlash()) : startFlash();
		}
		this.callId = meta?.callId;
		this.state = meta?.state;
		this.meta = meta;
		this.inner = inner;
		this.theme = theme;
		this.status = status;
		this.durationMs = durationMs;
		this.indent = indent;
		return this;
	}

	/** Columns before the output rows: the row's indent and the `↳` column. */
	private get prefixWidth(): number {
		return this.indent + 2;
	}

	render(width: number): string[] {
		const inner = this.inner;
		const t = this.theme;
		if (!inner || !t) return [];
		const innerWidth = Math.max(1, width - this.prefixWidth);
		const showBody = this.kind === "result" || this.bodyShown || !!this.meta?.expanded;
		// A call's own rows are never drawn while folded, so they are not even laid out.
		const lines = showBody ? inner.render(innerWidth) : NO_LINES;
		const marks = DREAMWALKER.features.runSignal;
		const step = marks ? flashStep(this.flashAt) : -1;
		const summary = this.kind === "call" ? this.state?.dreamSummary?.summary : undefined;
		const head = this.kind === "call" && this.meta?.toolName ? toolTarget(this.meta.toolName, this.meta.args) : "";
		const key = `${this.status}|${this.durationMs ?? ""}|${this.indent}|${step}|${this.meta?.expanded ?? ""}|${head}`;
		if (width === this.cacheWidth && lines === this.cacheInner && key === this.cacheKey && summary === this.cacheSummary) {
			return this.cached;
		}

		const pad = " ".repeat(this.indent);
		const body = " ".repeat(this.prefixWidth);
		let out: string[] = [];
		if (this.kind === "call") {
			const verb = t.bold(t.fg("accent", toolVerb(this.meta?.toolName ?? "tool")));
			out.push(truncateToWidth(`${pad}${verb}${head ? ` ${this.target(t, head)}` : ""}`, width, "…"));
			const line = this.summaryLine(t, summary, step);
			if (line) out.push(`${pad}  ${line}`);
			if (showBody) {
				// The rows under the tool's own call line, without the blank spacer rows around them.
				let start = 1;
				let end = lines.length;
				while (start < end && isBlank(lines[start] ?? "")) start++;
				while (end > start && isBlank(lines[end - 1] ?? "")) end--;
				for (let i = start; i < end; i++) out.push(body + lines[i]);
			}
		} else {
			// Renderers written for pi's padded shell often start/end with blank rows.
			let start = 0;
			let end = lines.length;
			while (start < end && isBlank(lines[start] ?? "")) start++;
			while (end > start && isBlank(lines[end - 1] ?? "")) end--;
			// pi's shell result closes with `Took 1.2s`; the summary line carries the duration.
			if (end > start && TOOK.test(plain(lines[end - 1] ?? ""))) {
				end--;
				while (end > start && isBlank(lines[end - 1] ?? "")) end--;
			}
			this.skipped = start;
			// A hairline parts the output from the call row above it.
			const rule = end > start && width > 2 ? [rowRule(t, width)] : [];
			this.ruled = rule.length;
			out = rule;
			for (let i = start; i < end; i++) out.push(body + lines[i]);
		}

		this.cacheWidth = width;
		this.cacheInner = lines;
		this.cacheKey = key;
		this.cacheSummary = summary;
		this.cached = out;
		return out;
	}

	/** The target as shown: a command's first line is syntax-highlighted (one line: cheap while args stream). */
	private target(t: Theme, plainTarget: string): string {
		const shell = this.meta?.toolName ? shellHead(this.meta.toolName, this.meta.args) : undefined;
		if (!shell?.head || !DREAMWALKER.features.shellHighlight) return plainTarget;
		const text = highlightCommand(shell.head, t)[0] ?? shell.head;
		return shell.more ? `${text} ${t.fg("dim", "…")}` : text;
	}

	/**
	 * `↳ +12 -4 · 0.4s`: the result summary, then the duration once it passes a second. A failed tool
	 * always has one, its `↳` in the error color (blinking while its flash runs). Empty while the tool
	 * runs, so a quick call stays one row.
	 */
	private summaryLine(t: Theme, summary: ToolSummary | undefined, step: number): string {
		const g = DREAMWALKER.glyph;
		const failed = this.status === "error";
		if (!DREAMWALKER.features.resultLine || this.status === "pending" || this.status === "running") return "";
		const duration = this.durationMs !== undefined && this.durationMs >= 1000 ? formatShortDuration(this.durationMs) : "";
		const text = resultLabel((color, part) => t.fg(color, part), summary, duration) || (failed ? t.fg("error", "failed") : "");
		if (!text) return "";
		let mark = t.fg(failed ? "error" : "dim", g.result);
		if (failed && isLit(step)) mark = `${REVERSE_ON}${mark}${REVERSE_OFF}`;
		return `${mark} ${text}`;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const prefix = this.prefixWidth;
		if (this.kind === "call" || !this.inner?.handleMouse || event.x < prefix) return undefined;
		return this.inner.handleMouse({
			...event,
			x: event.x - prefix,
			y: event.y + this.skipped - this.ruled,
			width: Math.max(1, event.width - prefix),
		});
	}

	invalidate(): void {
		this.cacheWidth = -1;
		this.cacheInner = undefined;
		this.inner?.invalidate();
	}
}

const NO_LINES: string[] = [];
const SGR = /\x1b\[[0-9;:]*m/g;
const TOOK = /^Took \d/;

const plain = (line: string): string => line.replace(SGR, "").trim();

function isBlank(line: string): boolean {
	return plain(line) === "";
}

type Paint = (color: "success" | "error" | "dim", text: string) => string;

/** The summary parts, then the duration (` · `), the secondary part dim. */
export function resultLabel(fg: Paint, summary: ToolSummary | undefined, duration: string): string {
	const parts: string[] = [];
	if (summary) {
		for (const part of summary.parts) parts.push(fg(part.tone === "ok" ? "success" : part.tone === "bad" ? "error" : "dim", part.text));
	}
	const text = parts.join(" ");
	if (!duration) return text;
	return text ? `${text}${fg("dim", ` ${DREAMWALKER.glyph.separator.trim()} ${duration}`)}` : fg("dim", duration);
}

function textOutput(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	if (!result.content) return "";
	let out = "";
	for (const part of result.content) if (part.type === "text" && part.text) out += (out ? "\n" : "") + part.text;
	return out.replace(/\s+$/, "");
}

function fallbackResult(
	result: { content?: ReadonlyArray<{ type: string; text?: string }> },
	expanded: boolean,
	theme: Theme,
): Component {
	const output = textOutput(result);
	if (!output) return new Text("", 0, 0);
	const lines = output.split("\n");
	const limit = DREAMWALKER.fallbackPreviewLines;
	const shown = expanded ? lines : lines.slice(0, limit);
	let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (lines.length > shown.length) text += `\n${theme.fg("dim", `… ${lines.length - shown.length} more lines`)}`;
	return new Text(text, 0, 0);
}

type BoxLike = Component & {
	setBgFn(fn: ((text: string) => string) | undefined): void;
	setPaddingX(padding: number): void;
	paddingY: number;
};

const UNBOXED = new WeakSet<object>();

/**
 * Turns pi's edit card (a pi-tui Box it rebuilds with a status background and padding on every
 * update) into plain rows. Duck-typed: pi's bundle may carry its own copy of the Box class.
 */
function unbox(component: Component): void {
	const box = component as Partial<BoxLike>;
	if (UNBOXED.has(component) || typeof box.setBgFn !== "function" || typeof box.setPaddingX !== "function") return;
	UNBOXED.add(component);
	box.setBgFn(undefined);
	box.paddingY = 0;
	box.setPaddingX(0);
	box.setBgFn = () => {};
	box.setPaddingX = () => {};
}

/** Self-framed tools whose frame is a background card this package replaces with plain rows. */
const UNBOX_TOOLS = new Set(["edit"]);

export function createToolRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers | undefined {
	const unboxed = base?.renderShell === "self" && UNBOX_TOOLS.has(toolName) && DREAMWALKER.features.unboxEdit;
	if (base?.renderShell === "self" && !unboxed) return base;
	const baseCall = base?.renderCall;
	const baseResult = base?.renderResult;

	return {
		...base,
		renderShell: "self",
		renderCall(args, callTheme, context) {
			// Stamp the execution start on rendererState so the group card can show durations even
			// though this tool is folded inside a group (its own card never draws a header row there).
			const state = context.state as DreamState | undefined;
			if (context.executionStarted && state && state.dreamStartedAt === undefined) {
				state.dreamStartedAt = Date.now();
			}
			const frame =
				context.lastComponent instanceof ToolFrame
					? context.lastComponent
					: new ToolFrame("call", { bodyShown: unboxed });
			let inner: Component;
			const shell = toolName in SHELL_TOOLS;
			try {
				// Shell tools: pi's renderer still runs (it starts the elapsed timer), but on a
				// throwaway component, so the highlighted text is never overwritten with plain text.
				inner = baseCall
					? baseCall(args, callTheme, { ...context, lastComponent: shell ? undefined : frame.inner })
					: new Text("", 0, 0);
				// With pi's highlighter, only once the command is final: every streamed delta would be
				// O(n²). The fast highlighter re-lexes only changed lines, so it runs live.
				const settledArgs =
					context.argsComplete || context.executionStarted || !context.isPartial || fastHighlightReady();
				if (shell && settledArgs && DREAMWALKER.features.shellHighlight) {
					inner = shellCallComponent(toolName, args, callTheme, frame.inner) ?? inner;
				}
				if (unboxed) unbox(inner);
			} catch {
				inner = new Text("", 0, 0);
			}
			return frame.update(
				inner,
				callTheme,
				toolStatus(context),
				context.durationMs,
				context.outputPad + DREAMWALKER.bodyIndent,
				{
					callId: context.toolCallId,
					state: context.state as DreamState | undefined,
					live: context.executionStarted,
					toolName,
					args,
					expanded: context.expanded,
				},
			);
		},
		renderResult(result, options, resultTheme, context) {
			const frame = context.lastComponent instanceof ToolFrame ? context.lastComponent : new ToolFrame("result");
			let inner: Component;
			try {
				const fast =
					toolName === "read" && baseResult && DREAMWALKER.features.fastHighlight
						? fastReadResult(baseResult, result, options, resultTheme, context, frame.inner)
						: undefined;
				inner =
					fast ??
					(baseResult
						? baseResult(result, options, resultTheme, { ...context, lastComponent: frame.inner })
						: fallbackResult(result, options.expanded, resultTheme));
			} catch {
				inner = fallbackResult(result, options.expanded, resultTheme);
			}
			// The call row (and the group card) read this to fill their right-hand column.
			const state = context.state as DreamState | undefined;
			if (state && DREAMWALKER.features.resultLine && !context.isPartial && state.dreamSummary?.result !== result) {
				state.dreamSummary = { result, summary: summarizeResult(toolName, context.args, result, context.isError, DREAMWALKER.glyph) };
			}
			return frame.update(
				inner,
				resultTheme,
				toolStatus(context),
				undefined,
				context.outputPad + DREAMWALKER.bodyIndent,
				{ callId: context.toolCallId, state, live: context.executionStarted },
			);
		},
	};
}
