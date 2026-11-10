/**
 * Smooth streaming ("text drip"): the reveal pacer.
 *
 * Providers often deliver tokens in bursts: many updates in the same millisecond, then a pause of
 * 100–600 ms. Painting each burst as it lands makes text jump; draining each burst as fast as
 * possible makes it stop and start. Like @lobehub/streamdown's smoother, the pacer keeps a reserve
 * so the text keeps moving between chunks; unlike it, it never has to guess whether the stream has
 * ended, because pi says so (the final update), so it needs no idle/settle heuristics:
 *
 * - While streaming, the backlog is spread over the time until the next chunk is expected (an EMA
 *   of the chunk interval) plus `targetBufferMs`, so a little is still left when the chunk lands.
 * - Lag is bounded: any backlog is revealed within about `maxLagMs`.
 * - When the message has ended, what is left drains linearly at the arrival rate, within
 *   `settleDrainMinMs`–`settleDrainMaxMs`, instead of being dumped in one frame.
 * - Fractional progress carries over between ticks, so word snapping does not inflate the rate.
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
	/** Any backlog is revealed within about this long. */
	maxLagMs: number;
	/** Floor of the end-of-message drain rate, chars/s. */
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
	/** EMA of the time between chunks, ms. */
	gap: number;
	/** EMA of the arrival rate, chars/s. */
	rate: number;
	lastInputAt: number;
	lastInputLength: number;
	lastTickAt: number;
	/** Fractional chars owed; word snapping overshoots are paid back from it, so rates stay exact. */
	carry: number;
	/** After the end: when the backlog must be gone. Set once, so the drain is linear. */
	drainBy?: number;
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
const EMA = 0.3;
const MAX_GAP_MS = 1000;

/** A pacer for a block first seen at `length`; a large first chunk is shown at once. */
export function createPace(length: number, now: number, config: DripConfig): PaceState {
	return {
		shown: length > config.largeAppendChars ? length : 0,
		gap: config.tickMs * 2,
		rate: config.flushCps,
		lastInputAt: now,
		lastInputLength: length,
		lastTickAt: now,
		carry: 0,
	};
}

/** Record that the block has grown to `length`. */
export function noteInput(state: PaceState, length: number, now: number, config: DripConfig): void {
	if (length < state.shown) state.shown = length;
	state.drainBy = undefined;
	const delta = length - state.lastInputLength;
	state.lastInputLength = length;
	if (delta <= 0) return;
	if (delta > config.largeAppendChars) state.shown = length;
	const gap = clamp(now - state.lastInputAt, 1, MAX_GAP_MS);
	state.gap = state.gap * (1 - EMA) + gap * EMA;
	state.rate = state.rate * (1 - EMA) + ((delta * 1000) / Math.max(gap, config.tickMs)) * EMA;
	state.lastInputAt = now;
}

/**
 * Advance the cursor toward `text.length` for a tick at `now`. `ending`: pi has delivered the final
 * message, so drain what is left. Returns the new cursor (also stored in `state.shown`).
 */
export function advance(state: PaceState, text: string, now: number, config: DripConfig, ending = false): number {
	const target = text.length;
	const backlog = target - state.shown;
	const dt = clamp(now - state.lastTickAt, 1, 120);
	state.lastTickAt = now;
	if (backlog <= 0) {
		state.carry = 0;
		return (state.shown = Math.min(state.shown, target));
	}

	let cps: number;
	if (ending) {
		// streamdown's settle: 8 ms per char, within the preset's drain window.
		state.drainBy ??= now + clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs);
		cps = (backlog * 1000) / Math.max(config.tickMs, state.drainBy - now);
	} else {
		// Make the backlog last until the next expected chunk, plus the reserve.
		const untilNext = Math.max(0, state.lastInputAt + state.gap - now) + config.targetBufferMs;
		cps = Math.max((backlog * 1000) / untilNext, (backlog * 1000) / config.maxLagMs);
	}

	state.carry = Math.min(state.carry + (cps * dt) / 1000, backlog);
	const paced = state.carry < 1 ? state.shown : snap(text, state.shown + Math.floor(state.carry));
	// Blocks that are already finished in the backlog are shown at once; only the open tail is
	// paced (streamdown's `completeEnd` jump). They still fade in.
	const complete = paced < target ? completeEnd(text, state.shown, target) : 0;
	if (complete > paced) {
		state.carry = 0;
		return (state.shown = complete);
	}
	state.carry -= paced - state.shown;
	return (state.shown = paced);
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
