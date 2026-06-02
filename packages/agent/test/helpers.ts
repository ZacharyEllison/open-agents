import type { AgentLoopConfig, AgentMessage } from "@open-agents/agent/types";
import type { AssistantMessage, Message, Model, Usage, UserMessage } from "@open-agents/ai";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Build an {@link AgentLoopConfig} with all tiers pointing at the same model (tests). */
export function loopConfig(model: Model, extra?: Partial<AgentLoopConfig>): AgentLoopConfig {
	return {
		tiers: { interface: model, worker: model, compactor: model },
		activeTier: "interface",
		convertToLlm: identityConverter,
		...extra,
	};
}

export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
