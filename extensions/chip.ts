/**
 * The run's state as a flat label in the editor's status row once the agent is not busy:
 *
 *   ✓ done 1m05s      ✕ failed 12s      ❚❚ paused 12s      ● running 26s      ● at risk 1m33s
 *
 * The live dot blinks (dim / lit half), faster at risk. Empty while idle.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DREAMWALKER } from "./config.ts";
import { formatElapsed } from "./format.ts";
import { chipState, type RunSignal } from "./signal.ts";

const CHIP_WORD = { running: "running", risk: "at risk", paused: "paused", done: "done", failed: "failed" } as const;

export function renderChip(t: Theme, state: RunSignal, now: number): string {
	const { phase, seconds, off } = chipState(state, now);
	if (phase === "idle") return "";
	const g = DREAMWALKER.glyph;
	const live = phase === "running" || phase === "risk";
	const glyph = phase === "paused" ? g.pause : phase === "done" ? g.pass : phase === "failed" ? g.fail : g.live;
	const color = phase === "risk" || phase === "failed" ? "error" : phase === "paused" ? "muted" : "success";
	const mark = t.fg(live && off ? "dim" : color, glyph);
	const word = t.fg(phase === "paused" || phase === "running" ? "muted" : color, CHIP_WORD[phase]);
	return `${mark} ${word} ${t.fg("dim", formatElapsed(seconds))}`;
}
