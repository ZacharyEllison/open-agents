import { describe, expect, it } from "bun:test";
import type { AgentTool, ModelTier } from "@open-agents/agent";
import { buildSystemPrompt, buildSystemPromptToolMetadata } from "@open-agents/coding-agent/system-prompt";
import * as z from "zod/v4";
import {
	INTERFACE_AND_WORKER_TIERS,
	INTERFACE_MARKDOWN_TIERS,
	isWorkerOnlyTool,
	WORKER_ONLY_TIERS,
} from "../src/tools/tier-access";

const schema = z.object({ path: z.string() });

function stubTool(name: string, tiers?: ModelTier[]): AgentTool<typeof schema> {
	return {
		name,
		label: name,
		description: `${name} tool description`,
		parameters: schema,
		allowedTiers: tiers,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("interface tier prompt filtering", () => {
	const workerTools = [
		stubTool("eval", WORKER_ONLY_TIERS),
		stubTool("browser", WORKER_ONLY_TIERS),
		stubTool("lsp", WORKER_ONLY_TIERS),
		stubTool("ast_edit", WORKER_ONLY_TIERS),
	];
	const interfaceTools = [
		stubTool("read"),
		stubTool("search"),
		stubTool("task"),
		stubTool("edit", INTERFACE_MARKDOWN_TIERS),
		stubTool("bash", INTERFACE_AND_WORKER_TIERS),
		stubTool("ast_grep"),
	];
	const allTools = [...interfaceTools, ...workerTools];
	const allToolNames = allTools.map(t => t.name);

	it("isWorkerOnlyTool identifies worker-only tools", () => {
		for (const t of workerTools) {
			expect(isWorkerOnlyTool(t)).toBe(true);
		}
		for (const t of interfaceTools) {
			expect(isWorkerOnlyTool(t)).toBe(false);
		}
	});

	it("interface prompt excludes worker-only tools from toolNames and toolInfo", async () => {
		const toolsMap = new Map(allTools.map(t => [t.name, t]));
		const filteredToolNames = allToolNames.filter(name => {
			const tool = toolsMap.get(name);
			return !tool || !isWorkerOnlyTool(tool);
		});
		const filteredTools = new Map(Array.from(toolsMap.entries()).filter(([, tool]) => !isWorkerOnlyTool(tool)));

		const result = await buildSystemPrompt({
			toolNames: filteredToolNames,
			tools: buildSystemPromptToolMetadata(filteredTools),
			isInterfaceTier: true,
		});

		const prompt = result.systemPrompt.join("\n");
		const inventoryMatch = prompt.match(/## Inventory\n([\s\S]*?)(?=\n## |\n# |$)/);
		expect(inventoryMatch).not.toBeNull();
		const inventory = inventoryMatch![1];
		for (const t of interfaceTools) {
			expect(inventory).toContain(t.name);
		}
		for (const t of workerTools) {
			expect(inventory).not.toContain(t.name);
		}
	});

	it("worker prompt includes all tools in inventory", async () => {
		const toolsMap = new Map(allTools.map(t => [t.name, t]));

		const result = await buildSystemPrompt({
			toolNames: allToolNames,
			tools: buildSystemPromptToolMetadata(toolsMap),
			isInterfaceTier: false,
		});

		const prompt = result.systemPrompt.join("\n");
		const inventoryMatch = prompt.match(/## Inventory\n([\s\S]*?)(?=\n## |\n# |$)/);
		expect(inventoryMatch).not.toBeNull();
		const inventory = inventoryMatch![1];
		for (const t of allTools) {
			expect(inventory).toContain(t.name);
		}
	});

	it("interface prompt renders the tier-interface block", async () => {
		const result = await buildSystemPrompt({
			toolNames: ["read", "task"],
			tools: buildSystemPromptToolMetadata(
				new Map(
					[
						["read", stubTool("read")],
						["task", stubTool("task")],
					].map(([n, t]) => [n as string, t as AgentTool]),
				),
			),
			isInterfaceTier: true,
		});

		const prompt = result.systemPrompt.join("\n");
		expect(prompt).toContain("tier-interface");
		expect(prompt).toContain("delegate");
	});
});

describe("interface.contextFileMaxChars trimming", () => {
	const longContent = "A".repeat(10_000);
	const shortContent = "Short content";
	const contextFiles = [
		{ path: "AGENTS.md", content: longContent },
		{ path: "small.md", content: shortContent },
	];

	it("passes full context files when maxChars is -1 (default)", () => {
		const maxChars = -1;
		const result =
			maxChars >= 0
				? maxChars === 0
					? []
					: contextFiles.map(f =>
							f.content.length > maxChars
								? { ...f, content: `${f.content.slice(0, maxChars)}\n[truncated]` }
								: f,
						)
				: contextFiles;

		expect(result).toHaveLength(2);
		expect(result[0].content).toBe(longContent);
		expect(result[1].content).toBe(shortContent);
	});

	it("skips context files when maxChars is 0", () => {
		const maxChars = 0;
		const result =
			maxChars >= 0
				? maxChars === 0
					? []
					: contextFiles.map(f =>
							f.content.length > maxChars
								? { ...f, content: `${f.content.slice(0, maxChars)}\n[truncated]` }
								: f,
						)
				: contextFiles;

		expect(result).toHaveLength(0);
	});

	it("truncates large files and preserves small ones", () => {
		const maxChars = 2000;
		const result =
			maxChars >= 0
				? maxChars === 0
					? []
					: contextFiles.map(f =>
							f.content.length > maxChars
								? { ...f, content: `${f.content.slice(0, maxChars)}\n[truncated]` }
								: f,
						)
				: contextFiles;

		expect(result).toHaveLength(2);
		expect(result[0].content).toHaveLength(2000 + "\n[truncated]".length);
		expect(result[0].content).toEndWith("[truncated]");
		expect(result[0].path).toBe("AGENTS.md");
		expect(result[1].content).toBe(shortContent);
	});
});
