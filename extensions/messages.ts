/**
 * Message chrome: a `▎` bar before user text, a `▲` before the first line of each assistant answer,
 * indented bodies without the user background block, and a `● 5s · $0.01 · 24k in · 310 out ·
 * ⛁ 92% cached · 62 tok/s` line under the final answer of a run.
 *
 * pi has no public hook for built-in message rendering, so this wraps two construction-time
 * methods of the exported components: `UserMessageComponent.rebuild` and
 * `AssistantMessageComponent.updateContent`. Nothing is added to the per-frame `render()` path:
 * the extra children are plain cached components, so steady-state frames cost what pi's cost.
 */
import {
	AssistantMessageComponent,
	copyToClipboard,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	Markdown,
	MouseRegion,
	Spacer,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type AssistantLike, type Chronicle, isFinalResponse, type RunStats } from "./chronicle.ts";
import { DREAMWALKER } from "./config.ts";
import {
	advance,
	commitInterval,
	createPace,
	findOpenFenceLanguage,
	type DripConfig,
	noteInput,
	type PaceState,
	revealMessage,
	type StreamBlock,
	trailingStreamBlock,
} from "./drip.ts";
import { formatCost, formatDuration, formatTokens } from "./format.ts";
import { ChromeLine } from "./line.ts";
import { withFastCodeBlocks } from "./highlight.ts";
import { type FadePalette, type StreamFadeConfig, StreamMarkdown } from "./stream-markdown.ts";

export interface MessageChromeDeps {
	theme(): Theme;
	chronicle: Chronicle;
	notify(message: string): void;
	showRunStats: boolean;
	/** Smooth streaming. Off when undefined. */
	smooth?: DripConfig;
	/** Request a frame; returns false while no TUI is attached (drip then stays off). */
	requestRender?: () => boolean;
	/** Incremental streaming Markdown (frozen prefix + remend). */
	streamRender?: boolean;
	/** Gradient fade-in of new characters; needs `smooth` and `streamRender`. */
	fade?: StreamFadeConfig;
	/** The terminal's real background (OSC 11), when it reported one: where the fade starts. */
	terminalBackground?: () => Color | undefined;
}

/** Runtime shape of the pi components we touch. Every access is guarded. */
interface MarkdownLike extends Component {
	paddingX: number;
	paddingY: number;
	defaultTextStyle?: Record<string, unknown>;
}
interface ContainerLike extends Component {
	children: Component[];
	addChild(child: Component): void;
}
interface UserInternals extends ContainerLike {
	text: string;
	outputPad?: number;
}
interface DripSlot {
	full: AssistantLike;
	block: StreamBlock;
	pace: PaceState;
	/** `pace.shown` at the last paint; -1 before the first. */
	painted: number;
	/** When the last paint (commit) happened, ms epoch. */
	paintedAt: number;
	/** pi's final message, built once the backlog has drained. */
	final?: AssistantLike;
}
/** pi-tui `Markdown`; its fields are private in the typings. */
type PiMarkdown = Component & { text: string; paddingX: number };
interface StreamState {
	/** Earlier blocks' Markdown by child index, reused while their text is unchanged. */
	reuse: Map<number, PiMarkdown>;
	markdown?: StreamMarkdown;
	key?: string;
}
interface AssistantInternals extends ContainerLike {
	contentContainer?: ContainerLike;
	outputPad: number;
	isStreaming: boolean;
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	__dreamwalkerDrip?: DripSlot;
	__dreamwalkerStream?: StreamState;
	markdownTransformers?: readonly unknown[];
	markdownTheme?: { highlightCode?: (code: string, lang?: string) => string[] };
}

type UserRebuild = (this: UserInternals) => void;
type AssistantUpdate = (this: AssistantInternals, message: AssistantLike, isStreaming?: boolean) => void;

interface Originals {
	userRebuild: UserRebuild;
	assistantUpdate: AssistantUpdate;
}

