/**
 * Optional on-device ONNX summarization for context compaction.
 *
 * Implemented in coding-agent via the tiny-model subprocess; injected into
 * `generateSummary` and related call sites so the agent package stays free of
 * transformers/onnxruntime dependencies.
 */

export interface OnnxSummarizeRequest {
	/** Full task prompt (system instructions may be prepended by the caller). */
	promptText: string;
	maxTokens?: number;
	signal?: AbortSignal;
}

/**
 * Local ONNX inference for compaction. Return `null` when the worker is
 * unavailable or generation failed so callers can fall back to the server model.
 */
export interface OnnxSummarizer {
	summarize(request: OnnxSummarizeRequest): Promise<string | null>;
}
