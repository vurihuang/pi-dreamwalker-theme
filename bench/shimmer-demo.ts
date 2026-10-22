/**
 * Watch the editor border shimmer in your terminal. Run: `node bench/shimmer-demo.ts [seconds]`
 * Draws the real DreamEditor in busy state at the configured frame rate, then idle for 1 s.
 * Env: THEME (dreamwalker), LEVEL (thinking level shown in the status row).
 */
import { fileURLToPath } from "node:url";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	getEditorTheme,
	loadThemeFromPath,
	setThemeInstance,
	theme as piTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { TUI } from "@earendil-works/pi-tui";
import { DreamEditor } from "../extensions/editor.ts";
import { DREAMWALKER } from "../extensions/config.ts";

setThemeInstance(loadThemeFromPath(fileURLToPath(new URL(`../themes/${process.env.THEME ?? "dreamwalker"}.json`, import.meta.url))));
const t = piTheme as Theme;
const width = Math.min(process.stdout.columns || 100, 140);
const seconds = Number(process.argv[2] ?? 8);

const tui = { terminal: { rows: 40, columns: width }, requestRender() {} } as unknown as TUI;
const editor = new DreamEditor(
	tui,
	getEditorTheme(),
	{ matches: () => false, getKeys: () => ["escape"] } as unknown as KeybindingsManager,
	() => t,
	() => ({ provider: "magpie", model: "devin/swe-2", thinking: process.env.LEVEL ?? "high", runStart }),
	0,
);
editor.borderColor = t.getThinkingBorderColor((process.env.LEVEL ?? "high") as "high"); // pi sets this from the thinking level
editor.setText("What are we cooking?");

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let busy = true;
const runStart = Date.now();
const indicator = {
	get kind() {
		return busy ? "working" : "idle";
	},
	message: "Working",
	messageColorFn: (s: string) => t.fg("muted", s),
	renderInBorder: () => "",
	renderSpinnerInBorder: () => t.fg("accent", SPIN[Math.floor(Date.now() / 80) % SPIN.length]!),
};
(editor as unknown as { setWorkingStatusIndicator(i: unknown): void }).setWorkingStatusIndicator(indicator);

let drawn = 0;
const draw = () => {
	const lines = editor.render(width).map((l) => l.replace(/\x1b_pi:[^\x07]*\x07/g, ""));
	let out = "\x1b[?2026h";
	if (drawn) out += `\x1b[${drawn}A`;
	out += lines.map((l) => `\r\x1b[2K${l}`).join("\n") + "\n";
	out += "\x1b[?2026l";
	process.stdout.write(out);
	drawn = lines.length;
};

process.stdout.write("\x1b[?25l\n");
const timer = setInterval(draw, DREAMWALKER.shimmer.tickMs);
setTimeout(() => (busy = false), seconds * 1000);
setTimeout(() => {
	clearInterval(timer);
	draw();
	process.stdout.write("\x1b[?25h");
	process.exit(0);
}, seconds * 1000 + 1000);
