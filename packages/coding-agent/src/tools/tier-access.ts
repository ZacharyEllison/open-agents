import type { AgentTool, ModelTier } from "@open-agents/agent";

/** Tools that only the worker tier may invoke (interface must delegate via `task`). */
export const WORKER_ONLY_TIERS: ModelTier[] = ["worker"];

/** Tools available to interface and worker tiers (not the compactor). */
export const INTERFACE_AND_WORKER_TIERS: ModelTier[] = ["interface", "worker"];

/** True when the tool is restricted to worker tier only (interface calls are auto-delegated). */
export function isWorkerOnlyTool(tool: AgentTool): boolean {
	const allowed = tool.allowedTiers;
	if (!allowed || allowed.length === 0) return false;
	return allowed.includes("worker") && !allowed.includes("interface");
}
