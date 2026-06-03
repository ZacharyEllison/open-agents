import type { AgentLoopConfig, AgentToolResult, AgentToolUpdateCallback } from "@open-agents/agent";
import { logger } from "@open-agents/utils";
import { isWorkerOnlyTool } from "./tier-access";

export interface TierAutoDelegateOptions {
	/** Session task depth; only depth 0 (interface) auto-delegates. */
	taskDepth: number;
}

/**
 * When the interface tier calls a worker-only tool, execute it directly instead
 * of returning a tier-denied error. The interface model keeps seeing worker
 * tools in its schema; the harness runs them on its behalf (same as delegating
 * through `task` without an extra LLM hop when args are already complete).
 */
export function createTierAutoDelegateHandler(
	options: TierAutoDelegateOptions,
): NonNullable<AgentLoopConfig["onDisallowedTierTool"]> {
	return async (context, signal, onUpdate): Promise<AgentToolResult | undefined> => {
		if (options.taskDepth !== 0) return undefined;
		if (context.activeTier !== "interface") return undefined;
		if (!isWorkerOnlyTool(context.tool)) return undefined;

		logger.debug("Auto-delegating worker-tier tool for interface session", {
			tool: context.tool.name,
			toolCallId: context.toolCall.id,
		});

		const rawResult = await context.tool.execute(
			context.toolCall.id,
			context.args,
			context.tool.nonAbortable ? undefined : signal,
			onUpdate as AgentToolUpdateCallback | undefined,
			context.toolContext,
		);
		return rawResult;
	};
}
