/**
 * Spinner shared by the group card's "running" icon. Same 80ms cadence pi's own running tools use;
 * the ticker only re-invalidates groups that still have a pending child.
 */
export const TOOL_TICK_MS = 80;

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function toolLoadingIcon(now = Date.now()): string {
	return BRAILLE[Math.floor(now / TOOL_TICK_MS) % BRAILLE.length]!;
}
