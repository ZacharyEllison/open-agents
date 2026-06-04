import type { AgentTool, ModelTier } from "@open-agents/agent";

/** Tools that only the worker tier may invoke (interface must delegate via `task`). */
export const WORKER_ONLY_TIERS: ModelTier[] = ["worker"];

/** Tools available to interface and worker tiers (not the compactor). */
export const INTERFACE_AND_WORKER_TIERS: ModelTier[] = ["interface", "worker"];

/** Tools that allow interface-tier access but only for markdown files. */
export const INTERFACE_MARKDOWN_TIERS: ModelTier[] = ["interface", "worker"];

/** True when the tool is restricted to worker tier only (interface calls are auto-delegated). */
export function isWorkerOnlyTool(tool: AgentTool): boolean {
	const allowed = tool.allowedTiers;
	if (!allowed || allowed.length === 0) return false;
	return allowed.includes("worker") && !allowed.includes("interface");
}

/** Returns true if the file path has a markdown extension. */
export function isMarkdownPath(filePath: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(filePath);
}

/**
 * Validates file access for interface-tier tools that are restricted to markdown.
 * Returns an error message if access should be denied, or null if allowed.
 */
export function validateInterfaceTierFileAccess(filePath: string, taskDepth: number): string | null {
	if (taskDepth !== 0) return null;
	if (isMarkdownPath(filePath)) return null;
	return "Interface tier: file editing restricted to .md files. Delegate code edits via the 'task' tool.";
}
