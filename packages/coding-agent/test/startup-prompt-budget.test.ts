import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@open-agents/agent";
import {
	estimateToolDescriptionTokens,
	estimateToolSchemaOnlyTokens,
	estimateToolSchemaTokens,
} from "@open-agents/coding-agent/modes/utils/context-usage";
import { buildSystemPrompt, buildSystemPromptToolMetadata } from "@open-agents/coding-agent/system-prompt";
import { countTokens } from "@open-agents/natives";
import * as z from "zod/v4";

const schema = z.object({ path: z.string(), offset: z.number().optional() });

function stub(name: string): AgentTool<typeof schema> {
	return {
		name,
		label: name,
		description: `${name} tool: does the ${name} thing for the agent`,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

const emptyContext = {
	contextFiles: [],
	skills: [],
	workspaceTree: {
		rootPath: "/tmp/budget",
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	},
};

const INTERFACE_TOOLS = ["read", "search", "find", "task", "todo_write", "ask", "bash", "ast_grep"];
const WORKER_TOOLS = [...INTERFACE_TOOLS, "eval", "edit", "write", "lsp", "ast_edit", "browser", "inspect_image"];

async function buildHarness(toolNames: string[], isInterfaceTier: boolean) {
	const tools = new Map(toolNames.map(n => [n, stub(n)]));
	return buildSystemPrompt({
		toolNames,
		tools: buildSystemPromptToolMetadata(tools),
		isInterfaceTier,
		...emptyContext,
	});
}

describe("startup prompt budget", () => {
	// Guards against persona / staff-engineer prose creeping back into the
	// frozen harness prefix. These ceilings sit comfortably above the current
	// rendered harness (~2.8k interface / ~1.5k worker) but well under the
	// pre-split size, so re-adding the persona block trips the test.
	it("interface harness prefix stays lean", async () => {
		const result = await buildHarness(INTERFACE_TOOLS, true);
		const harnessTokens = countTokens(result.systemPrompt[0] ?? "");
		expect(harnessTokens).toBeLessThan(3200);
	});

	it("worker harness prefix stays lean", async () => {
		const result = await buildHarness(WORKER_TOOLS, false);
		const harnessTokens = countTokens(result.systemPrompt[0] ?? "");
		expect(harnessTokens).toBeLessThan(1800);
	});

	it("startup non-message prefix fits the per-tier budget with empty context", async () => {
		const iface = await buildHarness(INTERFACE_TOOLS, true);
		const worker = await buildHarness(WORKER_TOOLS, false);
		expect(countTokens(iface.systemPrompt)).toBeLessThan(8_000);
		expect(countTokens(worker.systemPrompt)).toBeLessThan(18_000);
	});

	it("drops the staff-engineer persona, stakes, completeness, and yielding blocks", async () => {
		const iface = (await buildHarness(INTERFACE_TOOLS, true)).systemPrompt.join("\n");
		const worker = (await buildHarness(WORKER_TOOLS, false)).systemPrompt.join("\n");
		for (const text of [iface, worker]) {
			expect(text).not.toContain("staff engineer");
			expect(text).not.toContain("<stakes>");
			expect(text).not.toContain("<completeness>");
			expect(text).not.toContain("<yielding>");
		}
	});
});

describe("tool token breakdown split", () => {
	it("description + schema components sum to the combined tool token total", () => {
		const tools = WORKER_TOOLS.map(stub);
		const descriptions = estimateToolDescriptionTokens(tools);
		const schemas = estimateToolSchemaOnlyTokens(tools);
		const combined = estimateToolSchemaTokens(tools);
		expect(descriptions).toBeGreaterThan(0);
		expect(schemas).toBeGreaterThan(0);
		expect(descriptions + schemas).toBe(combined);
	});
});
