/** Pure formatters. No theme, no TUI: everything here is unit-tested. */

export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0";
	if (usd < 0.1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Tool timings are short: keep tenths below 10s (`0.1s`, `1.2s`). */
export function formatShortDuration(ms: number): string {
	if (Number.isFinite(ms) && ms >= 0 && ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	return formatDuration(ms);
}

/**
 * Live run timer: `4.1s`, `12.3s`, `1m05s`, `59m59s`, `1h02m`. Fixed width within each range, so
 * the border shifts only when a range changes (10s, 1m, 10m, 1h), never every tick.
 */
export function formatRunTimer(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Coarse elapsed time for the status chip: `26s`, `1m05s`, `1h02m` (changes once a second at most). */
export function formatElapsed(seconds: number): string {
	const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `~/x/y` when inside home. */
export function shortenHome(path: string, home: string | undefined): string {
	if (!home || home === "/") return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** One-line, control-character-free text for status and labels. */
export function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}
