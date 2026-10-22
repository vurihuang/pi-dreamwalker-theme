/**
 * Native parity: the tool rows must not change what pi's own renderers show, at any streaming step.
 *
 * Each case drives pi's real `ToolExecutionComponent` through the same sequence twice (pi's native
 * renderers vs. the same renderers wrapped by this package), renders every step with the tool
 * expanded (ctrl+o: a folded call hides its own rows), removes only the decoration (pi's background
 * box padding / this package's indent) and the call row itself (this package rebuilds it as
 * `Verb target`), and compares the content.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	type Theme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { Chronicle } from "../extensions/chronicle.ts";
import { DREAMWALKER } from "../extensions/config.ts";
import { installMessageChrome, uninstallMessageChrome } from "../extensions/messages.ts";
import { createToolRenderers } from "../extensions/tools.ts";

initTheme("dark");

const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g;
const WIDTH = 100;
const OUTPUT_PAD = 1;
const GUTTER = OUTPUT_PAD + DREAMWALKER.bodyIndent + 2;
const ui = { requestRender() {} };
// The summary line only adds a row under the call row; parity is about pi's own content (the line has its own tests).
DREAMWALKER.features.resultLine = false;
// Timers ("Took 0.1s", elapsed) depend on wall clock, not on rendering.
const TIMER = /^(Took|Elapsed) [\d.]+m?s/;

type Step =
	| { kind: "args"; args: Record<string, unknown> }
	| { kind: "argsComplete" }
	| { kind: "start" }
	| { kind: "result"; text: string; partial: boolean; details?: unknown; isError?: boolean };

function contentLines(lines: string[], strip: number): string[] {
	return lines
		.map((line) => line.replace(ANSI, "").replace(/\s+$/, ""))
		.filter((line) => line.trim() !== "" && !/^─+$/.test(line.trim())) // the hairline above output
		.slice(1) // the call row
		.map((line) => line.slice(strip))
		.filter((line) => line.trim() !== "" && !TIMER.test(line.trim()));
}

function play(toolName: string, definition: unknown, initialArgs: Record<string, unknown>, steps: Step[], strip: number) {
	const component = new ToolExecutionComponent(
		toolName,
		"call-1",
		initialArgs,
		{ showImages: false, outputPad: OUTPUT_PAD },
		definition as never,
		ui as never,
		"/tmp",
	);
	component.setExpanded(true);
	const frames = [contentLines(component.render(WIDTH), strip)];
	for (const step of steps) {
		if (step.kind === "args") component.updateArgs(step.args);
		else if (step.kind === "argsComplete") component.setArgsComplete();
		else if (step.kind === "start") component.markExecutionStarted();
		else
			component.updateResult(
				{ content: [{ type: "text", text: step.text }], details: step.details, isError: step.isError ?? false } as never,
				step.partial,
			);
		frames.push(contentLines(component.render(WIDTH), strip));
	}
	return frames;
}

function assertParity(toolName: string, native: unknown, initialArgs: Record<string, unknown>, steps: Step[]) {
	const wrapped = createToolRenderers(toolName, native as never);
	const nativeFrames = play(toolName, native, initialArgs, steps, OUTPUT_PAD);
	const wrappedFrames = play(toolName, wrapped, initialArgs, steps, GUTTER);
	assert.equal(wrappedFrames.length, nativeFrames.length);
	for (let i = 0; i < nativeFrames.length; i++) {
		assert.deepEqual(wrappedFrames[i], nativeFrames[i], `${toolName}: step ${i} differs`);
	}
	return nativeFrames;
}

const file = Array.from({ length: 30 }, (_, i) => `export const f${i + 1} = () => ${i + 1};`).join("\n");

test("write: streaming args render exactly like pi (incremental highlight, 10-line preview)", () => {
	const steps: Step[] = [];
	for (let cut = 40; cut < file.length; cut += 97) steps.push({ kind: "args", args: { path: "/tmp/demo.ts", content: file.slice(0, cut) } });
	steps.push({ kind: "args", args: { path: "/tmp/demo.ts", content: file } });
	steps.push({ kind: "argsComplete" }, { kind: "start" }, { kind: "result", text: "Wrote 30 lines", partial: false });
	const frames = assertParity("write", withBuiltInRenderers("write", undefined), { path: "/tmp/demo.ts" }, steps);
	// Sanity: content really streams in (grows across steps) and ends with pi's collapse hint.
	assert.ok(frames[1]!.length < frames[4]!.length);
	assert.ok(frames.at(-1)!.some((line) => line.includes("export const f30")));
});

test("bash: partial output streams exactly like pi", () => {
	const steps: Step[] = [{ kind: "argsComplete" }, { kind: "start" }];
	let out = "";
	for (let i = 1; i <= 8; i++) {
		out += `${out ? "\n" : ""}tick-${i}`;
		steps.push({ kind: "result", text: out, partial: true });
	}
	steps.push({ kind: "result", text: out, partial: false });
	const frames = assertParity("bash", withBuiltInRenderers("bash", undefined), { command: "for i in …; do echo; done" }, steps);
	assert.ok(frames.some((frame) => frame.includes("tick-3") && !frame.includes("tick-4")), "output grows step by step");
});

test("read / grep / find / ls: native content preserved", () => {
	const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
	const cases: Array<[string, Record<string, unknown>]> = [
		["read", { path: "/tmp/a.ts", offset: 1, limit: 25 }],
		["grep", { pattern: "foo", path: "/tmp" }],
		["find", { pattern: "*.ts", path: "/tmp" }],
		["ls", { path: "/tmp" }],
	];
	for (const [name, args] of cases) {
		assertParity(name, withBuiltInRenderers(name, undefined), args, [
			{ kind: "argsComplete" },
			{ kind: "start" },
			{ kind: "result", text: body, partial: false },
		]);
	}
});

test("edit: diff content preserved, card background dropped", () => {
	const native = { renderShell: "self" as const, ...withBuiltInRenderers("edit", undefined) };
	const args = { path: "/tmp/nonexistent-dream.ts", edits: [{ oldText: "a", newText: "b" }] };
	const diff = " 1 keep\n-2 const a = 1;\n+2 const b = 1;\n 3 tail";
	const steps: Step[] = [
		{ kind: "start" },
		{ kind: "result", text: "Successfully replaced 1 block(s)", partial: false, details: { diff, firstChangedLine: 2 } },
	];
	const frames = assertParity("edit", native, args, steps);
	assert.ok(frames.at(-1)!.some((line) => line.includes("const b = 1")), "diff is shown");

	// No status background anywhere, and the diff hangs under the `Edit` row even folded.
	const component = new ToolExecutionComponent("edit", "c", args, { showImages: false, outputPad: OUTPUT_PAD }, createToolRenderers("edit", native) as never, ui as never, "/tmp");
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff, firstChangedLine: 2 }, isError: false } as never, false);
	const lines = component.render(WIDTH);
	assert.ok(!lines.some((line) => /\x1b\[48[;:]/.test(line)), "no background SGR");
	const plain = lines.map((line) => line.replace(ANSI, "")).filter((line) => line.trim());
	assert.match(plain[0]!, /^ {3}Edit /);
	assert.ok(plain.some((line) => line.includes("const b = 1")), plain.join("\n"));
	assert.ok(plain.slice(1).every((line) => line.startsWith(" ".repeat(GUTTER))), plain.join("\n"));
});

test("errors: native error text preserved", () => {
	assertParity("write", withBuiltInRenderers("write", undefined), { path: "/tmp/x", content: "a" }, [
		{ kind: "argsComplete" },
		{ kind: "start" },
		{ kind: "result", text: "EACCES: permission denied", partial: false, isError: true },
	]);
});

test("thinking: streaming and hidden-thinking output identical to pi apart from the mark and indent", () => {
	const theme = () => piTheme as Theme;
	const chronicle = new Chronicle();
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me plan.\n\nFirst read the file, then **edit** it." },
			{ type: "text", text: "Here is the answer." },
		],
		timestamp: 42,
		stopReason: "stop",
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	};
	const render = (hide: boolean, streaming: boolean) => {
		const component = new AssistantMessageComponent(undefined, hide, getMarkdownTheme(), "Thinking...", OUTPUT_PAD);
		component.updateContent(message as never, streaming);
		return component.render(WIDTH).map((line) => line.replace(ANSI, "").replace(/\s+$/, ""));
	};
	for (const hide of [false, true]) {
		for (const streaming of [true, false]) {
			uninstallMessageChrome();
			const native = render(hide, streaming).filter((line) => line.trim());
			installMessageChrome({ theme, chronicle, notify() {}, showRunStats: true });
			chronicle.onAgentStart(0);
			chronicle.onAssistantStart(message as never);
			const ours = render(hide, streaming)
				.filter((line) => line.trim() && !line.includes(DREAMWALKER.glyph.stats))
				.map((line) => line.replace(DREAMWALKER.glyph.assistant, " ").slice(DREAMWALKER.bodyIndent));
			assert.deepEqual(ours, native, `hide=${hide} streaming=${streaming}`);
		}
	}
	uninstallMessageChrome();
});
