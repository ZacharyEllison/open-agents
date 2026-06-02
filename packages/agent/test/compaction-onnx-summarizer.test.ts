import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@open-agents/agent";
import { generateSummary } from "@open-agents/agent/compaction";
import type { AssistantMessage, Model } from "@open-agents/ai";
import * as ai from "@open-agents/ai";
import { getBundledModel } from "@open-agents/ai/models";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "discuss compaction", timestamp: 1 },
	createAssistantMessage([{ type: "text", text: "ok" }]),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction ONNX summarizer routing", () => {
	test("uses onnxSummarizer when it returns text and skips completeSimple", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		const summarize = vi.fn(async () => "local onnx summary");

		const summary = await generateSummary(
			messages,
			getAnthropicModel(),
			16_384,
			"unused-key",
			undefined,
			undefined,
			undefined,
			{ onnxSummarizer: { summarize } },
		);

		expect(summary).toBe("local onnx summary");
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(spy).not.toHaveBeenCalled();
	});

	test("falls back to completeSimple when onnxSummarizer returns null", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "server summary" }]));

		const summary = await generateSummary(
			messages,
			getAnthropicModel(),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			{ onnxSummarizer: { summarize: async () => null } },
		);

		expect(summary).toBe("server summary");
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