const ORIGINALS = Symbol.for("pi-dreamwalker.message-originals");
type Registry = { [ORIGINALS]?: Originals };

const userProto = UserMessageComponent.prototype as unknown as { rebuild: UserRebuild };
const assistantProto = AssistantMessageComponent.prototype as unknown as { updateContent: AssistantUpdate };

function isMarkdownLike(component: Component | undefined): component is MarkdownLike {
	return (
		!!component &&
		typeof (component as MarkdownLike).paddingX === "number" &&
		typeof (component as MarkdownLike).paddingY === "number"
	);
}

export function installMessageChrome(deps: MessageChromeDeps): void {
	const registry = globalThis as Registry;
	// Keep the true originals across /reload so a new runtime replaces, not stacks, the patch.
	const originals = (registry[ORIGINALS] ??= {
		userRebuild: userProto.rebuild,
		assistantUpdate: assistantProto.updateContent,
	});

	userProto.rebuild = function dreamwalkerUserRebuild(this: UserInternals) {
		originals.userRebuild.call(this);
		decorateUser(this, deps);
	};

	const build = (component: AssistantInternals, message: AssistantLike, isStreaming: boolean) => {
		// Code blocks (streaming tail, frozen chunks, and the final build alike) use the fast
		// highlighter, so a block keeps its colors when the message settles.
		if (DREAMWALKER.features.fastHighlight && component.markdownTheme)
			component.markdownTheme = withFastCodeBlocks(component.markdownTheme, deps.theme);
		const pad = component.outputPad;
		// Indent text and thinking under the header by widening pi's own padding for this build.
		component.outputPad = pad + DREAMWALKER.bodyIndent;
		try {
			originals.assistantUpdate.call(component, message, isStreaming);
		} finally {
			component.outputPad = pad;
		}
		if (deps.streamRender) streamify(component, message, isStreaming, deps);
		decorateAssistant(component, message, isStreaming, deps);
	};
	drip.reset(build, deps);

	assistantProto.updateContent = function dreamwalkerAssistantUpdate(
		this: AssistantInternals,
		message: AssistantLike,
		isStreaming: boolean = this.isStreaming,
	) {
		const slot = this.__dreamwalkerDrip;
		// pi's invalidate() and thinking toggles replay `lastMessage`, which may be a revealed copy.
		if (revealedCopies.has(message)) {
			if (slot) drip.paint(this, slot);
			else build(this, message, isStreaming);
			return;
		}
		if (!drip.enabled()) {
			drip.stop(this);
			build(this, message, isStreaming);
		} else if (isStreaming) drip.update(this, message);
		else drip.finish(this, message);
	};
}

/** Copies made by revealMessage(); pi may hand them back through invalidate(). */
const revealedCopies = new WeakSet<object>();

const isHiddenThinking = (component: AssistantInternals, block: StreamBlock) =>
	block.field === "thinking" && !!component.hideThinkingBlock && !component.thinkingVisibilityOverrides?.size;

const blockText = (slot: DripSlot): string => {
	const part = slot.full.content[slot.block.index] as { text?: string; thinking?: string } | undefined;
	return (slot.block.field === "text" ? part?.text : part?.thinking) ?? "";
};

/**
 * One shared ticker for every streaming message. It runs only while some text is buffered, fading,
 * or waiting to finish, and stops itself otherwise. A finished message drains its backlog (bounded by
 * the pacer's settle window) before pi's final build; aborts and errors flush at once.
 */
