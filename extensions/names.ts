/**
 * One-line label for a tool inside the collapsed group card: `read extensions/index.ts`.
 * Derives the short summary of a call (path, pattern, first line of a command), plus a humanized tool name.
 */
import { oneLine } from "./format.ts";

export function humanizeToolLabel(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

const SUMMARY_KEYS = ["path", "file_path", "command", "pattern", "query", "url", "name", "code"] as const;

/**
 * `toolName summary` for the group child row. Multi-word commands keep only the head so a bash
 * heredoc / node script collapses to `bash nodejs <<'EOF'` rather than flooding the row.
 */
export function toolCallSummary(toolName: string, args: unknown): string {
	const label = toolName;
	if (!args || typeof args !== "object") return label;
	const record = args as Record<string, unknown>;
	const name = toolName.toLowerCase();
	if ((name === "grep" || name === "find") && typeof record.pattern === "string" && record.pattern) {
		const pattern = oneLine(record.pattern);
		const where = typeof record.path === "string" && record.path ? ` in ${oneLine(record.path)}` : "";
		return `${label} ${JSON.stringify(pattern.length > 60 ? `${pattern.slice(0, 59)}…` : pattern)}${where}`;
	}
	for (const key of SUMMARY_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			const text = key === "command" || key === "code" ? headOf(value) : oneLine(value);
			return text ? `${label} ${text}` : label;
		}
	}
	try {
		const json = JSON.stringify(args);
		return json && json !== "{}" ? `${label} ${oneLine(json)}` : label;
	} catch {
		return label;
	}
}

/** First meaningful line of a command, so a multi-line script shows only its head. */
function headOf(command: string): string {
	const line = oneLine(command.split("\n").find((l) => l.trim()) ?? command);
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
