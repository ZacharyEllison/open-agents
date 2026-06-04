import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@open-agents/agent";
import * as z from "zod/v4";
import {
	INTERFACE_AND_WORKER_TIERS,
	INTERFACE_MARKDOWN_TIERS,
	isMarkdownPath,
	isWorkerOnlyTool,
	validateInterfaceTierFileAccess,
	WORKER_ONLY_TIERS,
} from "../../src/tools/tier-access";

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

describe("isMarkdownPath", () => {
	it("accepts .md files", () => {
		expect(isMarkdownPath("docs/plan.md")).toBe(true);
	});

	it("accepts .mdx files", () => {
		expect(isMarkdownPath("components/README.mdx")).toBe(true);
	});

	it("accepts .markdown files", () => {
		expect(isMarkdownPath("notes.markdown")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isMarkdownPath("FILE.MD")).toBe(true);
		expect(isMarkdownPath("doc.Mdx")).toBe(true);
	});

	it("rejects non-markdown files", () => {
		expect(isMarkdownPath("src/index.ts")).toBe(false);
		expect(isMarkdownPath("style.css")).toBe(false);
		expect(isMarkdownPath("data.json")).toBe(false);
		expect(isMarkdownPath("readme.md.bak")).toBe(false);
	});
});

describe("validateInterfaceTierFileAccess", () => {
	it("allows markdown at interface tier (depth 0)", () => {
		expect(validateInterfaceTierFileAccess("plan.md", 0)).toBeNull();
		expect(validateInterfaceTierFileAccess("docs/notes.mdx", 0)).toBeNull();
	});

	it("blocks non-markdown at interface tier (depth 0)", () => {
		const result = validateInterfaceTierFileAccess("src/index.ts", 0);
		expect(result).toBeString();
		expect(result).toContain(".md");
		expect(result).toContain("task");
	});

	it("allows any file at worker tier (depth > 0)", () => {
		expect(validateInterfaceTierFileAccess("src/index.ts", 1)).toBeNull();
		expect(validateInterfaceTierFileAccess("main.py", 2)).toBeNull();
	});
});

describe("INTERFACE_MARKDOWN_TIERS", () => {
	it("includes both interface and worker", () => {
		expect(INTERFACE_MARKDOWN_TIERS).toContain("interface");
		expect(INTERFACE_MARKDOWN_TIERS).toContain("worker");
	});
});
