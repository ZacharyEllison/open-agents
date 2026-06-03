import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@open-agents/agent";
import { fixupToolArgs } from "@open-agents/agent/tool-call-fixup";
import * as z from "zod/v4";

function tool(name: string, parameters: AgentTool["parameters"]): AgentTool {
	return {
		name,
		label: name,
		description: "",
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("fixupToolArgs", () => {
	it("defaults missing find paths to cwd", () => {
		const findTool = tool(
			"find",
			z
				.object({
					paths: z.array(z.string()).min(1),
				})
				.strict(),
		);
		const { args, corrections } = fixupToolArgs(findTool, {});
		expect(args.paths).toEqual(["."]);
		expect(corrections.some(c => c.includes("paths"))).toBe(true);
	});

	it("wraps a string find paths value in an array", () => {
		const findTool = tool(
			"find",
			z
				.object({
					paths: z.array(z.string()).min(1),
				})
				.strict(),
		);
		const { args, corrections } = fixupToolArgs(findTool, { paths: "src/**/*.ts" });
		expect(args.paths).toEqual(["src/**/*.ts"]);
		expect(corrections.some(c => c.includes("wrapped"))).toBe(true);
	});

	it("defaults missing search paths to cwd", () => {
		const searchTool = tool(
			"search",
			z
				.object({
					pattern: z.string(),
					paths: z.union([z.string(), z.array(z.string()).min(1)]),
				})
				.strict(),
		);
		const { args } = fixupToolArgs(searchTool, { pattern: "foo" });
		expect(args.paths).toEqual(["."]);
	});

	it("takes the first element when read path is an array", () => {
		const readTool = tool(
			"read",
			z
				.object({
					path: z.string(),
				})
				.strict(),
		);
		const { args, corrections } = fixupToolArgs(readTool, { path: ["a.ts", "b.ts"] });
		expect(args.path).toBe("a.ts");
		expect(corrections.some(c => c.includes("first element"))).toBe(true);
	});

	it("joins bash command arrays with &&", () => {
		const bashTool = tool(
			"bash",
			z
				.object({
					command: z.string(),
				})
				.strict(),
		);
		const { args, corrections } = fixupToolArgs(bashTool, { command: ["echo hi", "echo bye"] });
		expect(args.command).toBe("echo hi && echo bye");
		expect(corrections.some(c => c.includes("joined"))).toBe(true);
	});

	it("coerces numeric strings for number fields", () => {
		const t = tool(
			"sleep",
			z.object({
				timeout: z.number(),
			}),
		);
		const { args } = fixupToolArgs(t, { timeout: "30" });
		expect(args.timeout).toBe(30);
	});

	it("coerces booleans to strings when the schema expects string", () => {
		const t = tool(
			"label",
			z.object({
				name: z.string(),
			}),
		);
		const { args } = fixupToolArgs(t, { name: true });
		expect(args.name).toBe("true");
	});

	it("leaves well-formed calls unchanged", () => {
		const findTool = tool(
			"find",
			z
				.object({
					paths: z.array(z.string()).min(1),
				})
				.strict(),
		);
		const input = { paths: ["src"] };
		const { args, corrections } = fixupToolArgs(findTool, input);
		expect(args).toEqual(input);
		expect(corrections).toEqual([]);
	});

	it("does not default optional array fields that were omitted", () => {
		const t = tool(
			"tags",
			z.object({
				label: z.string(),
				tags: z.array(z.string()).optional(),
			}),
		);
		const { args, corrections } = fixupToolArgs(t, { label: "x" });
		expect(args.tags).toBeUndefined();
		expect(corrections).toEqual([]);
	});
});
