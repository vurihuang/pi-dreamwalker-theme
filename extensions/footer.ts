/**
 * One-line footer:
 *
 *   ~/repo ⎇ main · fast                          79% / 400k · 74k in · 675 out · 33% cached · $0.17
 *
 * Place (cwd, branch), session name and extension statuses on the left; context usage and spend on
 * the right. The model and the run state are in the editor's status row.
 * Session totals are recomputed only when the session leaf (every append moves it) or the model
 * changes; the per-frame path is a cache-key comparison plus string assembly.
 */
import type { ContextUsage, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DREAMWALKER } from "./config.ts";
import { formatCost, formatTokens, oneLine, shortenHome } from "./format.ts";

export type FooterEntry = { type: string; message?: unknown; usage?: unknown };

export interface FooterSource {
	sessionKey(): string;
	entries(): ReadonlyArray<FooterEntry>;
	sessionName(): string | undefined;
	/** Working directory. */
	cwd?(): string | undefined;
	/** Context window usage; read only when `sessionKey` changed. */
	context?(): ContextUsage | undefined;
}

export interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface UsageShape {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function addUsage(totals: SessionTotals, usage: UsageShape | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/** Same accounting as pi's footer: assistant and tool usage, cache warming, summaries. */
export function sumSessionUsage(entries: ReadonlyArray<FooterEntry>): SessionTotals {
	const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsage(totals, entry.usage as UsageShape);
		} else if (entry.type === "message") {
			const message = entry.message as { role?: string; usage?: UsageShape } | undefined;
			if (message?.role === "assistant" || message?.role === "toolResult") addUsage(totals, message.usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage as UsageShape);
		}
	}
	return totals;
}

/** Theme token for a context fill that needs attention; below 70% the label stays muted. */
function contextColor(percent: number | null): "warning" | "error" | "muted" {
	return percent === null ? "muted" : percent > 90 ? "error" : percent > 70 ? "warning" : "muted";
}

export class DreamFooter implements Component {
	private statsKey = "";
	private totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	private context: ContextUsage | undefined;
	/** The rendered line, reused while every input (and the theme) is unchanged. */
	private lineKey = "";
	private lineTheme: Theme | undefined;
	private line: string[] = [];
	private readonly unsubscribe: () => void;
	private readonly theme: () => Theme;
	private readonly data: ReadonlyFooterDataProvider;
	private readonly source: () => FooterSource | undefined;

	constructor(
		theme: () => Theme,
		data: ReadonlyFooterDataProvider,
		source: () => FooterSource | undefined,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.data = data;
		this.source = source;
		this.unsubscribe = data.onBranchChange(requestRender);
	}

	invalidate(): void {
		this.statsKey = "";
		this.lineKey = "";
	}

	dispose(): void {
		this.unsubscribe();
	}

	render(width: number): string[] {
		const source = this.source();
		if (!source || width <= 0) return [];
		const t = this.theme();

		const key = source.sessionKey();
		if (key !== this.statsKey) {
			this.statsKey = key;
			this.totals = sumSessionUsage(source.entries());
			this.context = source.context?.();
		}

		// Truncating an overflowing line is the expensive part (~30 µs): skip it when nothing changed.
		const name = source.sessionName();
		const cwd = source.cwd?.();
		const branch = this.data.getGitBranch();
		const statuses = this.data.getExtensionStatuses();
		let lineKey = `${width}\u0000${key}\u0000${name ?? ""}\u0000${cwd ?? ""}\u0000${branch ?? ""}`;
		for (const [id, status] of statuses) lineKey += `\u0000${id}\u0001${status}`;
		if (lineKey === this.lineKey && t === this.lineTheme) return this.line;
		this.lineKey = lineKey;
		this.lineTheme = t;
		this.line = this.build(t, width, { cwd, branch, name, statuses });
		return this.line;
	}

	private build(
		t: Theme,
		width: number,
		place: { cwd: string | undefined; branch: string | null; name: string | undefined; statuses: ReadonlyMap<string, string> },
	): string[] {
		const sep = t.fg("dim", DREAMWALKER.glyph.separator);

		// Right: context, then spend.
		const totals = this.totals;
		const right: string[] = [];
		const context = this.context;
		if (context) {
			const percent = context.percent;
			const label = percent === null ? "?" : `${Math.round(percent)}%`;
			const size = context.contextWindow ? t.fg("dim", ` / ${formatTokens(context.contextWindow)}`) : "";
			right.push(`${t.fg(contextColor(percent), label)}${size}`);
		}
		const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
		if (prompt) right.push(t.fg("dim", `${formatTokens(prompt)} in`));
		if (totals.output) right.push(t.fg("dim", `${formatTokens(totals.output)} out`));
		if (prompt && totals.cacheRead) {
			right.push(t.fg("dim", `${Math.round((totals.cacheRead / prompt) * 100)}% cached`));
		}
		if (totals.cost) right.push(t.fg("muted", formatCost(totals.cost)));
		let rightText = right.join(sep);

		// Left: place, session name, extension statuses.
		const left: string[] = [];
		if (place.cwd) {
			const path = t.fg("dim", shortenHome(place.cwd, process.env.HOME));
			left.push(place.branch ? `${path} ${t.fg("muted", `⎇ ${place.branch}`)}` : path);
		}
		if (place.name) left.push(t.fg("muted", oneLine(place.name)));
		for (const [, status] of [...place.statuses].sort(([a], [b]) => a.localeCompare(b))) {
			const text = oneLine(status);
			if (text) left.push(text);
		}
		let leftText = left.join(sep);

		const pad = 1;
		const available = width - pad * 2;
		let rightWidth = visibleWidth(rightText);
		if (rightWidth > available) {
			rightText = truncateToWidth(rightText, available, "");
			rightWidth = visibleWidth(rightText);
		}
		const leftRoom = available - rightWidth - (rightWidth ? 2 : 0);
		if (leftRoom <= 0) leftText = "";
		else if (visibleWidth(leftText) > leftRoom) leftText = truncateToWidth(leftText, leftRoom, t.fg("dim", "…"));
		const gap = Math.max(0, available - visibleWidth(leftText) - rightWidth);
		return [`${" ".repeat(pad)}${leftText}${" ".repeat(gap)}${rightText}${" ".repeat(pad)}`];
	}
}
