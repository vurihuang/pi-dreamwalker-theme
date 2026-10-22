/**
 * What a run cost.
 *
 * A "run" is everything the assistant does between one user message and the assistant's final
 * answer (a message without tool calls). The chronicle answers one question for the renderers:
 * what did the run that this final message closes cost (`runStats`).
 *
 * History is indexed once per session/tree change from the branch (O(n)). Live runs are fed by
 * extension events, which pi delivers before the UI renders and before the session persists the
 * message, so lookups never need to rescan the session while streaming.
 */

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total: number };
}

export interface AssistantLike {
	role: "assistant";
	content: ReadonlyArray<{ type: string }>;
	timestamp: number;
	durationMs?: number;
	stopReason?: string;
	usage?: UsageLike;
}

export interface UserLike {
	role: "user";
	content: string | ReadonlyArray<{ type: string; text?: string }>;
	timestamp: number;
}

export interface EntryLike {
	type: string;
	message?: { role: string; timestamp?: number };
}

export interface RunStats {
	/** Wall clock from run start to the end of the final response. */
	wallMs: number;
	/** Sum of model generation time over the run's responses. */
	generationMs: number;
	cost: number;
	/** Prompt tokens: input + cache read + cache write, summed over the run's responses. */
	promptTokens: number;
	output: number;
	cacheRead: number;
	responses: number;
}

export function isFinalResponse(message: AssistantLike): boolean {
	if (message.stopReason !== "stop" && message.stopReason !== "length") return false;
	return !message.content.some((part) => part.type === "toolCall");
}

class RunAccumulator {
	readonly counted = new Set<number>();
	generationMs = 0;
	cost = 0;
	promptTokens = 0;
	output = 0;
	cacheRead = 0;

	readonly startedAt: number | undefined;

	constructor(startedAt: number | undefined) {
		this.startedAt = startedAt;
	}

	add(message: AssistantLike): void {
		if (this.counted.has(message.timestamp)) return;
		this.counted.add(message.timestamp);
		const usage = message.usage;
		this.generationMs += message.durationMs ?? 0;
		if (!usage) return;
		this.cost += usage.cost?.total ?? 0;
		this.promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
		this.output += usage.output;
		this.cacheRead += usage.cacheRead;
	}

	close(final: AssistantLike): RunStats {
		this.add(final);
		const end = final.timestamp + (final.durationMs ?? 0);
		const start = this.startedAt ?? final.timestamp;
		return {
			wallMs: Math.max(0, end - start),
			generationMs: this.generationMs,
			cost: this.cost,
			promptTokens: this.promptTokens,
			output: this.output,
			cacheRead: this.cacheRead,
			responses: this.counted.size,
		};
	}
}

export class Chronicle {
	private readonly stats = new Map<number, RunStats>();
	private live: RunAccumulator | undefined;

	/** Re-index from the active branch. Call on session start, tree navigation and compaction. */
	reindex(entries: readonly EntryLike[]): void {
		this.stats.clear();
		this.live = undefined;

		let run: RunAccumulator | undefined;
		for (const entry of entries) {
			const message = entry.message;
			if (entry.type !== "message" || !message) continue;
			if (message.role === "user") {
				run = new RunAccumulator((message as unknown as UserLike).timestamp);
			} else if (message.role === "assistant") {
				const assistant = message as unknown as AssistantLike;
				run ??= new RunAccumulator(assistant.timestamp);
				if (isFinalResponse(assistant)) {
					this.stats.set(assistant.timestamp, run.close(assistant));
					run = undefined;
				} else {
					run.add(assistant);
				}
			}
		}
		// A branch can end inside a run (resumed mid-run, tree navigation while tools were pending).
		this.live = run;
	}

	// ── live events ────────────────────────────────────────────────────────────

	onAgentStart(now: number): void {
		if (!this.live) this.live = new RunAccumulator(now);
	}

	onUserMessage(message: UserLike): void {
		this.live = new RunAccumulator(message.timestamp);
	}

	onAssistantStart(message: AssistantLike): void {
		this.live ??= new RunAccumulator(message.timestamp);
	}

	onAssistantEnd(message: AssistantLike): void {
		const run = (this.live ??= new RunAccumulator(message.timestamp));
		if (isFinalResponse(message)) {
			this.stats.set(message.timestamp, run.close(message));
			this.live = undefined;
		} else {
			run.add(message);
		}
	}

	onAgentEnd(): void {
		this.live = undefined;
	}

	// ── lookups ────────────────────────────────────────────────────────────────

	runStats(message: AssistantLike): RunStats | undefined {
		return this.stats.get(message.timestamp);
	}
}
