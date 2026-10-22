/**
 * Run signal: one small state machine for "how is this run going", fed by extension events only
 * (agent start/end, tool start, tool result). It never polls and owns no ticker; everything that
 * reads it (editor frame and status row, tool rows) pulls the state while it paints, and caches its
 * own output by the few values below.
 *
 *   idle      nothing to show (no run yet, or the user touched the editor after a pause)
 *   running   the agent works
 *   risk      it looks stuck: `failStreak` failed tools in a row, or the same call repeated
 *             `repeats` times inside the last `window` calls with at least two failures
 *             (a failing test and the same patch over and over). Leaves after `recover`
 *             successes in a row.
 *   paused    the run was aborted (esc); stays until the user types again
 *   done      the run finished
 *   failed    the run ended with a provider/tool error
 *
 * Failures flash in discrete steps (lit, off, lit, off), not a fade: a terminal has no opacity, and
 * steps read as a blink. The flash is a function of wall time. A few unref'd timers ask for a frame
 * at each step boundary, so nothing runs between failures.
 */
import { DREAMWALKER } from "./config.ts";

export type Phase = "idle" | "running" | "risk" | "paused" | "done" | "failed";

/** Clock for the flash and the chip (overridable for tests). */
export const clock = { now: (): number => Date.now() };

export interface RunSignal {
	phase: Phase;
	/** Run start / end (ms epoch); 0 when unset. */
	startedAt: number;
	endedAt: number;
	/** When the current risk began; 0 outside risk. */
	riskSince: number;
	/** Tool call the agent started last in this run (the playhead). */
	currentCall: string | undefined;
}

interface Entry {
	sig: string;
	error: boolean;
}

/** What identifies "the same call": the tool and its main argument. */
function signature(toolName: string, input: Record<string, unknown> | undefined): string {
	const arg = input?.path ?? input?.file_path ?? input?.command ?? input?.pattern ?? input?.query ?? input?.url;
	return `${toolName}|${typeof arg === "string" ? arg.slice(0, 120) : ""}`;
}

export class RunState implements RunSignal {
	phase: Phase = "idle";
	startedAt = 0;
	endedAt = 0;
	riskSince = 0;
	currentCall: string | undefined;
	private recent: Entry[] = [];
	private fails = 0;
	private oks = 0;

	reset(): void {
		this.phase = "idle";
		this.startedAt = this.endedAt = this.riskSince = 0;
		this.currentCall = undefined;
		this.clearWindow();
	}

	private clearWindow(): void {
		this.recent.length = 0;
		this.fails = this.oks = 0;
	}

	agentStart(now = clock.now()): void {
		this.phase = "running";
		this.startedAt = now;
		this.endedAt = 0;
		this.riskSince = 0;
		this.currentCall = undefined;
		this.clearWindow();
	}

	/** `stopReason` of the run's last assistant message. */
	agentEnd(stopReason: string | undefined, now = clock.now()): void {
		this.endedAt = now;
		this.riskSince = 0;
		this.currentCall = undefined;
		this.phase = stopReason === "aborted" ? "paused" : stopReason === "error" ? "failed" : "done";
		this.clearWindow();
	}

	/** First key after a pause: the editor is the user's again. */
	touch(): void {
		if (this.phase === "paused") this.phase = "idle";
	}

	toolStart(toolCallId: string, parentToolCallId?: string): void {
		if (!parentToolCallId) this.currentCall = toolCallId;
	}

	/** Returns true when this result moved the run into risk (the caller flashes). */
	toolResult(toolName: string, input: Record<string, unknown> | undefined, isError: boolean, parentToolCallId?: string): boolean {
		if (parentToolCallId || (this.phase !== "running" && this.phase !== "risk")) return false;
		const { window, failStreak, recover } = DREAMWALKER.signal;
		this.recent.push({ sig: signature(toolName, input), error: isError });
		if (this.recent.length > window) this.recent.shift();
		if (isError) {
			this.fails++;
			this.oks = 0;
		} else {
			this.fails = 0;
			this.oks++;
		}
		if (this.phase === "running") {
			if (this.fails >= failStreak || this.looping()) {
				this.phase = "risk";
				this.riskSince = startFlash();
				return true;
			}
		} else if (this.oks >= recover) {
			this.phase = "running";
			this.riskSince = 0;
			this.clearWindow();
		}
		return false;
	}

	/** At least two failures among the recent calls, and one call made `repeats` times. */
	private looping(): boolean {
		let errors = 0;
		const counts = new Map<string, number>();
		for (const entry of this.recent) {
			if (entry.error) errors++;
			counts.set(entry.sig, (counts.get(entry.sig) ?? 0) + 1);
		}
		if (errors < 2) return false;
		for (const n of counts.values()) if (n >= DREAMWALKER.signal.repeats) return true;
		return false;
	}
}

/** The live run (one per process). */
export const signal = new RunState();

// ── Flash ──────────────────────────────────────────────────────────────────────────────────────

let renderHook: (() => void) | undefined;

/** Where flash frames are requested (the TUI captured by the editor or footer). */
export function setFlashRender(request: (() => void) | undefined): void {
	renderHook = request;
}

/**
 * Begin a flash now. Returns its start time; asks for one frame at each step boundary (and one after
 * the last, to repaint the settled state).
 */
export function startFlash(): number {
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	for (let k = 1; k <= flashSteps; k++) {
		const timer = setTimeout(() => renderHook?.(), k * flashStepMs + 1);
		timer.unref?.();
	}
	return clock.now();
}

/** Step of a flash that began at `since`: 0..flashSteps-1 while it runs, -1 outside it (or never began). */
export function flashStep(since: number, now = clock.now()): number {
	if (!since) return -1;
	const { flashStepMs, flashSteps } = DREAMWALKER.signal;
	const step = Math.floor((now - since) / flashStepMs);
	return step >= 0 && step < flashSteps ? step : -1;
}

/** Even steps are lit. */
export const isLit = (step: number): boolean => step >= 0 && step % 2 === 0;

// ── Status chip ────────────────────────────────────────────────────────────────────────────────

/** Blink half-period (ms) of the chip's dot: running calmly, at risk quickly (Aphelion's 1.4 s / 0.6 s). */
export const BLINK_MS = { running: 700, risk: 300 };

/** The chip's inputs: phase, elapsed whole seconds, and whether the blinking dot is in its dim half (1) or lit half (0). */
export function chipState(state: RunSignal, now: number): { phase: Phase; seconds: number; off: 0 | 1 } {
	const { phase } = state;
	const live = phase === "running" || phase === "risk";
	const seconds = Math.max(0, Math.floor(((live ? now : state.endedAt) - state.startedAt) / 1000));
	const off = live ? ((Math.floor(now / BLINK_MS[phase === "risk" ? "risk" : "running"]) & 1) as 0 | 1) : 0;
	return { phase, seconds, off };
}
