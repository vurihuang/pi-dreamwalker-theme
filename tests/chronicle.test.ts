import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantLike, Chronicle, type EntryLike, isFinalResponse, type UserLike } from "../extensions/chronicle.ts";
import { formatCost, formatDuration, formatShortDuration, formatTokens, shortenHome } from "../extensions/format.ts";

const usage = (input: number, output: number, cacheRead = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	cost: { total: (input + output) / 1_000_000 },
});

const user = (text: string, timestamp: number): UserLike => ({ role: "user", content: text, timestamp });
const toolStep = (timestamp: number): AssistantLike => ({
	role: "assistant",
	content: [{ type: "toolCall" }],
	timestamp,
	durationMs: 1000,
	stopReason: "toolUse",
	usage: usage(1000, 100, 500),
});
const final = (timestamp: number): AssistantLike => ({
	role: "assistant",
	content: [{ type: "text" }],
	timestamp,
	durationMs: 2000,
	stopReason: "stop",
	usage: usage(2000, 200, 1500),
});
const entry = (message: UserLike | AssistantLike): EntryLike => ({ type: "message", message });

test("final response: stop/length without tool calls", () => {
	assert.equal(isFinalResponse(final(1)), true);
	assert.equal(isFinalResponse(toolStep(1)), false);
	assert.equal(isFinalResponse({ ...final(1), stopReason: "error" }), false);
	assert.equal(isFinalResponse({ ...final(1), stopReason: "aborted" }), false);
});

test("reindex: run stats from the branch", () => {
	const c = new Chronicle();
	c.reindex([
		entry(user("hi", 1_000)),
		entry(toolStep(2_000)),
		entry(toolStep(4_000)),
		entry(final(6_000)),
		{ type: "label" },
		entry(user("again", 10_000)),
		entry(final(11_000)),
	]);

	const stats = c.runStats(final(6_000));
	assert.ok(stats);
	assert.equal(stats.responses, 3);
	assert.equal(stats.wallMs, 6_000 + 2_000 - 1_000);
	assert.equal(stats.generationMs, 4_000);
	assert.equal(stats.promptTokens, 1500 + 1500 + 3500);
	assert.equal(stats.output, 400);
	assert.equal(stats.cacheRead, 2500);
	assert.equal(c.runStats(toolStep(2_000)), undefined);
	assert.equal(c.runStats(final(11_000))?.responses, 1);
});

test("live run: events before render give the stats without the session", () => {
	const c = new Chronicle();
	c.reindex([]);
	c.onAgentStart(900);
	c.onUserMessage(user("do it", 1_000));

	const step = toolStep(2_000);
	c.onAssistantStart(step);
	c.onAssistantEnd(step);

	const answer = final(4_000);
	c.onAssistantStart(answer);
	c.onAssistantEnd(answer);
	c.onAgentEnd();

	const stats = c.runStats(answer);
	assert.ok(stats);
	assert.equal(stats.responses, 2);
	assert.equal(stats.wallMs, 4_000 + 2_000 - 1_000);
	assert.equal(stats.output, 300);
});

test("a run without a user message (custom trigger) is still counted", () => {
	const c = new Chronicle();
	c.reindex([entry(user("a", 1)), entry(final(2))]);
	c.onAgentStart(10);
	const answer = final(11);
	c.onAssistantStart(answer);
	c.onAssistantEnd(answer);
	assert.equal(c.runStats(answer)?.responses, 1);
});

test("reindex keeps a run that is open at the end of the branch", () => {
	const c = new Chronicle();
	c.reindex([entry(user("go", 1_000)), entry(toolStep(2_000))]);
	const answer = final(5_000);
	c.onAssistantStart(answer);
	c.onAssistantEnd(answer);
	assert.equal(c.runStats(answer)?.responses, 2);
	assert.equal(c.runStats(answer)?.wallMs, 6_000);
});

test("formatters", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(24_600), "25k");
	assert.equal(formatTokens(2_400), "2.4k");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.0123), "$0.012");
	assert.equal(formatCost(0.07), "$0.070");
	assert.equal(formatCost(0.17), "$0.17");
	assert.equal(formatDuration(450), "0.5s");
	assert.equal(formatDuration(5_200), "5s");
	assert.equal(formatDuration(135_000), "2m 15s");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatShortDuration(1_234), "1.2s");
	assert.equal(formatShortDuration(42_000), "42s");
	assert.equal(shortenHome("/Users/v/x", "/Users/v"), "~/x");
	assert.equal(shortenHome("/Users/v", "/Users/v"), "~");
	assert.equal(shortenHome("/Users/vv", "/Users/v"), "/Users/vv");
});
