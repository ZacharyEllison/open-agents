import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@open-agents/agent";
import * as z from "zod/v4";
import { INTERFACE_AND_WORKER_TIERS, isWorkerOnlyTool, WORKER_ONLY_TIERS } from "../../src/tools/tier-access";
import { createTierAutoDelegateHandler } from "../../src/tools/tier-auto-delegate";

const schema = z.object({ path: z.string() });

function stubTool(
	allowedTiers: typeof WORKER_ONLY_TIERS | typeof INTERFACE_AND_WORKER_TIERS,
): AgentTool<typeof schema> {
	return {
		name: "edit",
		label: "Edit",
		description: "Edit",
		parameters: schema,
		allowedTiers,
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: `ok:${params.path}` }],
				details: {},
			};
		},
	};
}

describe("isWorkerOnlyTool", () => {
	it("returns true for worker-only allowedTiers", () => {
		expect(isWorkerOnlyTool(stubTool(WORKER_ONLY_TIERS))).toBe(true);
	});

	it("returns false when interface is allowed", () => {
		expect(isWorkerOnlyTool(stubTool(INTERFACE_AND_WORKER_TIERS))).toBe(false);
	});
});

describe("createTierAutoDelegateHandler", () => {
	it("executes worker-only tools at interface depth 0", async () => {
		const tool = stubTool(WORKER_ONLY_TIERS);
		const handler = createTierAutoDelegateHandler({ taskDepth: 0 });
		const result = await handler(
			{
				assistantMessage: {
					role: "assistant",
					content: [],
					api: "openai",
					provider: "mock",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				toolCall: { type: "toolCall", id: "c1", name: "edit", arguments: { path: "x.ts" } },
				args: { path: "x.ts" },
				context: { systemPrompt: [""], messages: [], tools: [tool] },
				tool,
				activeTier: "interface",
			},
			undefined,
			undefined,
		);

		expect(result?.content).toEqual([{ type: "text", text: "ok:x.ts" }]);
	});

	it("returns undefined for subagent depth", async () => {
		const tool = stubTool(WORKER_ONLY_TIERS);
		const handler = createTierAutoDelegateHandler({ taskDepth: 1 });
		const result = await handler({
			assistantMessage: {
				role: "assistant",
				content: [],
				api: "openai",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			toolCall: { type: "toolCall", id: "c1", name: "edit", arguments: { path: "x.ts" } },
			args: { path: "x.ts" },
			context: { systemPrompt: [""], messages: [], tools: [tool] },
			tool,
			activeTier: "interface",
		});
		expect(result).toBeUndefined();
	});
});
