/**
 * Fold runs of three or more consecutive tool calls into one group card:
 *
 *   Read ×3 · 1 failed · ctrl+o                2.4s
 *     ↳ a.ts                                212 lines
 *     ↳ b.ts
 *       ENOENT: no such file
 *     ⠋ c.ts
 *
 * Two calls stay as two cards (a header would cost more rows than it saves). bash, edit, write and
 * apply_patch never fold: their output or diff is the point. A failed child shows its first error
 * line without expanding.
 *
 * pi has no hook that sees sibling tools, so the group is produced by intercepting
 * `Container.addChild`: when a groupable `ToolExecutionComponent` lands next to a groupable sibling
 * they are re-parented into a `ToolGroupComponent`. This is the *only* interception; nothing else on
 * the render path is touched, and the work per add is O(1) + a short backward scan for the previous
 * sibling.
 *
 * Expand reuses pi's own model instead of a parallel mouse layer: the group exposes `setExpanded()`,
 * so pi's `setToolsExpanded` (ctrl+o / "expand tools") expands and collapses it exactly like a native
 * tool card, and a `MouseRegion` on the header toggles it on click — the same pattern pi uses for a
 * tool result. Expanded renders each child's own component, so the open state is byte-for-byte pi.
 *
 * Performance:
 *  - A settled, collapsed group is rendered once and cached; cache keys include width, theme, child
 *    identity and child arg/result identity.
 *  - A pending group is never cached, so each frame redraws its spinner. While a child is pending, an
 *    80ms tick (pi's own running-tool cadence) only requests a frame. It never invalidates: that
 *    cascades into every child's `updateDisplay()` (renderCall + renderResult) and drops their caches.
 *  - The child components are never rebuilt; the group borrows them and renders them directly, so
 *    their own caches keep working.
 */
