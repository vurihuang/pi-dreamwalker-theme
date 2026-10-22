/** Bash call highlighting: heredoc split, language detection, colored output. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DREAMWALKER } from "../extensions/config.ts";
import { highlighterReady } from "../extensions/highlight.ts";
import { heredocLanguage, highlightCommand, splitHeredocs } from "../extensions/shell-highlight.ts";

initTheme("dark");
const ANSI = /\x1b\[[0-9;:]*m/g;

test("heredoc language comes from the redirect target, then the interpreter", () => {
	assert.equal(heredocLanguage("cd x && cat > tests/a.test.ts <<'EOF'"), "typescript");
	assert.equal(heredocLanguage("cat >> notes.md <<EOF"), "markdown");
	assert.equal(heredocLanguage("python3 - <<'EOF'"), "python");
	assert.equal(heredocLanguage("node --input-type=module <<'EOF'"), "javascript");
	assert.equal(heredocLanguage("cat <<EOF"), undefined);
});

test("commands split into shell chunks and heredoc bodies", () => {
	const cmd = "cd x && cat > a.py <<'EOF'\nprint(1)\nEOF\necho done";
	const parts = splitHeredocs(cmd).map((s) => [s.lang, s.lines]);
	assert.deepEqual(parts, [
		["bash", ["cd x && cat > a.py <<'EOF'"]],
		["python", ["print(1)"]],
		["bash", ["EOF", "echo done"]],
	]);
	// Unterminated (still streaming) heredoc: the body runs to the end.
	assert.deepEqual(splitHeredocs("python3 - <<EOF\nx = 1").map((s) => s.lang), ["bash", "python"]);
});

test("highlighted output keeps the text and adds color", () => {
	const cmd = 'grep -rn "foo" src | head -5\ncat > a.ts <<\'EOF\'\nconst x: number = 1;\nEOF';
	const lines = highlightCommand(cmd);
	assert.deepEqual(lines.map((l) => l.replace(ANSI, "")), cmd.split("\n"));
	assert.ok(lines.join("").match(ANSI)!.length > 4, "colored");
});

async function bashRow() {
	const { createToolRenderers } = await import("../extensions/tools.ts");
	const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
	const { withBuiltInRenderers } = await import(
		"../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js"
	);
	const def = withBuiltInRenderers("bash", undefined) as never as Record<string, unknown>;
	const renderers = { ...def, ...createToolRenderers("bash", def as never) };
	const ui = { requestRender() {} };
	const component = new ToolExecutionComponent("bash", "s", { command: "" }, { showImages: false, outputPad: 1 }, renderers as never, ui as never, "/tmp");
	// Expanded (ctrl+o): the rows below the call row, where a script's body is, are drawn.
	component.setExpanded(true);
	return component;
}

test("with pi's highlighter, a streamed script body is not highlighted until complete; settled calls reuse the cached text", async () => {
	const features = DREAMWALKER.features as { fastHighlight: boolean };
	features.fastHighlight = false;
	try {
		const c = await bashRow();
		c.updateArgs({ command: 'echo "hi"\necho "yo"' });
		const streaming = c.render(80).join("\n");
		c.setArgsComplete();
		const settled = c.render(80).join("\n");
		assert.notEqual(streaming, settled, "the body is highlighted once args are complete");
		assert.equal(streaming.replace(ANSI, ""), settled.replace(ANSI, ""), "same text either way");
		const first = c.render(80);
		c.invalidate();
		assert.deepEqual(c.render(80), first, "invalidate keeps identical output");
	} finally {
		features.fastHighlight = true;
	}
});

test("with the fast highlighter, streamed args are highlighted live and match the settled call", async () => {
	assert.ok(await highlighterReady);
	const c = await bashRow();
	const command = `cat > a.ts <<'EOF'\n${"const x: number = 1; // n\n".repeat(400)}EOF`;
	let streaming = "";
	for (let i = 40; i <= command.length; i += 40) {
		c.updateArgs({ command: command.slice(0, i) });
		streaming = c.render(100).join("\n");
	}
	assert.match(streaming, ANSI, "highlighted while streaming");
	c.updateArgs({ command });
	const live = c.render(100).join("\n");
	c.setArgsComplete();
	assert.equal(c.render(100).join("\n"), live, "no flash when args complete");
	const lines = highlightCommand(command, piTheme as never);
	assert.deepEqual(lines.map((l) => l.replace(ANSI, "")), command.split("\n"));
});

test("LineText wraps like pi's Text, reusing unchanged lines", async () => {
	const { LineText } = await import("../extensions/line.ts");
	const { Text } = await import("@earendil-works/pi-tui");
	assert.ok(await highlighterReady);
	const command = `cd x && cat > a.ts <<'EOF'\n${"\tconst value: number = 1; // a long comment that wraps at narrow widths\n".repeat(30)}EOF`;
	const line = new LineText();
	for (let end = 10; end <= command.length; end += 97) {
		const text = highlightCommand(command.slice(0, end), piTheme as never).join("\n");
		line.update(text);
		for (const width of [80, 31]) assert.deepEqual(line.render(width), new Text(text, 0, 0).render(width), `${end} @ ${width}`);
	}
	line.setText("\x1b[1mbold\nstill bold\x1b[22m");
	assert.deepEqual(line.render(40), new Text("\x1b[1mbold\nstill bold\x1b[22m", 0, 0).render(40), "setText wraps as one text");
	line.update("");
	assert.deepEqual(line.render(40), []);
});