const drip = {
	active: new Set<AssistantInternals>(),
	/** When the last frame was requested for the fade alone. */
	frameAt: 0,
	timer: undefined as ReturnType<typeof setInterval> | undefined,
	build: undefined as ((c: AssistantInternals, m: AssistantLike, s: boolean) => void) | undefined,
	deps: undefined as MessageChromeDeps | undefined,

	reset(build: (c: AssistantInternals, m: AssistantLike, s: boolean) => void, deps: MessageChromeDeps) {
		this.halt();
		this.build = build;
		this.deps = deps;
	},

	enabled(): boolean {
		return !!this.deps?.smooth && !!this.deps.requestRender;
	},

	update(component: AssistantInternals, message: AssistantLike) {
		const config = this.deps!.smooth!;
		const block = trailingStreamBlock(message.content as never);
		// A hidden thinking block renders as a fixed label: dripping it only burns ~30 frames/s.
		if (!block || isHiddenThinking(component, block)) {
			this.stop(component);
			this.build?.(component, message, true);
			return;
		}
		const now = Date.now();
		let slot = component.__dreamwalkerDrip;
		if (!slot || slot.block.index !== block.index || slot.block.field !== block.field) {
			slot = { full: message, block, pace: createPace(block.length, now, config), painted: -1, paintedAt: 0 };
			component.__dreamwalkerDrip = slot;
		} else noteInput(slot.pace, block.length, now, config);
		slot.full = message;
		slot.block = block;
		slot.final = undefined;
		// A provider delta that does not move the cursor shows the same text as the last paint.
		// Rebuilding would replace the components and re-render them on the next frame.
		if (slot.painted !== slot.pace.shown || slot.pace.shown >= block.length) this.paint(component, slot);
		if (slot.pace.shown < block.length) this.start(component);
	},

	/** pi's last update (`isStreaming` false). */
	finish(component: AssistantInternals, message: AssistantLike) {
		const slot = component.__dreamwalkerDrip;
		const block = trailingStreamBlock(message.content as never);
		const abrupt = message.stopReason === "aborted" || message.stopReason === "error";
		const same = !!slot && !!block && slot.block.index === block.index && slot.block.field === block.field;
		if (!slot || !block || !same || abrupt || isHiddenThinking(component, block)) {
			this.stop(component);
			this.build?.(component, message, false);
			return;
		}
		noteInput(slot.pace, block.length, Date.now(), this.deps!.smooth!);
		slot.full = message;
		slot.block = block;
		slot.final = message;
		if (slot.pace.shown >= block.length && !component.__dreamwalkerStream?.markdown?.fading()) {
			this.stop(component);
			this.build?.(component, message, false);
			return;
		}
		if (slot.painted !== slot.pace.shown) this.paint(component, slot);
		this.start(component);
	},

	paint(component: AssistantInternals, slot: DripSlot) {
		const shown = revealMessage(slot.full as never, slot.block, slot.pace.shown) as AssistantLike;
		if (shown !== slot.full) revealedCopies.add(shown);
		slot.painted = slot.pace.shown;
		slot.paintedAt = Date.now();
		this.build?.(component, shown, true);
	},

	start(component: AssistantInternals) {
		this.active.add(component);
		if (this.timer || !this.deps?.smooth) return;
		this.timer = setInterval(() => this.tick(), this.deps.smooth.tickMs);
		this.timer.unref?.();
	},

	tick() {
		const config = this.deps?.smooth;
		if (!config) return this.halt();
		const now = Date.now();
		let frame = false;
		for (const component of this.active) {
			const slot = component.__dreamwalkerDrip;
			if (!slot) {
				this.active.delete(component);
				continue;
			}
			const text = blockText(slot);
			if (slot.pace.shown < text.length) {
				// Commits are rate-limited, and spaced wider as the open tail (what each commit re-parses) grows.
				// Inside an open code fence they are not widened: code has no fade to hide a slow rhythm,
				// and its renderer re-draws one line, not the whole tail.
				const markdown = component.__dreamwalkerStream?.markdown;
				const tail = markdown?.inOpenCode() ? 0 : (markdown?.tailLength() ?? 0);
				// Text inside an open ```html fence is shown at once, like streamdown, for live previews.
				const live = text.includes("```html") && findOpenFenceLanguage(text) === "html";
				if (live || now - slot.paintedAt >= commitInterval(config, tail)) {
					if (live) slot.pace.shown = text.length;
					else advance(slot.pace, text, now, config, !!slot.final);
					if (slot.pace.shown !== slot.painted) {
						this.paint(component, slot);
						frame = true;
					}
				}
			}
			const fading = !!component.__dreamwalkerStream?.markdown?.fading(now);
			if (fading && now - this.frameAt >= config.fadeFrameMs) frame = true;
			if (slot.pace.shown < text.length || fading) continue;
			if (slot.final) {
				const final = slot.final;
				this.stop(component);
				this.build?.(component, final, false);
				frame = true;
			} else this.active.delete(component); // caught up; the next delta restarts it
		}
		if (frame) this.frameAt = now;
		if (frame && !this.deps?.requestRender?.()) this.flush();
		if (this.active.size === 0) this.halt();
	},

	stop(component: AssistantInternals) {
		this.active.delete(component);
		component.__dreamwalkerDrip = undefined;
		if (this.active.size === 0) this.halt();
	},

	/** Build every waiting final message now (no TUI to animate for, or the runtime is going away). */
	flush() {
		for (const component of [...this.active]) {
			const final = component.__dreamwalkerDrip?.final;
			this.active.delete(component);
			if (final) {
				component.__dreamwalkerDrip = undefined;
				this.build?.(component, final, false);
			}
		}
	},

	halt() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.flush();
	},
};