import {
	AssistantMessageComponent,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";
import { formatShortDuration } from "./format.ts";
import { toolCallSummary } from "./names.ts";
import { toolLoadingIcon, TOOL_TICK_MS } from "./spinner.ts";
import { patchRegistry } from "./patch.ts";
import { type DreamState, resultLabel, toolVerb } from "./tools.ts";

/** Tools whose own frame, diff or output we never fold away. */
const NON_GROUPABLE = new Set(["edit", "write", "apply_patch", "bash"]);
/** Smallest run that folds: below this the header costs more rows than it saves. */
const MIN_GROUP = 3;

const GROUP_PATCH_KEY = Symbol.for("pi.dreamwalker.tool-group");
const PARENT_KEY = Symbol.for("pi.dreamwalker.tool-group-parent");

type AnyTool = {
	toolName?: string;
	args?: unknown;
	result?: { isError?: boolean; durationMs?: number };
	isPartial?: boolean;
	executionStarted?: boolean;
	rendererState?: { dreamStartedAt?: number };
};

const asTool = (tool: unknown): AnyTool => tool as AnyTool;

function toolName(tool: ToolExecutionComponent): string {
	return String(asTool(tool).toolName ?? "tool");
}

function isGroupable(value: unknown): value is ToolExecutionComponent {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE.has(toolName(value));
}

/** Blank spacer rows and empty assistant text do not break a run of tools. */
function isIgnorable(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	if (!(value instanceof AssistantMessageComponent)) return false;
	const children = (value as unknown as { contentContainer?: { children?: unknown } }).contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

type Status = "pending" | "success" | "error";

function status(tool: ToolExecutionComponent): Status {
	const t = tool as unknown as { result?: { isError?: boolean }; isPartial?: boolean };
	// Streaming tools (bash) store partial output in `result` while still running: only a
	// non-partial result settles the row.
	if (!t.result || t.isPartial !== false) return "pending";
	return t.result.isError ? "error" : "success";
}

/** `↳` once settled (error-colored when failed), the spinner while the tool runs. */
function statusMark(s: Status, fg: (color: string, text: string) => string): string {
	if (s === "pending") return fg("accent", toolLoadingIcon());
	return fg(s === "error" ? "error" : "dim", DREAMWALKER.glyph.result);
}

/** `tool.rendererState.dreamStartedAt` is stamped by createToolRenderers' renderCall when execution starts. */
function startedAt(tool: ToolExecutionComponent): number | undefined {
	const started = (tool as unknown as { rendererState?: { dreamStartedAt?: number } }).rendererState
		?.dreamStartedAt;
	return typeof started === "number" ? started : undefined;
}

/** Settled durations, frozen at first sight so a later re-render (resize, theme) cannot inflate them. */
const settledDuration = new WeakMap<ToolExecutionComponent, string>();

function toolDuration(tool: ToolExecutionComponent): string {
	const frozen = settledDuration.get(tool);
	if (frozen !== undefined) return frozen;
	const started = startedAt(tool);
	if (started === undefined) return "";
	// Running: live elapsed time (the card re-renders on the spinner tick), so a long silent
	// command visibly progresses instead of looking stuck.
	if (status(tool) === "pending") return formatShortDuration(Date.now() - started);
	const t = tool as unknown as { result?: { durationMs?: number } };
	// Prefer pi's own measured execution time when the tool reports it; fall back to wall clock.
	const ms = typeof t.result?.durationMs === "number" ? t.result.durationMs : Date.now() - started;
	// Sub-100ms tools (and test mocks stamping start==settle) show no duration: `0.0s` is noise.
	const text = ms < 100 ? "" : formatShortDuration(ms);
	settledDuration.set(tool, text);
	return text;
}

/** Group duration = wall clock from the earliest child start to the moment all settled. */
function groupDuration(tools: readonly ToolExecutionComponent[]): string {
	if (tools.some((t) => status(t) === "pending")) return "";
	let earliest: number | undefined;
	for (const t of tools) {
		const s = startedAt(t);
		if (s !== undefined && (earliest === undefined || s < earliest)) earliest = s;
	}
	if (earliest === undefined) return "";
	const ms = Date.now() - earliest;
	return ms < 100 ? "" : formatShortDuration(ms);
}

/** First non-empty line of a failed tool's text output. */
function errorLine(tool: ToolExecutionComponent): string {
	const content = (tool as unknown as { result?: { content?: unknown } }).result?.content;
	if (!Array.isArray(content)) return "";
	for (const part of content as { type?: string; text?: unknown }[]) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		const line = part.text.split("\n").find((l) => l.trim());
		if (line) return line.trim().replace(/\s+/g, " ");
	}
	return "";
}

function toolNameList(tools: readonly ToolExecutionComponent[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) counts.set(toolName(t), (counts.get(toolName(t)) ?? 0) + 1);
	return [...counts].map(([name, n]) => `${name}${n > 1 ? `×${n}` : ""}`).join(", ");
}

/** `rightStyled` is already styled. */
function rightAlign(left: string, rightStyled: string, width: number): string {
	const rightWidth = visibleWidth(rightStyled);
	const gap = 2;
	if (!rightStyled || rightWidth + gap >= width) return truncateToWidth(left, width, "…");
	const leftWidth = Math.max(0, width - rightWidth - gap);
	const fitted = truncateToWidth(left, leftWidth, "…");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted) - rightWidth))}${rightStyled}`;
}

interface Patch {
	active: boolean;
	enabled: boolean;
	groups: Set<ToolGroupComponent>;
	theme?: Theme;
	original: { addChild: Container["addChild"]; removeChild: Container["removeChild"]; clear: Container["clear"] };
	installed: { addChild: Container["addChild"]; removeChild: Container["removeChild"]; clear: Container["clear"] };
	tickTimer: ReturnType<typeof setTimeout> | null;
	requestRender?: () => void;
}

type Cache = {
	width: number;
	theme: Theme | undefined;
	children: readonly ToolExecutionComponent[];
	args: readonly unknown[];
	results: readonly unknown[];
	lines: string[];
};

const CHILD_INDENT = 2;
const INDENT = " ".repeat(CHILD_INDENT);

/** A settled collapsed row: reused while every input below is unchanged. */
type RowCache = { key: string; args: unknown; result: unknown; theme: Theme | undefined; lines: string[] };
/** An expanded child: its indented lines, reused while the child returns the same line strings. */
type IndentCache = { src: string[]; out: string[] };

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export class ToolGroupComponent extends Container {
	readonly isDreamGroup = true;
	private _expanded = false;
	/** Expanded-mode child hit regions, recorded during render for handleMouse. */
	private childLayout: { component: ToolExecutionComponent; y: number; height: number }[] | undefined;
	/** Internal: read by maybeGroup to only merge into groups built by this patch instance. */
	readonly patch: Patch;
	private cache: Cache | undefined;
	private readonly rows = new WeakMap<ToolExecutionComponent, RowCache>();
	private readonly indented = new WeakMap<ToolExecutionComponent, IndentCache>();
	/** Expanded output, reused while the header and every child's indented lines are unchanged. */
	private expandedOut: { header: string; memos: IndentCache[]; lines: string[] } | undefined;
	/** Frozen once every child settled; cleared when a child joins. */
	private duration: string | undefined;
	/** The header row, reused while its inputs are unchanged (it is redrawn every spinner frame). */
	private headerCache: { key: string; theme: Theme | undefined; line: string } | undefined;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		patch.groups.add(this);
	}

	get expanded(): boolean {
		return this._expanded;
	}

	addTool(tool: ToolExecutionComponent): void {
		this.cache = undefined;
		this.headerCache = undefined;
		this.duration = undefined;
		this.children.push(tool);
		(tool as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] = this;
	}

	releaseTools(): ToolExecutionComponent[] {
		this.cache = undefined;
		this.headerCache = undefined;
		const tools = [...(this.children as ToolExecutionComponent[])];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: ToolExecutionComponent): void {
		this.cache = undefined;
		this.headerCache = undefined;
		const i = this.children.indexOf(tool);
		if (i >= 0) this.children.splice(i, 1);
		const rec = tool as unknown as Record<PropertyKey, unknown>;
		if (rec[PARENT_KEY] === this) delete rec[PARENT_KEY];
	}

	/** pi's `setToolsExpanded` calls `setExpanded` on each chat child — including this group. */
	setExpanded(expanded: boolean): void {
		if (this._expanded === expanded) return;
		this._expanded = expanded;
		this.cache = undefined;
		for (const tool of this.children as ToolExecutionComponent[]) tool.setExpanded?.(expanded);
		this.invalidate();
	}

	invalidate(): void {
		this.cache = undefined;
		this.headerCache = undefined;
		super.invalidate();
	}

	/**
	 * Click the header row to collapse/expand — the same affordance pi gives a tool result via
	 * MouseRegion. In expanded mode a click inside a child's region forwards to that child so its
	 * own links/selection still work.
	 */
	// pi-tui keeps TuiMouseDispatchResult internal; declare the matching structural shape so the
	// override is assignable to Container.handleMouse.
	handleMouse(event: TuiMouseEvent):
		| (TuiMouseEventResult & {
				handled: true;
				target: { component: Component; originX: number; originY: number; width: number; height: number };
		  })
		| undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const target = { component: this as Component, originX: 0, originY: 0, width: event.width, height: event.height };
		const self = { handled: true as const, target };
		if (!this._expanded) {
			// Collapsed card: any click expands (children aren't individually addressable).
			this.setExpanded(true);
			return self;
		}
		// Expanded layout: row 0 = spacer, row 1 = header. Clicks there collapse; lower rows belong
		// to a child, dispatched with coordinates corrected for the indent.
		if (event.y === 1) {
			this.setExpanded(false);
			return self;
		}
		const layout = this.childLayout;
		if (layout) {
			for (const { component, y, height } of layout) {
				if (event.y >= y && event.y < y + height) {
					const result = component.handleMouse?.({
						...event,
						x: event.x - CHILD_INDENT,
						y: event.y - y,
						width: Math.max(1, event.width - CHILD_INDENT),
						height,
					}) as typeof self | undefined;
					return result?.handled ? result : undefined;
				}
			}
		}
		return undefined;
	}

	private cacheHit(width: number): string[] | undefined {
		const c = this.cache;
		if (!c || this._expanded) return;
		if (c.width !== width || c.theme !== this.patch.theme) return;
		const tools = this.children as ToolExecutionComponent[];
		if (c.children.length !== tools.length) return;
		for (let i = 0; i < tools.length; i++) {
			const t = tools[i]!;
			if (c.children[i] !== t || c.args[i] !== asTool(t).args || c.results[i] !== asTool(t).result || status(t) === "pending") return;
		}
		return c.lines;
	}

	private store(width: number, lines: string[]): void {
		const tools = this.children as ToolExecutionComponent[];
		this.cache = {
			width,
			theme: this.patch.theme,
			children: [...tools],
			args: tools.map((t) => asTool(t).args),
			results: tools.map((t) => asTool(t).result),
			lines,
		};
	}

	private scheduleTick(): void {
		const p = this.patch;
		if (p.tickTimer || !p.active) return;
		p.tickTimer = setTimeout(() => {
			p.tickTimer = null;
			if (!p.active) return;
			// Pending groups bypass the cache, so a frame is enough to advance the spinner.
			for (const g of p.groups) {
				if ((g.children as ToolExecutionComponent[]).some((t) => status(t) === "pending")) {
					p.requestRender?.();
					return;
				}
			}
		}, TOOL_TICK_MS);
		p.tickTimer.unref?.();
	}

	render(width: number): string[] {
		const cached = this.cacheHit(width);
		if (cached) return cached;
		const theme = this.patch.theme;
		const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color as never, text) : text);
		const tools = this.children as ToolExecutionComponent[];

		const counts = { pending: 0, success: 0, error: 0 };
		for (const t of tools) counts[status(t)]++;
		const running = counts.pending > 0;
		if (running) this.scheduleTick();

		// ── Expanded: header + each child's own component (identical to pi). ──
		if (this._expanded) {
			const header = this.header(width, counts, true);
			const out: string[] = ["", header];
			const memos: IndentCache[] = [];
			const layout: { component: ToolExecutionComponent; y: number; height: number }[] = [];
			let start = out.length;
			for (const tool of tools) {
				const childLines = tool.render(Math.max(1, width - CHILD_INDENT));
				// pi rebuilds the array each frame but its line strings are cached: when every line is the
				// same string as last frame, reuse the indented copies instead of concatenating again.
				let memo = this.indented.get(tool);
				if (!memo || !sameLines(memo.src, childLines)) {
					memo = { src: childLines, out: childLines.map((line) => INDENT + line) };
					this.indented.set(tool, memo);
				}
				memos.push(memo);
				layout.push({ component: tool, y: start, height: childLines.length });
				start += memo.out.length;
			}
			this.childLayout = layout;
			const prev = this.expandedOut;
			if (prev && prev.header === header && prev.memos.length === memos.length && prev.memos.every((m, i) => m === memos[i])) {
				return prev.lines;
			}
			for (const memo of memos) for (const line of memo.out) out.push(line);
			this.expandedOut = { header, memos, lines: out };
			return out;
		}
		this.childLayout = undefined;

		// ── Collapsed card. ──
		const header = this.header(width, counts, false);
		const lines: string[] = ["", header];
		const total = tools.length;
		// One tool type: the header names it, so the rows carry only the arguments.
		const sameName = tools.every((t) => toolName(t) === toolName(tools[0]!));
		for (let i = 0; i < total; i++) {
			const tool = tools[i]!;
			const s = status(tool);
			// Settled rows are reused across frames, so a running group only redraws its pending rows.
			const key = `${width}|${s}|${sameName}`;
			const hit = s === "pending" ? undefined : this.rows.get(tool);
			const t = asTool(tool);
			if (hit && hit.key === key && hit.args === t.args && hit.result === t.result && hit.theme === theme) {
				for (const line of hit.lines) lines.push(line);
				continue;
			}
			const rowLines = this.renderRow(tool, s, sameName, width);
			if (s !== "pending") this.rows.set(tool, { key, args: t.args, result: t.result, theme, lines: rowLines });
			for (const line of rowLines) lines.push(line);
		}
		if (!running) this.store(width, lines);
		return lines;
	}

	private renderRow(tool: ToolExecutionComponent, s: Status, sameName: boolean, width: number): string[] {
		const theme = this.patch.theme;
		const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color as never, text) : text);
		const out: string[] = [];
		const name = toolName(tool);
		const summary = truncateToWidth(
			toolCallSummary(name, asTool(tool).args ?? {}),
			Math.max(1, width - visibleWidth("  x ") - 12),
			"…",
		);
		const prefix = `  ${statusMark(s, fg)} `;
		const nameText = summary.startsWith(name) ? name : "";
		const args = summary.slice(nameText.length).trimStart();
		const left = sameName && nameText && args ? `${prefix}${args}` : `${prefix}${fg("muted", nameText)}${args ? ` ${args}` : ""}`;
		const outcome = DREAMWALKER.features.resultLine
			? (tool as unknown as { rendererState?: DreamState }).rendererState?.dreamSummary?.summary
			: undefined;
		out.push(rightAlign(left, resultLabel(fg as never, outcome, toolDuration(tool)), width));
		if (s === "error") {
			const message = errorLine(tool);
			if (message) out.push(truncateToWidth(`    ${fg("error", message)}`, width, "…"));
		}
		return out;
	}

	private header(
		width: number,
		counts: Record<Status, number>,
		expanded: boolean,
	): string {
		const theme = this.patch.theme;
		const tools = this.children as ToolExecutionComponent[];
		let duration = this.duration;
		if (duration === undefined) {
			duration = groupDuration(tools);
			if (counts.pending === 0) this.duration = duration;
		}
		// The tool list is part of the key through addTool/removeTool, which drop the cache.
		const key = `${width}|${expanded}|${tools.length}|${counts.pending}|${counts.success}|${counts.error}|${duration}`;
		const hit = this.headerCache;
		if (hit && hit.key === key && hit.theme === theme) return hit.line;
		const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color as never, text) : text);
		const sep = fg("dim", DREAMWALKER.glyph.separator.trim());
		const names = new Set(tools.map(toolName));
		const single = names.size === 1 ? toolName(tools[0]!) : undefined;
		const label = theme ? theme.bold(fg("accent", single ? toolVerb(single) : "Tools")) : single ? toolVerb(single) : "Tools";
		// Only what needs a look: calls still running, calls that failed.
		const state = (["pending", "error"] as const)
			.filter((k) => counts[k])
			.map((k) => fg(k === "pending" ? "accent" : "error", `${counts[k]} ${k === "pending" ? "running" : "failed"}`));
		const nameList = names.size > 1 ? fg("dim", toolNameList(tools)) : "";
		const hint = fg("dim", expanded ? "ctrl+o to collapse" : "ctrl+o");
		const left = [`${label} ${fg("dim", `×${tools.length}`)}`, nameList, ...state, hint].filter(Boolean).join(` ${sep} `);
		const line = rightAlign(left, duration ? fg("dim", duration) : "", width);
		this.headerCache = { key, theme, line };
		return line;
	}
}

function previousSibling(children: Component[], start: number): { child: Component; index: number } | undefined {
	let skipped = 0;
	for (let i = start; i >= 0; i--) {
		const child = children[i]!;
		if (isIgnorable(child) && skipped < 3) {
			skipped++;
			continue;
		}
		return { child, index: i };
	}
	return undefined;
}

function maybeGroup(patch: Patch, parent: Container, component: Component): void {
	if (!patch.enabled || parent instanceof ToolGroupComponent || !isGroupable(component)) return;
	const children = parent.children;
	if (!Array.isArray(children)) return;
	// The component was just appended: search from the end (O(1) instead of O(transcript)).
	const index = children.lastIndexOf(component);
	if (index < 0) return;
	const prior = previousSibling(children, index - 1);
	if (!prior) return;
	if (prior.child instanceof ToolGroupComponent && prior.child.patch === patch) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}
	// Collect the run of loose groupable tools ending here; a longer run would already be a group.
	const run: { child: Component; index: number }[] = [{ child: component, index }];
	for (let at: typeof prior | undefined = prior; at && isGroupable(at.child) && run.length < MIN_GROUP; ) {
		run.unshift(at);
		at = previousSibling(children, at.index - 1);
	}
	if (run.length < MIN_GROUP) return;
	const group = new ToolGroupComponent(patch);
	for (const r of run) group.addTool(r.child as ToolExecutionComponent);
	(group as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] = parent;
	for (let i = run.length - 1; i > 0; i--) children.splice(run[i]!.index, 1);
	children[run[0]!.index] = group;
}

/** Recursively re-group existing children after /reload (pi does not re-run addChild on reload). */
function regroup(patch: Patch, root: unknown): void {
	const seen = new Set<unknown>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		const node = value as Container & { getMountedRoots?: () => Component[] };
		if (!(node instanceof ToolGroupComponent) && !isGroupable(node)) {
			const children = node.children;
			if (Array.isArray(children)) {
				for (const child of [...children]) {
					(child as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] = node;
					maybeGroup(patch, node, child);
				}
				for (const child of children) visit(child);
			}
			try {
				for (const r of node.getMountedRoots?.() ?? []) visit(r);
			} catch { /* proxy mid-swap */ }
		}
	};
	visit(root);
}

function ungroup(patch: Patch): void {
	for (const group of [...patch.groups]) {
		const parent = (group as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] as Container | undefined;
		const children = parent?.children;
		const index = Array.isArray(children) ? children.indexOf(group) : -1;
		const tools = group.releaseTools();
		if (!Array.isArray(children) || index < 0) continue;
		for (const t of tools) (t as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] = parent;
		children.splice(index, 1, ...tools);
	}
}

export type GroupingHooks = {
	setTheme(theme: Theme): void;
	setRequestRender(requestRender: () => void): void;
	refresh(root?: unknown): void;
	shutdown(): void;
};

export function installToolGrouping(options: { enabled?: boolean } = {}): GroupingHooks {
	const enabled = options.enabled ?? true;
	const proto = Container.prototype as unknown as Patch["original"] & Record<string, unknown>;
	const previous = patchRegistry.get<Patch>(GROUP_PATCH_KEY);
	if (previous) {
		previous.active = false;
		if (previous.tickTimer) clearTimeout(previous.tickTimer);
		previous.tickTimer = null;
		ungroup(previous);
	}
	const original = {
		addChild: previous && proto.addChild === previous.installed.addChild ? previous.original.addChild : proto.addChild,
		removeChild: previous && proto.removeChild === previous.installed.removeChild ? previous.original.removeChild : proto.removeChild,
		clear: previous && proto.clear === previous.installed.clear ? previous.original.clear : proto.clear,
	};
	const patch: Patch = {
		active: true,
		enabled,
		groups: new Set(),
		theme: undefined,
		original,
		installed: undefined as never,
		tickTimer: null,
	};
	patch.installed = {
		addChild(this: Container, component: Component) {
			const result = patch.original.addChild.call(this, component);
			if (!patch.enabled || !component || typeof component !== "object") return result;
			(component as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild(this: Container, component: Component) {
			if (!patch.enabled) return patch.original.removeChild.call(this, component);
			const rec = component as unknown as Record<PropertyKey, unknown>;
			const group = rec?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as unknown as Record<PropertyKey, unknown>)[PARENT_KEY] === this) {
				group.removeTool(component as ToolExecutionComponent);
				return;
			}
			const result = patch.original.removeChild.call(this, component);
			if (rec?.[PARENT_KEY] === this) delete rec[PARENT_KEY];
			if (component instanceof ToolGroupComponent) {
				for (const t of component.releaseTools()) delete (t as unknown as Record<PropertyKey, unknown>)[PARENT_KEY];
			}
			return result;
		},
		clear(this: Container) {
			if (!patch.enabled) return patch.original.clear.call(this);
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const t of child.releaseTools()) delete (t as unknown as Record<PropertyKey, unknown>)[PARENT_KEY];
				}
				const rec = child as unknown as Record<PropertyKey, unknown>;
				if (rec?.[PARENT_KEY] === this) delete rec[PARENT_KEY];
			}
			return patch.original.clear.call(this);
		},
	};
	proto.addChild = patch.installed.addChild;
	proto.removeChild = patch.installed.removeChild;
	proto.clear = patch.installed.clear;
	patchRegistry.install(GROUP_PATCH_KEY, patch);
	return {
		setTheme(theme: Theme) {
			patch.theme = theme;
		},
		setRequestRender(requestRender: () => void) {
			patch.requestRender = requestRender;
		},
		refresh(root?: unknown) {
			if (patch.active && patch.enabled && root) regroup(patch, root);
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			if (patch.tickTimer) clearTimeout(patch.tickTimer);
			patch.tickTimer = null;
			ungroup(patch);
			if (proto.addChild === patch.installed.addChild) proto.addChild = patch.original.addChild;
			if (proto.removeChild === patch.installed.removeChild) proto.removeChild = patch.original.removeChild;
			if (proto.clear === patch.installed.clear) proto.clear = patch.original.clear;
		},
	};
}
