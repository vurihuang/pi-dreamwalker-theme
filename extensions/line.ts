import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";

/** A hairline across the chat's margins: one space either side. */
export function rowRule(t: Theme, width: number): string {
	return ` ${t.fg("mdHr", DREAMWALKER.frame.rule.repeat(Math.max(0, width - 2)))}`;
}

/**
 * A single themed line built on demand and cached per width.
 * `invalidate()` (theme change) drops the cache, so colors are never baked into state.
 */
export class ChromeLine implements Component {
	private cachedWidth = -1;
	private cached: string[] = [];

	private readonly build: (width: number) => string;

	constructor(build: (width: number) => string) {
		this.build = build;
	}

	render(width: number): string[] {
		if (width !== this.cachedWidth) {
			const line = width > 0 ? truncateToWidth(this.build(width), width, "") : "";
			this.cached = [line];
			this.cachedWidth = width;
		}
		return this.cached;
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}
}

/**
 * A `Text(text, 0, 0)` for multi-line text whose lines each close their own styles (highlighted
 * code). pi's Text re-wraps the whole string on every change; this wraps line by line and reuses the
 * rows of lines that did not change, so a growing text costs O(changed lines) per update.
 *
 * `update()` takes such text. `setText()` (pi's renderers reusing the component) may carry styles
 * across lines, so it wraps the whole string, exactly as Text does.
 */
export class LineText implements Component {
	private text = "";
	private perLine = true;
	private width = -1;
	private out: string[] = [];
	private rows = new Map<string, string[]>();
	private rowsWidth = -1;

	update(text: string): void {
		if (text === this.text && this.perLine) return;
		this.text = text;
		this.perLine = true;
		this.width = -1;
	}

	setText(text: string): void {
		this.text = text;
		this.perLine = false;
		this.width = -1;
		this.rows.clear();
	}

	render(width: number): string[] {
		if (width === this.width) return this.out;
		this.width = width;
		if (!this.text || this.text.trim() === "") return (this.out = []);
		const pad = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const text = this.text.replace(/\t/g, "   ");
		if (!this.perLine) return (this.out = wrapTextWithAnsi(text, Math.max(1, width)).map(pad));
		const previous = this.rowsWidth === width ? this.rows : new Map<string, string[]>();
		const next = new Map<string, string[]>();
		const out: string[] = [];
		for (const line of text.split(/\r\n|\r|\n/)) {
			let rows = previous.get(line) ?? next.get(line);
			if (!rows) rows = wrapTextWithAnsi(line, Math.max(1, width)).map(pad);
			next.set(line, rows);
			for (const row of rows) out.push(row);
		}
		this.rows = next;
		this.rowsWidth = width;
		return (this.out = out);
	}

	/** Rows are keyed by their styled text, so a theme change arrives as new text through update(). */
	invalidate(): void {}
}