/**
 * While a message streams: swap the growing block's `Markdown` for a persistent `StreamMarkdown`
 * (frozen prefix, remend, fade), and retain earlier blocks' instances while their text is unchanged.
 * Pi 1.5 also reuses Markdown instances; the growing block still needs our incremental tail.
 * The final build (`isStreaming` false) is left exactly as pi made it.
 */
function streamify(
	component: AssistantInternals,
	message: AssistantLike,
	isStreaming: boolean,
	deps: MessageChromeDeps,
): void {
	const children = component.contentContainer?.children;
	if (!isStreaming || !children) {
		component.__dreamwalkerStream = undefined;
		return;
	}
	const state = (component.__dreamwalkerStream ??= { reuse: new Map() } as StreamState);
	const block = trailingStreamBlock(message.content as never);
	const part = block ? (message.content[block.index] as { text?: string; thinking?: string }) : undefined;
	const growing = ((block?.field === "text" ? part?.text : part?.thinking) ?? "").trim();

	let growingAt = -1;
	for (let i = children.length - 1; i >= 0 && growing; i--) {
		const md = markdownIn(children[i]);
		if (!md) continue;
		const wrapped = children[i] instanceof MouseRegion;
		const match = block?.field === "text" ? !wrapped && md.text === growing : wrapped && md.text.endsWith(growing);
		if (match) growingAt = i;
		break;
	}

	const seen = new Set<number>();
	for (let i = 0; i < children.length; i++) {
		const md = markdownIn(children[i]);
		if (!md || i === growingAt) continue;
		seen.add(i);
		const previous = state.reuse.get(i);
		if (previous && previous.text === md.text && previous.paddingX === md.paddingX && previous.constructor === md.constructor)
			setMarkdownIn(children, i, previous);
		else state.reuse.set(i, md);
	}
	for (const key of state.reuse.keys()) if (!seen.has(key)) state.reuse.delete(key);

	if (growingAt < 0) {
		state.markdown = undefined;
		return;
	}
	const md = markdownIn(children[growingAt])!;
	const key = `${block!.index}:${block!.field}:${md.paddingX}`;
	if (!state.markdown || state.key !== key) {
		const incremental = !component.markdownTransformers?.length;
		const fade: StreamFadeConfig =
			deps.smooth && deps.fade ? { ...deps.fade, palette: () => fadePalette(deps.theme(), deps.terminalBackground?.()) } : { fadeMs: 0, remend: deps.fade?.remend };
		state.markdown = new StreamMarkdown(md as never, incremental, fade);
		state.key = key;
	} else state.markdown.update(md as never);
	setMarkdownIn(children, growingAt, state.markdown);
}

