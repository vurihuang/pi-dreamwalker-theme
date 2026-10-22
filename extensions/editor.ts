/**
 * Input card in the dreamwalker chrome: a hairline, a status row, then a rounded box.
 *
 *   ────────────────────────────────────────────────────────────────────────────────────
 *    ⠋ 4.1s · Working                                           magpie/devin/swe-2 (High)
 *   ╭──────────────────────────────────────────────────────────────────────────────────╮
 *   │ › text                                                                           │
 *   ╰──────────────────────────────────────────────────────────────────────────────────╯
 *
 * The status row carries the run (spinner, timer and message while busy; `✓ done 1m05s` after) on
 * the left and the model with its thinking level on the right. Place, context and spend live in the
 * footer. While the agent works, a soft band sweeps along the top border (shimmer.ts).
 *
 * Everything that is editing (layout, cursor, IME marker, autocomplete, keybindings, scroll) stays
 * pi's `CustomEditor`; this class only renders it at a narrower width and draws the card. The frame
 * is pi's `borderColor` (the thinking level's color, `bashMode` after `!`), the error color while a run is at risk.
 */
import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";
import { renderChip } from "./chip.ts";
import { formatRunTimer } from "./format.ts";
import { rowRule } from "./line.ts";
import { type Shimmer, shimmerInterval, shimmerPainter, toneFor } from "./shimmer.ts";
import { clock, flashStep, isLit, signal } from "./signal.ts";

export interface EditorLabels {
	/** e.g. `magpie` */
	provider?: string;
	/** e.g. `devin/swe-2` */
	model?: string;
	/** e.g. `high`; omitted when the model has no reasoning. */
	thinking?: string;
	/** When the current agent run started (ms epoch); omitted when idle. */
	runStart?: number;
}

/** `provider/model (High)`: the provider dim, the model muted, the level in its thinking color. */
export function renderModel(t: Theme, labels: EditorLabels): string {
	if (!labels.model) return "";
	const level = labels.thinking && labels.thinking !== "thinking off" && labels.thinking !== "off" ? labels.thinking : "";
	const provider = labels.provider ? t.fg("dim", `${labels.provider}/`) : "";
	if (!level) return provider + t.fg("muted", labels.model);
	const color = t.getThinkingBorderColor(level as Parameters<Theme["getThinkingBorderColor"]>[0]);
	return `${provider}${t.fg("muted", `${labels.model} `)}${color(`(${level.charAt(0).toUpperCase()}${level.slice(1)})`)}`;
}

const errors = new WeakMap<Theme, (s: string) => string>();
/** The theme's error color as a function; built once per theme. */
function errorColor(t: Theme): (s: string) => string {
	let fn = errors.get(t);
	if (!fn) errors.set(t, (fn = (s) => t.fg("error", s)));
	return fn;
}

/** Left frame + prompt: `│ › `. */
const LEFT = 4;
/** Right frame: ` │`. */
const RIGHT = 2;
const MIN_WIDTH = LEFT + RIGHT + 8;

interface WorkingIndicator {
	kind?: string;
	/** pi's Loader fields: used to put the run timer between spinner and message. */
	message?: string;
	messageColorFn?: (text: string) => string;
	renderInBorder(width: number): string;
	renderSpinnerInBorder?(width: number): string;
}

/** The shimmer ticker stops when the editor has not been painted for this long. */
const DETACHED_MS = 500;

