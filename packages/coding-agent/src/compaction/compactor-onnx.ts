import type { OnnxSummarizer } from "@open-agents/agent/compaction/onnx-summarizer";
import { logger } from "@open-agents/utils";
import type { Settings } from "../config/settings";
import {
	DEFAULT_MEMORY_LOCAL_MODEL_KEY,
	isTinyMemoryLocalModelKey,
	type TinyMemoryLocalModelKey,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

/** Setting key: local ONNX model for compactor-tier summarization (`online` = disabled). */
export const COMPACTOR_ONNX_MODEL_SETTING = "providers.compactorOnnxModel" as const;

/**
 * Resolve the configured local compaction model. Returns `undefined` when
 * compaction should use the server compactor tier (default).
 */
export function resolveCompactorOnnxModelKey(settings: Settings): TinyMemoryLocalModelKey | undefined {
	let value: string | undefined;
	try {
		value = settings.get(COMPACTOR_ONNX_MODEL_SETTING);
	} catch {
		return undefined;
	}
	if (!value || value === "online") return undefined;
	if (isTinyMemoryLocalModelKey(value)) return value;
	logger.warn("compaction: ignoring invalid providers.compactorOnnxModel", { value });
	return undefined;
}

/** Whether local ONNX compaction is enabled for this settings snapshot. */
export function isCompactorOnnxEnabled(settings: Settings): boolean {
	return resolveCompactorOnnxModelKey(settings) !== undefined;
}

/**
 * Build an {@link OnnxSummarizer} backed by the shared tiny-model subprocess,
 * or `undefined` when `providers.compactorOnnxModel` is `online`/unset.
 */
export function createCompactorOnnxSummarizer(settings: Settings): OnnxSummarizer | undefined {
	const modelKey = resolveCompactorOnnxModelKey(settings);
	if (!modelKey) return undefined;

	return {
		summarize: async ({ promptText, maxTokens, signal }) => {
			const text = await tinyModelClient.summarize(modelKey, promptText, { maxTokens, signal });
			if (text === null) {
				logger.debug("compaction: local ONNX summarization returned no text", { modelKey });
			}
			return text;
		},
	};
}

/** Default local model when docs/examples refer to a recommended compaction ONNX pick. */
export const DEFAULT_COMPACTOR_ONNX_MODEL_KEY = DEFAULT_MEMORY_LOCAL_MODEL_KEY;
