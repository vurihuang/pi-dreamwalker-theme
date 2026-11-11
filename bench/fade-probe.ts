/**
 * Does your terminal show the stream fade? Prints the fade's ramp (the colors a new character
 * steps through, from the terminal background to the text color) as rows of text, then the same
 * with SGR 2 faint. Run in the terminal you stream in: `node bench/fade-probe.ts`.
 *
 * Read it: a working terminal shows each row getting steadily brighter left to right. If the first
 * several steps look the same, or the row jumps to near full brightness at once, the terminal is
 * raising dark text to a minimum contrast (Ghostty-based terminals: "minimum contrast" / "improve
 * text contrast") and the fade cannot show; turn that setting off to see it. Env: BG=#rrggbb
 * (default: asked from the terminal, OSC 11), FG=#rrggbb (text color, default #dcdcda), STEPS (12).
 */
import { colorToRgb, rgbColor } from "@earendil-works/pi-tui";
import { faint } from "../extensions/stream-markdown.ts";

const steps = Number(process.env.STEPS ?? 12);
const hex = (value: string) => rgbColor(parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16));

async function terminalBackground(): Promise<string | undefined> {
	if (!process.stdin.isTTY) return undefined;
	return new Promise((resolve) => {
		let reply = "";
		const done = (value?: string) => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			resolve(value);
		};
		const onData = (data: Buffer) => {
			reply += data.toString("latin1");
			const match = reply.match(/rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
			if (!match) return;
			const channel = (c: string) => Math.round((parseInt(c, 16) / (16 ** c.length - 1)) * 255).toString(16).padStart(2, "0");
			done(`#${channel(match[1]!)}${channel(match[2]!)}${channel(match[3]!)}`);
		};
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdout.write("\x1b]11;?\x07");
		setTimeout(done, 800);
	});
}

const bg = process.env.BG ?? (await terminalBackground()) ?? "#101014";
const fg = process.env.FG ?? "#dcdcda";
const text = "The quick brown fox";
const base = hex(fg);
const palette = { from: hex(bg), base, mode: "truecolor" as const };
const rgb = colorToRgb(palette.from);
console.log(`background ${bg} (${rgb.r},${rgb.g},${rgb.b}), text ${fg}, ${steps} steps\n`);

const row = (label: string, line: string) => console.log(`${label.padEnd(10)}${line}\x1b[0m`);
// One word per step: age 0 → fadeMs spread over the steps.
const fadeMs = 180;
for (let step = 0; step < steps; step++) {
	const age = ((step + 0.5) / steps) * fadeMs;
	const line = faint(text, Array.from({ length: text.length }, () => 1000), 0, 1000 + age, fadeMs, { palette, steps, granularity: "char" });
	row(`step ${step + 1}`, line);
}
row("settled", text);
console.log("");
row("faint", `\x1b[2m${text}`);
row("normal", text);