export class DreamEditor extends CustomEditor {
	private hiddenAbove = 0;
	private hiddenBelow = 0;
	// Not `theme`: the base Editor owns a `theme` field (EditorTheme) at runtime.
	private readonly chromeTheme: () => Theme;
	private readonly labels: () => EditorLabels;
	/** Border shimmer frame ticker; runs only while busy and painted. */
	private shimmerTimer: ReturnType<typeof setTimeout> | undefined;
	/** `frameNow` of the last paint (any frame source); 0 before the first. */
	private lastPaint = 0;
	/** Smoothed cost (ms) of a whole screen repaint, measured on busy frames. */
	private frameCost = 0;
	private costPending = false;
	private ownRunStart: number | undefined;
	/** Clock for the shimmer (overridable for tests and benches). */
	shimmerNow: () => number = Date.now;
	/** Monotonic clock for frame scheduling (overridable for tests). */
	frameNow: () => number = () => performance.now();

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		chromeTheme: () => Theme,
		labels: () => EditorLabels,
		paddingX: number,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true, paddingX });
		this.chromeTheme = chromeTheme;
		this.labels = labels;
	}

	// The base editor calls these with its inner width; record the scroll state, draw our own.
	override renderTopBorder(_width: number, hiddenLineCount: number): string {
		this.hiddenAbove = hiddenLineCount;
		return "";
	}

	override renderBottomBorder(_width: number, hiddenLineCount: number): string {
		this.hiddenBelow = hiddenLineCount;
		return "";
	}

	override render(width: number): string[] {
		const frame = DREAMWALKER.frame;
		if (width < MIN_WIDTH) {
			return super.render(width).map((line, i, all) => {
				if (i === 0 || i === all.length - 1) return this.frameColor()((i === 0 ? frame.top : frame.bottom).repeat(width));
				return line;
			});
		}
		const inner = width - LEFT - RIGHT;
		const base = super.render(inner);
		const autocompleteHeight = (this as unknown as { renderedAutocompleteHeight?: number })
			.renderedAutocompleteHeight ?? 0;
		const contentEnd = base.length - 1 - autocompleteHeight; // index of base bottom border
		this.lastPaint = this.frameNow();
		this.syncShimmer();
		const t = this.chromeTheme();
		const border = this.frameColor();
		// While busy a band runs along the top border; sides and bottom keep the border color.
		const glow = this.shimmer(width, border);
		const prompt = t.fg("accent", DREAMWALKER.glyph.prompt);
		const wall = `${border(frame.left)} `;
		const wallRight = border(` ${frame.right}`);

		const out: string[] = [this.rule(t, width), this.statusRow(width), this.topBorder(width, border, glow)];
		for (let i = 1; i < contentEnd; i++) {
			const lead = i === 1 && this.hiddenAbove === 0 ? `${prompt} ` : "  ";
			out.push(`${wall}${lead}${base[i]}${wallRight}`);
		}
		out.push(this.bottomBorder(width, border));
		for (let i = contentEnd + 1; i < base.length; i++) out.push(" ".repeat(LEFT) + base[i]);
		return out;
	}

	override handleInput(data: string): void {
		// After an abort the status row keeps `paused` until the user starts typing again.
		signal.touch();
		super.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < MIN_WIDTH) return super.handleMouse(event);
		// Rows 0 and 1 are the rule and the status row: the base editor's rows start at the top border below them.
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - LEFT),
			y: event.y - 2,
			width: event.width - LEFT - RIGHT,
		});
	}

	/**
	 * The frame color: pi's `borderColor`, which pi drives from the thinking level (and `!` mode), so
	 * the level reads at a glance. The error color while the run is at risk, blinking from the usual
	 * color for the first flash steps.
	 */
	private frameColor(): (s: string) => string {
		const usual = this.borderColor;
		if (!DREAMWALKER.features.runSignal || signal.phase !== "risk") return usual;
		const step = flashStep(signal.riskSince);
		return step >= 0 && !isLit(step) ? usual : errorColor(this.chromeTheme());
	}

	private shimmer(width: number, border: (s: string) => string): Shimmer | undefined {
		if (!this.shimmerOn()) return undefined;
		// At risk the band sweeps faster: the same period, with the clock running 1 / riskPeriod times as fast.
		const risk = DREAMWALKER.features.runSignal && signal.phase === "risk";
		const now = risk ? this.shimmerNow() / DREAMWALKER.signal.riskPeriod : this.shimmerNow();
		return shimmerPainter(border, toneFor(this.chromeTheme()), width, now);
	}

	private shimmerOn(): boolean {
		return DREAMWALKER.features.borderShimmer && this.busy();
	}

	/** Start the frame ticker while busy (called on every paint). */
	private syncShimmer(): void {
		if (!this.shimmerOn()) return;
		this.measureFrame();
		if (!this.shimmerTimer) this.scheduleShimmer(shimmerInterval(this.frameCost));
	}

	private scheduleShimmer(delay: number): void {
		this.shimmerTimer = setTimeout(() => this.shimmerTick(), Math.max(1, delay));
		this.shimmerTimer.unref?.();
	}

	/**
	 * One ticker step. Stops after the run ends (with one last frame to repaint the plain border) or
	 * when nothing painted the editor for a while (replaced or suspended: a paint restarts it).
	 * Requests a frame only when no other source painted within the interval, so streaming and the
	 * spinner are not doubled up.
	 */
	private shimmerTick(): void {
		this.shimmerTimer = undefined;
		if (!this.shimmerOn()) {
			this.tui.requestRender();
			return;
		}
		const interval = shimmerInterval(this.frameCost);
		const since = this.frameNow() - this.lastPaint;
		if (since > Math.max(DETACHED_MS, 4 * interval)) return;
		if (since >= interval * 0.75) {
			this.tui.requestRender();
			this.scheduleShimmer(interval);
		} else this.scheduleShimmer(interval - since);
	}

	/**
	 * Sample the cost of the current screen repaint: from the TUI's frame start to the end of the
	 * task that paints it (render + diff + terminal write). Skipped for paints outside a TUI frame.
	 */
	private measureFrame(): void {
		if (this.costPending) return;
		const start = (this.tui as unknown as { lastRenderAt?: number }).lastRenderAt;
		if (!start || this.lastPaint - start > 50 || this.lastPaint < start) return;
		this.costPending = true;
		setImmediate(() => {
			this.costPending = false;
			const sample = this.frameNow() - start;
			if (sample < 0 || sample > 1000) return;
			this.frameCost = this.frameCost ? this.frameCost * 0.8 + sample * 0.2 : sample;
		}); // Not unref'd: an unref'd immediate waits for the next wakeup and overstates the cost.
	}

	private indicator(): WorkingIndicator | undefined {
		return (this as unknown as { workingStatusIndicator?: WorkingIndicator }).workingStatusIndicator;
	}

	private busy(): boolean {
		const indicator = this.indicator();
		return !!indicator && (indicator.kind === undefined || indicator.kind === "working");
	}

	/** Run start for the timer: from `agent_start`, else the first busy frame (e.g. after /reload). */
	private runStart(fromEvent: number | undefined, busy: boolean): number {
		if (!busy) {
			this.ownRunStart = undefined;
			return 0;
		}
		this.ownRunStart ??= fromEvent ?? this.shimmerNow();
		return fromEvent ?? this.ownRunStart;
	}

	/** `⠋ 4.1s · Working` (full) and `⠋ 4.1s` (short) while busy; pi's own label otherwise. */
	private status(t: Theme, labels: EditorLabels, width: number): [full: string, short: string] {
		const indicator = this.indicator();
		const busy = this.busy();
		const start = this.runStart(labels.runStart, busy);
		if (!indicator) return ["", ""];
		if (!busy || !indicator.renderSpinnerInBorder || indicator.message === undefined) {
			const own = indicator.renderInBorder(Math.max(1, Math.floor(width / 2)));
			return [own, own];
		}
		const spin = indicator.renderSpinnerInBorder(4);
		const timer = t.fg("muted", formatRunTimer(this.shimmerNow() - start));
		const short = spin ? `${spin} ${timer}` : timer;
		const message = indicator.messageColorFn ? indicator.messageColorFn(indicator.message) : t.fg("muted", indicator.message);
		return [indicator.message ? `${short}${t.fg("dim", DREAMWALKER.glyph.separator)}${message}` : short, short];
	}

	/**
	 * The row above the card: the run on the left (spinner, timer and message while busy, the
	 * finished run's chip after), the model and its level on the right. The run's words drop first
	 * when the row is narrow.
	 */
	private statusRow(width: number): string {
		const t = this.chromeTheme();
		const labels = this.labels();
		const pad = 1;
		const available = width - pad * 2;
		const right = renderModel(t, labels);
		const rightWidth = visibleWidth(right);
		let [full, short] = this.status(t, labels, available);
		// While busy the chip's `at risk` is spelled out beside the spinner; after the run the chip says it itself.
		let risk = DREAMWALKER.features.runSignal && signal.phase === "risk" ? t.fg("error", "at risk") : "";
		if (!full && DREAMWALKER.features.statusChip) {
			full = short = renderChip(t, signal, clock.now());
			risk = "";
		}
		const withRisk = (text: string) => (text && risk ? `${text}${t.fg("dim", DREAMWALKER.glyph.separator)}${risk}` : text);
		const room = available - rightWidth - (rightWidth ? 2 : 0);
		let left = withRisk(full);
		if (visibleWidth(left) > room) left = withRisk(short);
		if (visibleWidth(left) > room) left = truncateToWidth(left, Math.max(0, room), t.fg("dim", "…"));
		const gap = Math.max(0, available - visibleWidth(left) - rightWidth);
		const row = `${" ".repeat(pad)}${left}${" ".repeat(gap)}${right}${" ".repeat(pad)}`;
		return visibleWidth(row) > width ? truncateToWidth(row, width, "") : row;
	}

	/** A hairline across the full width that parts the chat from the status row and card. */
	private rule(t: Theme, width: number): string {
		return rowRule(t, width);
	}

	private topBorder(width: number, border: (s: string) => string, glow: Shimmer | undefined): string {
		const t = this.chromeTheme();
		const { tl, tr, top } = DREAMWALKER.frame;
		// Shimmer paints glyphs by absolute column.
		const at = glow ? glow.at : (text: string, _col: number, color?: (s: string) => string) => (color ?? border)(text);
		const hidden = this.hiddenAbove > 0 ? t.fg("dim", `↑ ${this.hiddenAbove}`) : "";
		if (!hidden) return at(`${tl}${top.repeat(Math.max(0, width - 2))}${tr}`, 0);
		const fill = Math.max(0, width - 6 - visibleWidth(hidden));
		return `${at(`${tl}${top.repeat(fill + 1)}`, 0)} ${hidden} ${at(`${top}${tr}`, width - 2)}`;
	}

	private bottomBorder(width: number, border: (s: string) => string): string {
		const { bl, br, bottom } = DREAMWALKER.frame;
		if (this.hiddenBelow === 0) return border(`${bl}${bottom.repeat(Math.max(0, width - 2))}${br}`);
		const label = ` ↓ ${this.hiddenBelow} `;
		const fill = Math.max(0, width - 4 - visibleWidth(label));
		return border(`${bl}${bottom}${label}${bottom.repeat(fill)}${bottom}${br}`);
	}
}
