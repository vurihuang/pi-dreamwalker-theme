/**
 * Border shimmer: a soft band of light that sweeps along the editor's top border while the agent
 * works.
 *
 * Every color here is a tone of the frame's own border color: OKHSL lightness moves, hue never does,
 * and saturation only fades toward the band's peak. Mixing toward black or white instead moves
 * lightness and chroma together, which turns orange and red brown, sinks gray frames into the
 * background, and washes every peak out to the same white.
 *
 * The band's colors are a ramp from the top border's track to a lighter tint of the border color
 * (darker on light themes). While busy the track dims by `trackDim` (more if the color has too
 * little headroom for `swing`), never closer than `minGap` to the background; a dim border's peak
 * reaches at least `peakGap` above the background. Sides and bottom keep the border color. The ramp is built once per (border SGR,
 * tone, config) and cached, so a frame only maps columns to ramp steps and joins strings. Columns
 * outside the band share one SGR run, so a frame adds about `2 * halfWidth` SGR sequences no matter
 * how wide the terminal is.
 *
 * Position is a function of wall time, not frame count: a dropped frame is skipped, never slowed.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	colorToOkhsl,
	foregroundAnsi,
	indexedColor,
	okhslColor,
	rgbColor,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";

export interface ShimmerConfig {
	/** Shortest frame interval while busy. */
	tickMs: number;
	/** Longest frame interval (expensive screens). */
	maxTickMs: number;
	/** Share of one core the shimmer's own frames may spend; sets the interval from the frame cost. */
	frameBudget: number;
	/** Time for the band to cross the border once. */
	periodMs: number;
	/** Columns on each side of the band's center: `bandRatio` of the width, at least `halfWidth`. */
	halfWidth: number;
	bandRatio: number;
	/** Ramp steps from the track (0) to the peak (steps - 1). */
	steps: number;
	/** OKHSL lightness between the track and the peak. */
	swing: number;
	/** Least OKHSL lightness between the peak and the background (raises `swing` for dim borders). */
	peakGap: number;
	/** OKHSL lightness the top border's track drops while busy (bounded by `minGap`). */
	trackDim: number;
	/** Closest OKHSL lightness the track may come to the background. */
	minGap: number;
	/** Share of the border's saturation the peak keeps. */
	peakSaturation: number;
	/** Draw the band's core with the heavy line `━` (cells at or above this fraction of the peak; 1+ = never). */
	heavyFrom: number;
}

/** What a tone needs to know about the screen. */
export interface Tone {
	light: boolean;
	mode: TerminalColorMode;
	/** OKHSL lightness of the terminal background (estimated). */
	backgroundL: number;
}

export interface Shimmer {
	/** The top border's color outside the band: the border color, or a tone of it with room for the band. */
	track(text: string): string;
	/**
	 * `text` (single-width glyphs) starting at absolute column `col`, with the band applied. By default
	 * over the track; pass `color` to glow from another base, which is then kept as is outside the band.
	 */
	at(text: string, col: number, color?: (s: string) => string): string;
}

interface Ramp {
	/** SGR for each step; [0] is the track color. */
	sgr: string[];
}

const RESET = "\x1b[39m";
/** Lightest (darkest on light themes) a tone may go: keeps a trace of the hue at the peak. */
const LIMIT_DARK = 0.94;
const LIMIT_LIGHT = 0.1;
/** Background lightness guesses when the theme gives no background color. */
const FALLBACK_BG = { dark: 0.2, light: 0.97 };

