/**
 * Smooth streaming ("text drip"): the reveal pacer, a port of @lobehub/streamdown's
 * `useSmoothStreamContent` tick.
 *
 * Providers often deliver tokens in bursts: many updates in the same millisecond, then a pause of
 * 100–600 ms. Painting each burst as it lands makes text jump; draining each burst as fast as
 * possible makes it stop and start. The pacer keeps a reserve (`targetLagChars`) so the text keeps
 * moving between chunks:
 *
 * - Input is tracked per chunk, not per event: events within `BURST_JOIN_MS` are one chunk (React
 *   batches them into one update in streamdown), so a burst does not collapse the interval EMAs.
 * - While input is active (a chunk arrived within `activeInputWindowMs`) the speed is the EMA of
 *   the arrival rate, scaled by a backlog / chunk-size / arrival pressure, within
 *   `maxActiveCps`..`maxFlushCps`; the cursor stays `targetLagChars` behind the end.
 * - When input goes quiet the leftover drains at `flushCps`+; when the message has ended (pi says
 *   so, so no settle guess is needed) it drains within `settleDrainMinMs`–`settleDrainMaxMs`.
 * - One deviation: any backlog is revealed within about `maxLagMs`, which is far looser than
 *   streamdown's CPS clamps, so a fast model cannot make the text fall behind for seconds.
 * - Overshoot from word snapping is paid back by the next ticks, so it does not inflate the rate.
 *
 * Pure functions over a small state object; the ticker lives in messages.ts.
 */

export interface DripConfig {
	/** The ticker's step while text is buffered or fading. */
	tickMs: number;
	/** Shortest interval between two commits (reveal paints) of a message; set by the preset. */
	minCommitMs: number;
	/** Open-tail characters that add one `minCommitMs` to the commit interval (0 = never widen). */
	commitTailScale: number;
	/** Longest commit interval. */
	maxCommitMs: number;
	/** Frames requested for the fade alone are at least this far apart. */
	fadeFrameMs: number;
	/** Reserve kept for the next chunk, in ms of reveal time. Lower = snappier, higher = smoother. */
	targetBufferMs: number;
	/** Any backlog is revealed within about this long (the one place this pacer is faster than streamdown's). */
	maxLagMs: number;
	/** Input counts as active this long after a chunk. */
	activeInputWindowMs: number;
	/** Quiet this long without the message ending: the leftover drains like at the end. */
	settleAfterMs: number;
	/** The rate assumed before any input has been measured, chars/s; and the floor of the measured one. */
	defaultCps: number;
	minCps: number;
	/** Ceiling of the baseline rate, of the rate while input is active, and of any drain, chars/s. */
	maxCps: number;
	maxActiveCps: number;
	maxFlushCps: number;
	/** Weight of a new chunk in the rate EMA. */
	emaAlpha: number;
	/** Floor of the drain rate once input stopped, chars/s. */
	flushCps: number;
	/** The end-of-message drain takes this long at most (and at least, for large leftovers). */
	settleDrainMinMs: number;
	settleDrainMaxMs: number;
	/** A single append larger than this is shown at once (resume, replay, paste-like output). */
	largeAppendChars: number;
}

export interface StreamBlock {
	index: number;
	field: "text" | "thinking";
	length: number;
}

type Part = { type: string; text?: string; thinking?: string };

/** The block that is still growing: the last content block, when it is text or thinking. */
export function trailingStreamBlock(content: ReadonlyArray<Part>): StreamBlock | undefined {
	const index = content.length - 1;
	const last = content[index];
	if (!last) return undefined;
	if (last.type === "text" && typeof last.text === "string") return { index, field: "text", length: last.text.length };
	if (last.type === "thinking" && typeof last.thinking === "string")
		return { index, field: "thinking", length: last.thinking.length };
	return undefined;
}

