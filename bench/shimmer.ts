/**
 * Editor border shimmer cost. Run: `node bench/shimmer.ts`
 *
 * Drives pi-tui's real main-screen renderer (render tree → line diff → terminal writes) against a
 * capturing terminal, with a long chat above the editor, and compares, while the agent is busy:
 *
 *   off: today — pi's spinner repaints the border every 80 ms (12.5 fps)
 *   on:  shimmer — the band moves every `shimmerInterval(frame cost)` ms (tickMs..maxTickMs, adaptive
 *        to the cost of a repaint), spinner frames included
 *
 * Reported per frame and per second of busy time: CPU of a whole frame (render + diff + write),
 * the editor's own render, changed lines, and bytes written to the terminal.
 */
import { performance } from "node:perf_hooks";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme, getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Container, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { DreamEditor } from "../extensions/editor.ts";
import { DreamFooter } from "../extensions/footer.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { shimmerInterval } from "../extensions/shimmer.ts";

initTheme("dark");
const WIDTH = Number(process.env.WIDTH ?? 160);
const ROWS = 50;
const SECONDS = 3;

let written = 0;
const term: Terminal = {
	start() {},
	stop() {},
	async drainInput() {},
	write(data: string) {
		written += Buffer.byteLength(data);
	},
	get columns() {
		return WIDTH;
	},
	get rows() {
		return ROWS;
	},
	get kittyProtocolActive() {
		return false;
	},
	moveBy() {},
	hideCursor() {},
	showCursor() {},
	clearLine() {},
	clearScreen() {},
	clearFromCursor() {},
	setTitle() {},
	setProgress() {},
	setProgramStatus() {},
};

const tui = new TuiMainScreen(term);
(tui as unknown as { requestRender(): void }).requestRender = () => {}; // frames are driven below
const doRender = () => (tui as unknown as { doRender(): void }).doRender();

// A long session: 120 finished answers (Markdown, code, lists).
const chat = new Container();
const body =
	"Some **markdown** text with `code` and words, the quick brown fox jumps over the lazy dog. ".repeat(4) +
	"\n\n- item a\n- item b\n\n```ts\nconst x = 1;\nfunction f() { return x; }\n```\n\n中文段落，包含 **加粗** 和 `code`。";
const ANSWERS = Number(process.env.ANSWERS ?? 120);
for (let i = 0; i < ANSWERS; i++) {
	const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
	c.updateContent({ role: "assistant", content: [{ type: "text", text: body }], timestamp: 1, stopReason: "stop", model: "m", usage: undefined } as never, false);
	chat.addChild(c);
}

const editor = new DreamEditor(
	tui,
	getEditorTheme(),
	{ matches: () => false, getKeys: () => ["escape"] } as unknown as KeybindingsManager,
	() => piTheme as Theme,
	() => ({ provider: "magpie", model: "claude/opus", thinking: "high", runStart: 1_000_000 }),
	0,
);
editor.borderColor = (s) => (piTheme as Theme).getThinkingBorderColor("high")(s);
editor.setText("draft prompt while the agent works");

// pi's working indicator: a braille spinner advancing every 80 ms of the (fake) clock.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let clock = 1_000_000;
const indicator = {
	kind: "working",
	message: "Working",
	messageColorFn: (s: string) => (piTheme as Theme).fg("muted", s),
	renderInBorder: () => `${(piTheme as Theme).fg("accent", SPIN[Math.floor(clock / 80) % SPIN.length]!)} ${(piTheme as Theme).fg("muted", "Working…")}`,
	renderSpinnerInBorder: () => SPIN[Math.floor(clock / 80) % SPIN.length]!,
};
(editor as unknown as { setWorkingStatusIndicator(i: unknown): void }).setWorkingStatusIndicator(indicator);
editor.shimmerNow = () => clock;

const data = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} } as unknown as ReadonlyFooterDataProvider;
const footer = new DreamFooter(() => piTheme as Theme, data, () => undefined, () => {});

tui.addChild(chat);
tui.addChild(editor);
tui.addChild(footer);
tui.setFocus(editor);

const features = DREAMWALKER.features as { borderShimmer: boolean };
const realSetTimeout = globalThis.setTimeout;
// The editor's own ticker would request frames; this bench drives frames itself.
globalThis.setTimeout = (() => ({ unref() {} })) as never;

function run(shimmer: boolean, fps: number) {
	features.borderShimmer = shimmer;
	const step = 1000 / fps;
	const frames = Math.round(SECONDS * fps);
	// Warm up (JIT, caches, first full paint).
	for (let i = 0; i < 300; i++) {
		clock += step;
		doRender();
	}
	let prev = (tui as unknown as { render(w: number): string[] }).render(WIDTH);
	let changed = 0;
	let frameMs = 0;
	let editorMs = 0;
	written = 0;
	for (let i = 0; i < frames; i++) {
		clock += step;
		const t0 = performance.now();
		doRender();
		frameMs += performance.now() - t0;
		const e0 = performance.now();
		editor.render(WIDTH);
		editorMs += performance.now() - e0;
		const lines = (tui as unknown as { render(w: number): string[] }).render(WIDTH);
		for (let l = 0; l < lines.length; l++) if (lines[l] !== prev[l]) changed++;
		prev = lines;
	}
	return {
		lines: prev.length,
		fps,
		frameUs: (frameMs / frames) * 1000,
		editorUs: (editorMs / frames) * 1000,
		cpuMsPerSec: frameMs / SECONDS,
		changedPerFrame: changed / frames,
		bytesPerFrame: written / frames,
		kbPerSec: written / SECONDS / 1024,
	};
}

const off = run(false, 1000 / 80);
// The editor picks its interval from the measured repaint cost; use the same rule here.
const on = run(true, 1000 / shimmerInterval(off.frameUs / 1000));
globalThis.setTimeout = realSetTimeout;

const row = (name: string, r: ReturnType<typeof run>) =>
	`  ${name.padEnd(22)} ${r.fps.toFixed(1).padStart(5)} fps  frame ${r.frameUs.toFixed(0).padStart(5)} µs  editor ${r.editorUs.toFixed(1).padStart(5)} µs  ` +
	`changed ${r.changedPerFrame.toFixed(2)} lines  ${r.bytesPerFrame.toFixed(0).padStart(5)} B/frame  ` +
	`→ ${r.cpuMsPerSec.toFixed(2)} ms CPU/s (${(r.cpuMsPerSec / 10).toFixed(2)}% core), ${r.kbPerSec.toFixed(1)} KB/s`;

console.log(`[shimmer] width ${WIDTH}, ${on.lines} rendered lines (${ANSWERS}-answer session), ${SECONDS}s busy each`);
console.log(row("off (spinner only)", off));
console.log(row("on  (border shimmer)", on));
console.log(`  delta: +${(on.cpuMsPerSec - off.cpuMsPerSec).toFixed(2)} ms CPU per busy second, +${(on.kbPerSec - off.kbPerSec).toFixed(1)} KB/s to the terminal`);
process.exit(0);
