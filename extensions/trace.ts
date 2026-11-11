/**
 * Debug trace of the streaming reveal. `DREAMWALKER_TRACE=/tmp/dw.log pi` appends one line per event
 * (`ms-since-start kind key=value ...`): `commit` (a paint of newly revealed text), `births` (chars
 * given a fade start), `frame` (a render requested), `palette` (what the fade rises from). Lines
 * line up with a screen recording by wall-clock time. Off (a no-op) unless the variable is set.
 */
import { appendFileSync } from "node:fs";

const file = process.env.DREAMWALKER_TRACE;
const start = Date.now();

export const tracing = !!file;

export function trace(kind: string, data: Record<string, string | number | boolean | undefined> = {}): void {
	if (!file) return;
	const fields = Object.entries(data)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	try {
		appendFileSync(file, `${Date.now() - start} ${kind} ${fields}\n`);
	} catch {
		// A trace must never break the UI.
	}
}