/** A shallow copy of `message` whose trailing block is cut to `revealed` characters. */
export function revealMessage<M extends { content: ReadonlyArray<Part> }>(
	message: M,
	block: StreamBlock,
	revealed: number,
): M {
	if (revealed >= block.length) return message;
	const content = message.content.slice();
	const part = content[block.index] as Part;
	const source = (block.field === "text" ? part.text : part.thinking) ?? "";
	content[block.index] = { ...part, [block.field]: source.slice(0, revealed) };
	return { ...message, content };
}

export interface PaceState {
	/** Reveal cursor, UTF-16 units. */
	shown: number;
	/** EMAs of the input: baseline rate and arrival rate (chars/s), and chunk size (chars). */
	cps: number;
	arrivalCps: number;
	chunkSize: number;
	/** The EMAs as they were before the chunk being gathered, so each event of a burst re-derives them. */
	base: { cps: number; arrivalCps: number; chunkSize: number };
	lastInputAt: number;
	lastInputLength: number;
	/** The chunk being gathered: its first event's time, its size, and the time since the chunk before. */
	burstAt: number;
	burstSize: number;
	burstGap: number;
	lastTickAt: number;
	/** The next tick starts a run: its step is one nominal commit interval, not the time since the last one. */
	fresh: boolean;
	/** Active input with the cursor already at its target lag: wait for input or for the window to end. */
	parked: boolean;
	/** After the end: when the backlog must be gone (`maxLagMs` from the first drain tick). Set once, so it is linear. */
	drainBy?: number;
	/** Characters revealed beyond the speed's budget (word snapping, minimum step); paid back by the next ticks. */
	debt: number;
}

/**
 * How long to wait between commits for a message whose open tail has `tailChars` characters: every
 * commit re-parses the tail, so the interval widens with it, up to `maxCommitMs` (streamdown's
 * `min(96, minCommitIntervalMs * (1 + tail / 256))`). The per-character fade hides the lower rate.
 */
export function commitInterval(config: DripConfig, tailChars: number): number {
	if (config.commitTailScale <= 0) return config.minCommitMs;
	return Math.min(Math.max(config.minCommitMs, config.maxCommitMs), config.minCommitMs * (1 + tailChars / config.commitTailScale));
}

/**
 * The language of the last unclosed ``` fence in `text` (`""` for a fence without one), or null when
 * every fence is closed. Looks for three backticks at the start of a line, like streamdown's
 * `findOpenFenceLanguage`; tildes and indented fences are not detected.
 */
export function findOpenFenceLanguage(text: string): string | null {
	let open: string | null = null;
	for (const match of text.matchAll(/^```([^\n`]*)$/gm)) open = open === null ? match[1]!.trim().split(/\s/)[0]! : null;
	return open;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const CHUNK_EMA = 0.35;
/** Events this close to the first of a chunk belong to it. */
const BURST_JOIN_MS = 12;

/** A pacer for a block first seen at `length`; a large first chunk is shown at once. */
export function createPace(length: number, now: number, config: DripConfig): PaceState {
	return {
		shown: length > config.largeAppendChars ? length : 0,
		cps: config.defaultCps,
		arrivalCps: config.defaultCps,
		chunkSize: 1,
		base: { cps: config.defaultCps, arrivalCps: config.defaultCps, chunkSize: 1 },
		lastInputAt: now,
		lastInputLength: length,
		burstAt: now,
		burstSize: 0,
		burstGap: 1,
		lastTickAt: now,
		fresh: true,
		parked: false,
		debt: 0,
	};
}