const palettes = new WeakMap<Theme, { background: Color | undefined; palette: FadePalette | null }>();

/**
 * The gradient fade's colors for `theme`: new characters rise from the terminal's real background
 * (opacity 0: invisible until they brighten) to their own color; uncolored text ends at the theme's
 * `text`. Until the terminal reports its background, the theme's panel background stands in; a
 * start color that differs from the real background would show every new character as a dark (or
 * light) glyph first. Without usable colors the fade stays SGR 2 faint.
 */
function fadePalette(theme: Theme, background: Color | undefined): FadePalette | undefined {
	let entry = palettes.get(theme);
	if (entry === undefined || entry.background !== background) {
		let palette: FadePalette | null;
		try {
			palette = { from: background ?? theme.colors.toolPendingBg, base: theme.colors.text, mode: theme.getColorMode() };
		} catch {
			palette = null;
		}
		entry = { background, palette };
		palettes.set(theme, entry);
	}
	return entry.palette ?? undefined;
}

/** The `Markdown` a content child shows: itself, or the child of pi's thinking MouseRegion. */
function markdownIn(child: Component | undefined): (PiMarkdown) | undefined {
	const inner = child instanceof MouseRegion ? (child as unknown as { child: Component }).child : child;
	return inner instanceof Markdown ? (inner as unknown as PiMarkdown) : undefined;
}

function setMarkdownIn(children: Component[], index: number, replacement: Component): void {
	const child = children[index];
	if (child instanceof MouseRegion) (child as unknown as { child: Component }).child = replacement;
	else children[index] = replacement;
}

export function uninstallMessageChrome(): void {
	drip.halt();
	const registry = globalThis as Registry;
	const originals = registry[ORIGINALS];
	if (!originals) return;
	userProto.rebuild = originals.userRebuild;
	assistantProto.updateContent = originals.assistantUpdate;
	delete registry[ORIGINALS];
}

/**
 * A body whose indent column carries a mark: the first `lead` columns of its first row (or of every
 * row, `all`) are replaced by `pad` spaces, the glyph and a space. Row widths do not change, so the
 * body wraps as pi laid it out. Rows are cached by the identity of the body's own rows and the theme.
 */
class Marked implements Component {
	private src: string[] | undefined;
	private cacheTheme: Theme | undefined;
	private out: string[] = [];
	/** The wrapped body (same name as pi's MouseRegion, so callers look through both). */
	readonly child: Component;
	private readonly theme: () => Theme;
	private readonly glyph: string;
	private readonly pad: number;
	private readonly lead: number;
	private readonly all: boolean;

	constructor(child: Component, theme: () => Theme, glyph: string, pad: number, lead: number, all: boolean) {
		this.child = child;
		this.theme = theme;
		this.glyph = glyph;
		this.pad = pad;
		this.lead = lead;
		this.all = all;
	}