/** First foreground SGR in `sample` (what `borderColor("x")` returns) as a Color. */
export function parseForeground(sample: string): Color | undefined {
	const rgb = /\x1b\[(?:[\d;]*;)?38;2;(\d+);(\d+);(\d+)m/.exec(sample);
	if (rgb) return rgbColor(+rgb[1]!, +rgb[2]!, +rgb[3]!);
	const idx = /\x1b\[(?:[\d;]*;)?38;5;(\d+)m/.exec(sample);
	if (idx) return indexedColor(+idx[1]!);
	const basic = /\x1b\[(?:[\d;]*;)?(3[0-7]|9[0-7])m/.exec(sample);
	if (basic) {
		const n = +basic[1]!;
		return indexedColor(n >= 90 ? n - 90 + 8 : n - 30);
	}
	return undefined;
}

const tones = new WeakMap<Theme, Tone>();

/**
 * The tone context for `theme`. The terminal background is not exposed, so the theme's panel
 * backgrounds stand in for it: the darkest of them on dark themes (lightest on light ones). Panels
 * sit at or above the terminal background, so the guess errs toward keeping the track brighter.
 */
export function toneFor(theme: Theme): Tone {
	let tone = tones.get(theme);
	if (tone) return tone;
	const light = theme.appearance === "light";
	let backgroundL = light ? FALLBACK_BG.light : FALLBACK_BG.dark;
	const seen: number[] = [];
	for (const token of ["toolPendingBg", "userMessageBg"] as const) {
		try {
			const color = theme.colors[token];
			if (color) seen.push(colorToOkhsl(color).l);
		} catch {
			// No usable color for this token.
		}
	}
	if (seen.length) backgroundL = light ? Math.max(...seen) : Math.min(...seen);
	tone = { light, mode: theme.getColorMode(), backgroundL };
	tones.set(theme, tone);
	return tone;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Room left before `l` reaches the tone limit (toward white on dark themes, black on light ones). */
function headroom(l: number, light: boolean): number {
	return Math.max(0, light ? l - LIMIT_LIGHT : LIMIT_DARK - l);
}

/**
 * Track and peak for `base`. With `moveTrack`, a color without `swing` headroom moves the track the
 * other way (bounded by the background gap); without it the track is `base` itself.
 */
function rampEnds(base: Color, tone: Tone, config: ShimmerConfig, moveTrack: boolean) {
	const { h, s, l } = colorToOkhsl(base);
	const dir = tone.light ? -1 : 1;
	const wanted = Math.max(config.swing, tone.light ? l - (tone.backgroundL - config.peakGap) : tone.backgroundL + config.peakGap - l);
	const up = Math.min(wanted, headroom(l, tone.light));
	const down = moveTrack ? Math.max(config.trackDim, config.swing - up) : 0;
	const trackL = tone.light
		? Math.min(l + down, Math.max(l, tone.backgroundL - config.minGap))
		: Math.max(l - down, Math.min(l, tone.backgroundL + config.minGap));
	return { h, s, trackL: clamp01(trackL), peakS: clamp01(s * config.peakSaturation), peakL: clamp01(l + dir * up) };
}

function buildRamp(sample: string, tone: Tone, config: ShimmerConfig, moveTrack: boolean): Ramp | null {
	const base = parseForeground(sample);
	if (!base) return null;
	const { h, s, trackL, peakS, peakL } = rampEnds(base, tone, config, moveTrack);
	const sgr: string[] = [];
	for (let i = 0; i < config.steps; i++) {
		const t = i / (config.steps - 1);
		sgr.push(foregroundAnsi(okhslColor(h, clamp01(s + (peakS - s) * t), clamp01(trackL + (peakL - trackL) * t)), tone.mode));
	}
	return { sgr };
}

const ramps = new Map<string, Ramp | null>();

function rampFor(color: (s: string) => string, tone: Tone, config: ShimmerConfig, moveTrack: boolean): Ramp | null {
	const sample = color("x");
	const key = `${sample}|${tone.light ? 1 : 0}|${tone.mode}|${tone.backgroundL}|${config.steps}|${config.swing}|${config.peakGap}|${config.trackDim}|${config.minGap}|${config.peakSaturation}|${moveTrack ? 1 : 0}`;
	let ramp = ramps.get(key);
	if (ramp === undefined) {
		ramp = buildRamp(sample, tone, config, moveTrack);
		ramps.set(key, ramp);
	}
	return ramp;
}

/**
 * Frame interval for a screen whose full repaint costs `frameCostMs`: `tickMs` while cheap, longer as
 * the repaint gets expensive, so the shimmer's own frames stay within `frameBudget` of a core.
 */
export function shimmerInterval(frameCostMs: number, config: ShimmerConfig = DREAMWALKER.shimmer): number {
	const wanted = frameCostMs > 0 ? frameCostMs / config.frameBudget : 0;
	return Math.round(Math.min(config.maxTickMs, Math.max(config.tickMs, wanted)));
}

/** Columns on each side of the band's center for a border `width` wide. */
export function halfWidthFor(width: number, config: ShimmerConfig): number {
	return Math.max(config.halfWidth, Math.round(width * config.bandRatio));
}

/** Band center (in columns, may be off-screen) at `now` for a border `width` wide. */
export function bandCenter(now: number, width: number, half: number, config: ShimmerConfig): number {
	const travel = width + 2 * half;
	const t = (now % config.periodMs) / config.periodMs;
	return t * travel - half;
}

/** Ramp step (0 = track) for column `col` with the band centered at `center`. */
export function stepAt(col: number, center: number, half: number, steps: number): number {
	const d = Math.abs(col + 0.5 - center) / half;
	if (d >= 1) return 0;
	const k = Math.cos((d * Math.PI) / 2);
	return Math.round(k * k * (steps - 1));
}

/**
 * The top border painter for one paint while busy. Returns undefined when the border color cannot
 * be parsed (no shimmer; the caller keeps its normal path).
 */
export function shimmerPainter(
	borderColor: (s: string) => string,
	tone: Tone,
	width: number,
	now: number,
	config: ShimmerConfig = DREAMWALKER.shimmer,
): Shimmer | undefined {
	const ramp = rampFor(borderColor, tone, config, true);
	if (!ramp) return undefined;
	const floor = ramp.sgr[0]!;
	const track = (text: string) => `${floor}${text}${RESET}`;
	const half = halfWidthFor(width, config);
	const center = bandCenter(now, width, half, config);
	const lo = Math.floor(center - half);
	const hi = Math.ceil(center + half);
	const heavyStep = config.heavyFrom * (config.steps - 1);
	const heavy = DREAMWALKER.shimmerHeavy;
	const at = (text: string, col: number, color?: (s: string) => string) => {
		// By code point: pixel glyphs such as U+1FB82 are two UTF-16 units but one column.
		const chars = [...text];
		const end = col + chars.length;
		const r = color ? rampFor(color, tone, config, false) : ramp;
		if (!r) return color ? color(text) : track(text);
		if (end <= lo || col >= hi) return color ? color(text) : track(text);
		let out = "";
		let runStep = -1;
		let run = "";
		for (let i = 0; i < chars.length; i++) {
			const step = stepAt(col + i, center, half, config.steps);
			if (step !== runStep && run) {
				out += r.sgr[runStep]! + run;
				run = "";
			}
			runStep = step;
			const ch = chars[i]!;
			run += step >= heavyStep ? (heavy[ch] ?? ch) : ch;
		}
		if (run) out += r.sgr[runStep]! + run;
		return out + RESET;
	};
	return { track, at };
}