/** Record that the block has grown to `length`. */
export function noteInput(state: PaceState, length: number, now: number, config: DripConfig): void {
	const previous = state.lastInputLength;
	if (length < state.shown) state.shown = length;
	state.drainBy = undefined;
	const delta = length - previous;
	state.lastInputLength = length;
	if (delta <= 0) return;
	// A run starts again when the cursor had caught up or was parked (streamdown restarts its frame loop).
	if (state.shown >= previous || state.parked) {
		state.fresh = true;
		state.parked = false;
	}
	if (delta > config.largeAppendChars) {
		// streamdown's `syncImmediate`: show it all and forget the measured rates.
		state.shown = length;
		state.cps = state.arrivalCps = config.defaultCps;
		state.chunkSize = 1;
		state.base = { cps: state.cps, arrivalCps: state.arrivalCps, chunkSize: 1 };
		state.burstSize = 0;
		state.lastInputAt = state.burstAt = now;
		return;
	}
	if (state.burstSize > 0 && now - state.burstAt <= BURST_JOIN_MS) state.burstSize += delta;
	else {
		state.base = { cps: state.cps, arrivalCps: state.arrivalCps, chunkSize: state.chunkSize };
		state.burstGap = Math.max(1, now - state.burstAt);
		state.burstAt = now;
		state.burstSize = delta;
	}
	state.lastInputAt = now;
	const { base, burstSize, burstGap } = state;
	const instantCps = (burstSize * 1000) / burstGap;
	state.chunkSize = base.chunkSize * (1 - CHUNK_EMA) + burstSize * CHUNK_EMA;
	state.arrivalCps = base.arrivalCps * (1 - CHUNK_EMA) + clamp(instantCps, config.minCps, config.maxFlushCps * 2) * CHUNK_EMA;
	state.cps = base.cps * (1 - config.emaAlpha) + clamp(instantCps, config.minCps, config.maxActiveCps) * config.emaAlpha;
}

/**
 * Advance the cursor toward `text.length` for a tick at `now`. `ending`: pi has delivered the final
 * message, so drain what is left. Returns the new cursor (also stored in `state.shown`).
 */
export function advance(state: PaceState, text: string, now: number, config: DripConfig, ending = false): number {
	const target = text.length;
	const backlog = target - state.shown;
	if (backlog <= 0) {
		state.debt = 0;
		state.fresh = true;
		state.parked = false;
		return (state.shown = Math.min(state.shown, target));
	}
	const idleMs = now - state.lastInputAt;
	const inputActive = !ending && idleMs <= config.activeInputWindowMs;
	if (state.parked) {
		if (inputActive) return state.shown;
		state.parked = false;
		state.fresh = true;
	}
	const stepMs = state.fresh ? config.minCommitMs : now - state.lastTickAt;
	state.fresh = false;
	state.lastTickAt = now;
	const dtSeconds = clamp(stepMs / 1000, 0.001, 0.12);
	const settling = !inputActive && (ending || idleMs >= config.settleAfterMs);

	const baseCps = clamp(state.cps, config.minCps, config.maxCps);
	const baseLagChars = Math.max(1, Math.round((baseCps * config.targetBufferMs) / 1000));
	const lagUpperBound = Math.max(baseLagChars + 2, baseLagChars * 3);
	const targetLagChars = inputActive ? Math.round(clamp(baseLagChars + state.chunkSize * 0.35, baseLagChars, lagUpperBound)) : 0;
	const desired = Math.max(0, target - targetLagChars);

	let cps: number;
	if (inputActive) {
		const backlogPressure = targetLagChars > 0 ? backlog / targetLagChars : 1;
		const chunkPressure = targetLagChars > 0 ? state.chunkSize / targetLagChars : 1;
		const arrivalPressure = state.arrivalCps / Math.max(baseCps, 1);
		const pressure = clamp(backlogPressure * 0.6 + chunkPressure * 0.25 + arrivalPressure * 0.15, 1, 4.5);
		const activeCap = clamp(config.maxActiveCps + state.chunkSize * 6, config.maxActiveCps, config.maxFlushCps);
		cps = clamp(baseCps * pressure, config.minCps, activeCap);
	} else if (settling) {
		// Cap the time the leftover takes, instead of replaying old backlog for seconds.
		const drainMs = clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs);
		cps = clamp((backlog * 1000) / drainMs, config.flushCps, config.maxFlushCps);
	} else {
		cps = clamp(Math.max(config.flushCps, baseCps * 1.8, state.arrivalCps * 0.8), config.flushCps, config.maxFlushCps);
	}
	// The one deviation from streamdown: nothing waits longer than about `maxLagMs`. While input
	// flows that bounds the rate by the backlog; after the end it is a deadline, so the drain is linear.
	if (ending) {
		state.drainBy ??= now + config.maxLagMs;
		cps = Math.max(cps, (backlog * 1000) / Math.max(config.tickMs, state.drainBy - now));
	} else cps = Math.max(cps, (backlog * 1000) / config.maxLagMs);

	const urgent = inputActive && targetLagChars > 0 && backlog > targetLagChars * 2.2;
	const bursty = inputActive && state.chunkSize >= targetLagChars * 0.9;
	const minReveal = inputActive ? (urgent || bursty ? 2 : 1) : 2;
	const budget = Math.round(cps * dtSeconds);
	let reveal = Math.max(minReveal, budget - Math.round(state.debt));
	if (inputActive) {
		const shortfall = desired - state.shown;
		if (shortfall <= 0) {
			state.parked = true;
			return state.shown;
		}
		reveal = Math.min(reveal, shortfall, backlog);
	} else reveal = Math.min(reveal, backlog);

	const paced = snap(text, state.shown + reveal);
	// Blocks that are already finished in the backlog are shown at once; only the open tail is
	// paced (streamdown's `completeEnd` jump). They still fade in.
	const complete = paced < target ? completeEnd(text, state.shown, target) : 0;
	const next = Math.max(paced, complete);
	state.debt = complete > paced ? 0 : Math.max(0, state.debt + (next - state.shown) - budget);
	return (state.shown = next);
}