	render(width: number): string[] {
		const lines = this.child.render(width);
		const t = this.theme();
		if (lines === this.src && t === this.cacheTheme) return this.out;
		const blank = " ".repeat(this.lead);
		const mark = `${" ".repeat(this.pad)}${t.fg("accent", this.glyph)} `;
		this.out = lines.map((line, i) => {
			if (!this.all && i > 0) return line;
			if (line.startsWith(blank)) return mark + line.slice(this.lead);
			return this.all && line.replace(/\x1b\[[0-9;:]*m/g, "").trim() === "" ? mark : line;
		});
		this.src = lines;
		this.cacheTheme = t;
		return this.out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return (this.child as Component & { handleMouse?: (e: TuiMouseEvent) => TuiMouseEventResult | undefined }).handleMouse?.(event);
	}

	invalidate(): void {
		this.src = undefined;
		this.child.invalidate();
	}
}

function decorateUser(component: UserInternals, deps: MessageChromeDeps): void {
	const body = component.children[0];
	if (!isMarkdownLike(body)) return;
	const pad = component.outputPad ?? 1;

	body.paddingX = pad + DREAMWALKER.bodyIndent;
	body.paddingY = 0;
	if (body.defaultTextStyle) {
		const { bgColor: _bg, ...rest } = body.defaultTextStyle;
		body.defaultTextStyle = rest;
	}
	body.invalidate();
	component.children[0] = new Marked(body, deps.theme, DREAMWALKER.glyph.user, pad, pad + DREAMWALKER.bodyIndent, true);
}

function decorateAssistant(
	component: AssistantInternals,
	message: AssistantLike,
	isStreaming: boolean,
	deps: MessageChromeDeps,
): void {
	const content = component.contentContainer;
	if (!content || !message) return;
	const pad = component.outputPad;

	// The first text block of each answer carries the mark; thinking runs (in a MouseRegion) do not.
	const children = content.children;
	for (let i = 0; i < children.length; i++) {
		if (children[i] instanceof Spacer || children[i] instanceof MouseRegion) continue;
		children[i] = new Marked(children[i]!, deps.theme, DREAMWALKER.glyph.assistant, pad, pad + DREAMWALKER.bodyIndent, false);
		break;
	}

	if (!deps.showRunStats || isStreaming || !isFinalResponse(message)) return;
	const stats = deps.chronicle.runStats(message) ?? singleResponseStats(message);
	content.addChild(new Spacer(1));
	content.addChild(statsLine(stats, message, pad, deps));
}

function singleResponseStats(message: AssistantLike): RunStats {
	const usage = message.usage;
	return {
		wallMs: message.durationMs ?? 0,
		generationMs: message.durationMs ?? 0,
		cost: usage?.cost?.total ?? 0,
		promptTokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		responses: 1,
	};
}

export function describeRunStats(stats: RunStats): string[] {
	const parts: string[] = [];
	if (stats.wallMs > 0) parts.push(formatDuration(stats.wallMs));
	if (stats.cost > 0) parts.push(formatCost(stats.cost));
	if (stats.promptTokens > 0) parts.push(`${formatTokens(stats.promptTokens)} in`);
	if (stats.output > 0) parts.push(`${formatTokens(stats.output)} out`);
	if (stats.promptTokens > 0 && stats.cacheRead > 0) {
		const pct = Math.round((stats.cacheRead / stats.promptTokens) * 100);
		parts.push(`${DREAMWALKER.glyph.cache} ${pct}% cached`);
	}
	if (stats.generationMs > 0 && stats.output > 0) {
		parts.push(`${Math.round(stats.output / (stats.generationMs / 1000))} tok/s`);
	}
	return parts;
}

function statsLine(
	stats: RunStats,
	message: AssistantLike,
	pad: number,
	deps: MessageChromeDeps,
): Component {
	const indent = pad + DREAMWALKER.bodyIndent;
	const copyLabel = DREAMWALKER.glyph.copy;
	const copyWidth = visibleWidth(copyLabel);
	const summary = describeRunStats(stats).join(DREAMWALKER.glyph.separator);

	const line = new ChromeLine((width) => {
		const t = deps.theme();
		const left = `${" ".repeat(indent)}${t.fg("success", DREAMWALKER.glyph.stats)} ${t.fg("dim", summary)}`;
		const leftWidth = indent + 2 + visibleWidth(summary);
		const gap = width - leftWidth - copyWidth - pad;
		return gap >= 2 ? `${left}${" ".repeat(gap)}${t.fg("dim", copyLabel)}` : left;
	});

	return new MouseRegion(line, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const copyStart = event.width - pad - copyWidth;
		if (event.x < copyStart || event.x >= copyStart + copyWidth) return undefined;
		const text = (message.content as ReadonlyArray<{ type: string; text?: string }>)
			.filter((part) => part.type === "text" && part.text)
			.map((part) => part.text)
			.join("\n\n")
			.trim();
		copyToClipboard(text).then(
			() => deps.notify("Copied response"),
			() => deps.notify("Copy failed"),
		);
		return { handled: true };
	});
}