const BLANK_LINE = /\n(?:[\t \r]*\n)+/g;
const LIST_OR_INDENTED = /^(?: {4}|\t| {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * End of the last finished top-level block in `text[from, to)`: just past its blank line, or 0. A
 * block before a blank line is finished unless it sits in an open code fence, or it or the
 * next one is a list or indented code (which a blank line does not end: streamdown's lexer keeps
 * those open). Only scanned when the backlog holds a blank line.
 */
export function completeEnd(text: string, from: number, to: number): number {
	const pending = text.slice(from, to);
	if (!/\n[\t \r]*\n/.test(pending)) return 0;
	let best = 0;
	BLANK_LINE.lastIndex = 0;
	for (const match of pending.matchAll(BLANK_LINE)) {
		const start = from + match.index;
		const end = start + match[0].length;
		// More must follow the blank line: until then the block could still continue.
		if (end >= to) break;
		const before = text.lastIndexOf("\n\n", start - 1);
		const blockStart = before < 0 ? 0 : before + 2;
		const block = text.slice(blockStart, start);
		const nextLine = text.slice(end, text.indexOf("\n", end) + 1 || to);
		if (LIST_OR_INDENTED.test(block) || LIST_OR_INDENTED.test(nextLine)) continue;
		best = end;
	}
	if (best && findOpenFenceLanguage(text.slice(0, best)) !== null) return 0;
	return best;
}

const BOUNDARY = /[\s.,;:!?)\]}>，。；：！？、）】》]/;
const SNAP_LOOKAHEAD = 8;

/** Prefer a word or punctuation boundary (CJK has none: stop where we are); never split a pair. */
function snap(text: string, cursor: number): number {
	if (cursor >= text.length) return text.length;
	if (!BOUNDARY.test(text[cursor - 1] ?? "")) {
		const limit = Math.min(text.length, cursor + SNAP_LOOKAHEAD);
		for (let i = cursor; i < limit; i++) {
			if (BOUNDARY.test(text[i] ?? "")) {
				cursor = i + 1;
				break;
			}
		}
	}
	const code = text.charCodeAt(cursor - 1);
	if (code >= 0xd800 && code <= 0xdbff && cursor < text.length) cursor++;
	return cursor;
}
