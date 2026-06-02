import { ensureLlamaCpp } from "../local/llama-cpp";
import type { ModelManagerOptions } from "../model-manager";
import { Effort } from "../model-thinking";
import type { getBundledModels } from "../models";
import type { Api, Model, ThinkingConfig } from "../types";
import { isRecord, toNumber, toPositiveNumber } from "../utils";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../utils/discovery/openai-compatible";
import { getGitHubCopilotBaseUrl, OPENCODE_HEADERS, parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: Model<TApi>,
	reference: Model<TApi> | undefined,
): Model<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string) => Promise<OllamaResolvedMetadata>,
): Promise<Model<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetch(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<Model<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				thinking: metadata.thinking,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: Model<"openai-responses">[] = resolved.filter((m): m is Model<"openai-responses"> => m !== null);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Fallback context window for Ollama models when `/api/show` is unavailable
 * or omits a `model_info.<arch>.context_length` field. Matches the size
 * Ollama's cloud catalog reports for stock models.
 */
const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Cap max output tokens at a value that matches OMP's other openai-responses defaults. */
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

function getOllamaThinkingConfig(capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	return {
		mode: "effort",
		minLevel: Effort.Minimal,
		maxLevel: Effort.High,
	};
}

/**
 * Query Ollama's `/api/show` endpoint for a single model and pull native
 * context and capability metadata from the response. Returns `undefined` when
 * the endpoint is unavailable so callers can layer their own fallback.
 */
async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
): Promise<OllamaShowMetadata | undefined> {
	try {
		const response = await fetch(`${nativeBaseUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = getOllamaCapabilities(payload.capabilities);
		const contextWindow = getOllamaContextWindow(payload.model_info);
		return {
			contextWindow,
			maxTokens: contextWindow ? OLLAMA_DEFAULT_MAX_TOKENS : undefined,
			capabilities,
			reasoning: capabilities ? capabilities.includes("thinking") : undefined,
			thinking: getOllamaThinkingConfig(capabilities),
			input: capabilities
				? capabilities.includes("vision")
					? (["text", "image"] as Array<"text" | "image">)
					: (["text"] as Array<"text">)
				: undefined,
		};
	} catch {
		// fall through; caller decides on the fallback
	}
	return undefined;
}

/**
 * Build a resolver that fetches `/api/show` metadata per model id and caches
 * the result in-memory for the lifetime of the manager. Successful lookups are
 * cached so repeated `fetchDynamicModels` calls do not refetch; failed
 * lookups stay uncached so a later refresh can recover.
 */
function createOllamaMetadataResolver(nativeBaseUrl: string): (modelId: string) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return modelId => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW, maxTokens: OLLAMA_DEFAULT_MAX_TOKENS };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				maxTokens: metadata.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

const NANO_GPT_NON_TEXT_MODEL_TOKENS = [
	"embedding",
	"image",
	"vision",
	"audio",
	"speech",
	"transcribe",
	"moderation",
	"realtime",
	"whisper",
	"tts",
] as const;

/** Regex matching NanoGPT `:thinking` suffixed model IDs (with or without a level). */
const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !NANO_GPT_NON_TEXT_MODEL_TOKENS.some(token => normalized.includes(token));
}

type SimpleProviderConfig = { apiKey?: string; baseUrl?: string };

function createSimpleOpenAIResponsesOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-responses">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
				}),
		}),
	};
}

export interface XaiOAuthModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

interface XAICuratedModel {
	id: string;
	contextWindow: number;
	name?: string;
	/** Whether the model reasons natively. Defaults to true for Grok-4.x family. */
	reasoning?: boolean;
	/**
	 * Whether xAI accepts the `reasoning.effort` wire param for this model.
	 * Default true. When false: picker hides the effort dial (via
	 * getSupportedEfforts in model-thinking.ts) AND wire-side already omits
	 * the param via GROK_EFFORT_CAPABLE_PREFIXES in providers/xai-responses.ts.
	 * Must agree with that allowlist; two truths kept in sync by curated-catalog
	 * author convention until a follow-up Op: compress unifies them.
	 */
	supportsReasoningEffort?: boolean;
	/**
	 * Input modalities this model accepts. Defaults to `["text"]` when absent.
	 * Vision-capable Grok models MUST list `"image"` here so the curated layer
	 * overrides `fetchOpenAICompatibleModels`' default of `["text"]` (which
	 * otherwise strips image capability on every online refresh).
	 */
	input?: ("text" | "image")[];
}

// Source of truth for the xai-oauth chat picker. Top of list = headline.
// Context windows from hermes-agent/agent/model_metadata.py:205-220
// ("Values sourced from models.dev (2026-04)"). grok-build is xAI's
// coding-fine-tuned chat model; 512K context per user spec (2026-05-17).
//
// supportsReasoningEffort=false entries reason natively but reject the wire
// `reasoning.effort` param (api.x.ai returns HTTP 400). Mirrors the HTTP-side
// GROK_EFFORT_CAPABLE_PREFIXES allowlist in providers/xai-responses.ts. The
// curated flag is the picker-visible truth; the HTTP allowlist is the wire
// truth. omitReasoningEffort in xai-responses.ts already prevents 400s; this
// fixes the picker UX wart of advertising an inert dial.
export const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[] = [
	// grok-build is text-only per the bundled catalog; omit `input` for the default.
	{ id: "grok-build", contextWindow: 512_000, name: "Grok Build", supportsReasoningEffort: false },
	{ id: "grok-4.3", contextWindow: 1_000_000, name: "Grok 4.3", input: ["text", "image"] },
	// grok-4.20-multi-agent-0309 is text-only per the bundled catalog; omit `input` for the default.
	{ id: "grok-4.20-multi-agent-0309", contextWindow: 2_000_000, name: "Grok 4.20 (Multi-Agent)" },
	{
		id: "grok-4.20-0309-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Reasoning)",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
	},
] as const;

// xAI /v1/models returns chat, image, voice, and STT entries. Tool surfaces
// route through dedicated tools (generate_image, tts) with their own model
// strings; the chat picker MUST exclude these prefixes or selecting them 400s.
const XAI_NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;

// Hermes-agent parity: only the `minimal -> low` clamp is applied (see
// hermes-agent/agent/transports/codex.py:92 `_effort_clamp = {"minimal":
// "low"}`). Hermes sends `xhigh` to xAI verbatim and we match that contract
// — let xAI decide if the level is valid for the specific Grok model.
// applyResponsesReasoningParams runs this through `model.compat.reasoningEffortMap`
// at request time, downstream of the omitReasoningEffort gate in xai-responses.ts.
const XAI_REASONING_EFFORT_MAP = { minimal: "low" } as const;

// Single source of truth for curated → Model fan-in. Used by the static-seed
// and the dynamic overlay/inject paths (applyXAIOAuthCuration) so curated
// reasoning/effort flags survive an online refresh (xAI's /v1/models lacks
// reasoning metadata and fetchOpenAICompatibleModels defaults reasoning to
// false). Caller supplies a `base` Model (either a freshly synthesised seed
// or a dynamic-fetched entry); the helper layers curated fields on top.
// The `minimal -> low` effort clamp (XAI_REASONING_EFFORT_MAP) is always
// merged in so dynamic-fetched models — which arrive without curated
// compat keys — still get the clamp applyResponsesReasoningParams expects.
function mergeCuratedIntoModel(base: Model<"openai-responses">, curated: XAICuratedModel): Model<"openai-responses"> {
	const effort = curated.supportsReasoningEffort;
	const compat = {
		...(base.compat ?? {}),
		reasoningEffortMap: { ...XAI_REASONING_EFFORT_MAP, ...(base.compat?.reasoningEffortMap ?? {}) },
		...(effort === undefined ? {} : { supportsReasoningEffort: effort }),
	};
	return {
		...base,
		contextWindow: curated.contextWindow,
		name: curated.name ?? base.name,
		reasoning: curated.reasoning ?? true,
		input: curated.input ?? base.input,
		compat,
	};
}

/**
 * Overlay/inject curated xai-oauth metadata onto dynamic-fetch results so
 * a successful `online refresh` doesn't regress vision capability, context
 * window, reasoning flags, or the effort-dial allowlist.
 *
 * Three passes:
 *   1. Filter `XAI_NON_CHAT_PREFIXES` (picker pollution defense for tool
 *      surfaces routed through dedicated tools — generate_image, tts).
 *   2. Overlay curated metadata onto dynamic-fetch matches. xAI's /v1/models
 *      does not return context_window or reasoning metadata, so without
 *      this overlay the runtime falls back to the bundled-reference default
 *      (effectively 128k context) and `reasoning: false` (suppressing the
 *      effort dial and stripping thinking metadata downstream).
 *   3. Inject curated entries missing from the dynamic fetch. Clones the
 *      first surviving entry as a template so required Model fields (api,
 *      provider, baseUrl, cost, etc.) inherit sane defaults. If `filtered`
 *      is empty (offline / no auth) injection is skipped — the descriptor's
 *      defaultModel covers the fallback.
 *
 * Order: curated models first in declaration order; then dynamic remainder
 * in original order.
 */
function applyXAIOAuthCuration(dynamic: readonly Model<"openai-responses">[]): Model<"openai-responses">[] {
	const filtered = dynamic.filter(e => !XAI_NON_CHAT_PREFIXES.some(p => e.id.startsWith(p)));

	const byId = new Map<string, Model<"openai-responses">>(filtered.map(e => [e.id, e]));
	for (const curated of XAI_OAUTH_CURATED_MODELS) {
		const existing = byId.get(curated.id);
		if (existing) {
			byId.set(curated.id, mergeCuratedIntoModel(existing, curated));
		}
	}

	const template = filtered[0];
	if (template) {
		for (const curated of XAI_OAUTH_CURATED_MODELS) {
			if (!byId.has(curated.id)) {
				// Reset id/name on the template before merging so the helper's
				// `curated.name ?? base.name` clause falls back to curated.id
				// (the inject contract), not to the unrelated template's label.
				const base: Model<"openai-responses"> = { ...template, id: curated.id, name: curated.id };
				byId.set(curated.id, mergeCuratedIntoModel(base, curated));
			}
		}
	}

	const curatedIds = new Set(XAI_OAUTH_CURATED_MODELS.map(c => c.id));
	const curatedFirst = XAI_OAUTH_CURATED_MODELS.map(c => byId.get(c.id)).filter(
		(e): e is Model<"openai-responses"> => e !== undefined,
	);
	const rest = filtered.filter(e => !curatedIds.has(e.id));
	return [...curatedFirst, ...rest];
}

/**
 * Render `XAI_OAUTH_CURATED_MODELS` as full `Model<"openai-responses">` entries.
 *
 * Single source of truth for the curated to Model fan-in, consumed by both
 * - {@link xaiOAuthModelManagerOptions} (runtime static seed handed to the model
 *   manager so the picker is populated on a fresh login), and
 * - `packages/ai/scripts/generate-models.ts` (bundles the same entries into
 *   `models.json`, so the synchronous `ModelRegistry.#loadModels()` boot path
 *   sees `xai-oauth` without waiting for a refresh — fixes the boot-time
 *   default-model reset when `modelRoles.default = "xai-oauth/<id>"`).
 *
 * `reasoning` defaults to `true` for the Grok-4.x family; the explicit
 * `grok-4.20-0309-non-reasoning` entry opts out via `XAICuratedModel.reasoning`.
 * `maxTokens` uses `UNK_MAX_TOKENS` so id-keyed overlays from a successful
 * dynamic fetch merge cleanly. Mirrors
 * `hermes-agent/hermes_cli/models.py:_XAI_STATIC_FALLBACK`.
 */
export function buildXaiOAuthStaticSeed(baseUrl?: string): Model<"openai-responses">[] {
	const resolvedBaseUrl = baseUrl ?? "https://api.x.ai/v1";
	return XAI_OAUTH_CURATED_MODELS.map(curated => {
		// Synthesise a bare base then layer curated metadata via the same helper
		// the dynamic overlay/inject paths use. `name: curated.id` is a sentinel
		// the helper rewrites to `curated.name ?? base.name`, so curated.name
		// wins when set.
		const base: Model<"openai-responses"> = {
			id: curated.id,
			name: curated.id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: resolvedBaseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: curated.contextWindow,
			maxTokens: UNK_MAX_TOKENS,
			compat: { reasoningEffortMap: XAI_REASONING_EFFORT_MAP },
		};
		return mergeCuratedIntoModel(base, curated);
	});
}

export function xaiOAuthModelManagerOptions(
	config?: XaiOAuthModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const defaultBaseUrl = "https://api.x.ai/v1";
	const resolvedBaseUrl = config?.baseUrl ?? defaultBaseUrl;
	const base = createSimpleOpenAIResponsesOptions(
		"xai-oauth" as Parameters<typeof getBundledModels>[0],
		defaultBaseUrl,
		config,
	);
	// Static seed handed to the runtime model manager so the picker populates on
	// a fresh login even before `fetchDynamicModels` fires (it is gated on
	// `config.apiKey` at construction time, and OAuth tokens resolve later via
	// AuthStorage). `generate-models.ts` calls the same builder so `models.json`
	// carries these entries too — making the synchronous `#loadModels()` boot
	// path honor `modelRoles.default = "xai-oauth/<id>"` without `await refresh()`.
	const staticModels = buildXaiOAuthStaticSeed(resolvedBaseUrl);
	if (!base.fetchDynamicModels) {
		return { ...base, staticModels };
	}
	// Wrap fetchDynamicModels so an `online refresh` against xAI's /v1/models
	// runs through applyXAIOAuthCuration — preserves curated context windows,
	// vision modality, reasoning flags, and filters tool-only model ids
	// (grok-imagine-*, grok-stt-*, grok-voice-*) from the chat picker.
	const inner = base.fetchDynamicModels;
	return {
		...base,
		staticModels,
		fetchDynamicModels: async () => {
			const dynamic = await inner();
			return dynamic == null ? dynamic : applyXAIOAuthCuration(dynamic);
		},
	};
}

// ---------------------------------------------------------------------------
// 6.7 Zhipu Coding Plan
// ---------------------------------------------------------------------------

export interface ZhipuCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function zhipuCodingPlanModelManagerOptions(
	config?: ZhipuCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
	return {
		providerId: "zhipu-coding-plan",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "zhipu-coding-plan",
					baseUrl,
					apiKey,
					mapModel: (
						_entry: OpenAICompatibleModelRecord,
						defaults: Model<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): Model<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							reasoning: ZHIPU_REASONING_MODELS[id] === true || id.includes("thinking"),
							input: ZHIPU_VISION_PATTERN.test(id) ? (["text", "image"] as const) : ["text"],
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
				}),
		}),
	};
}

// Reasoning-capable GLM models on the BigModel coding-plan SKU. Keep this
// explicit rather than regex-matching `glm-[45]\.\d` so newly-added integers
// like `glm-5` / `glm-5-turbo` are covered and unrelated future SKUs (e.g.
// `glm-5-preview`) do not silently flip into thinking mode.
const ZHIPU_REASONING_MODELS: Readonly<Record<string, true>> = {
	"glm-4.5": true,
	"glm-4.5-air": true,
	"glm-4.6": true,
	"glm-4.7": true,
	"glm-5": true,
	"glm-5-turbo": true,
	"glm-5.1": true,
};

// Vision-capable GLM models follow the `glm-<N>[.<N>]v[-<variant>]` shape
// (e.g. `glm-4v`, `glm-4.5v`, `glm-4v-plus`). The previous `id.includes("v")`
// check matched anything with a `v` — including the non-vision `glm-5-preview`.
const ZHIPU_VISION_PATTERN = /^glm-[45](?:\.\d+)?v(?:-|$)/;

// ---------------------------------------------------------------------------
// 7.7 Wafer (Pass + Serverless)
// ---------------------------------------------------------------------------

export interface WaferModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

const WAFER_DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MAX_TOKENS_CAP = 65536;

/**
 * Shared mapper for Wafer's `/v1/models` records.
 *
 * Wafer wraps each entry with a `wafer` envelope describing tier, capabilities,
 * and cents-per-million pricing. The mapper folds that metadata into the
 * canonical `Model<"openai-completions">` shape and applies zai-family thinking
 * compat when the entry advertises reasoning support (GLM-family on the Pass
 * SKU). Cents-per-million → dollars-per-million via /100.
 */
interface WaferRecord {
	context_length?: unknown;
	tier?: unknown;
	provider?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown; tools?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function readWaferRecord(entry: OpenAICompatibleModelRecord): WaferRecord | undefined {
	const raw = (entry as { wafer?: unknown }).wafer;
	return raw && typeof raw === "object" ? (raw as WaferRecord) : undefined;
}

function mapWaferModel(
	providerId: "wafer-pass" | "wafer-serverless",
	baseUrl: string,
	entry: OpenAICompatibleModelRecord,
	defaults: Model<"openai-completions">,
): Model<"openai-completions"> {
	const wafer = readWaferRecord(entry);
	const capabilities = wafer?.capabilities ?? {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const contextWindow = toPositiveNumber(
		wafer?.context_length,
		toPositiveNumber((entry as { max_model_len?: unknown }).max_model_len, defaults.contextWindow),
	);
	const maxTokens = Math.min(contextWindow, WAFER_MAX_TOKENS_CAP);
	const pricing = wafer?.pricing ?? {};
	// Wafer's `/v1/models` exposes pricing through `*_cents_per_million` fields,
	// but the values are an internal wholesale unit, not literal cents — across
	// every published Serverless model on wafer.ai the user-facing rate equals
	// `cents × 125 / 10000` (i.e. wholesale × 1.25 / 100; GLM-5.1's `120` →
	// $1.50/M, Kimi-K2.6's `88` → $1.10/M, etc.). The multiply-first form keeps
	// the result a finite dyadic for every observed value.
	// For the Pass SKU the per-token rate is bundled in the flat-rate
	// subscription, so we follow the convention shared with
	// `kimi-code`/`firepass`/`alibaba-coding-plan` and seed every Pass model with
	// `cost: 0` regardless of what the upstream envelope says.
	const isPassSku = providerId === "wafer-pass";
	const cost = isPassSku
		? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
		: {
				input: (toPositiveNumber(pricing.input_cents_per_million, 0) * 125) / 10000,
				output: (toPositiveNumber(pricing.output_cents_per_million, 0) * 125) / 10000,
				cacheRead: (toPositiveNumber(pricing.cache_read_cents_per_million, 0) * 125) / 10000,
				cacheWrite: 0,
			};
	const name = toModelName(wafer?.display_name, defaults.name);
	const base: Model<"openai-completions"> = {
		...defaults,
		id: defaults.id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning,
		input: vision ? (["text", "image"] as const) : ["text"],
		cost,
		contextWindow,
		maxTokens,
	};
	if (reasoning) {
		// Wafer's `wafer.provider` envelope tells us which upstream backend serves
		// the model. Each upstream accepts a different thinking-control parameter
		// on the wire — Wafer passes the body through, so we must mirror the
		// upstream's native shape:
		//   - zai (GLM) and moonshotai (Kimi) → `thinking: { type: "enabled" | "disabled" }`
		//   - qwen (Alibaba) → top-level `enable_thinking: boolean`
		//   - deepseek → `reasoning_effort` (DeepSeek effort map; the model always
		//     reasons when invoked, replay of `reasoning_content` is required on
		//     tool-call turns — both handled by `detectOpenAICompat` from the id).
		// For unknown upstreams we omit `thinkingFormat` and let the per-id
		// detection in `detectOpenAICompat` pick a safe default.
		const upstream = typeof wafer?.provider === "string" ? wafer.provider : undefined;
		const thinkingFormat: "zai" | "qwen" | undefined =
			upstream === "zai" || upstream === "moonshotai" ? "zai" : upstream === "qwen" ? "qwen" : undefined;
		return {
			...base,
			compat: {
				...(thinkingFormat ? { thinkingFormat } : {}),
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		};
	}
	return {
		...base,
		compat: { supportsDeveloperRole: false },
	};
}

function createWaferOptions(
	providerId: "wafer-pass" | "wafer-serverless",
	config: WaferModelManagerConfig | undefined,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? WAFER_DEFAULT_BASE_URL;
	const passOnly = providerId === "wafer-pass";
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					filterModel: entry => {
						if (!passOnly) return true;
						const wafer = readWaferRecord(entry);
						return wafer?.tier === "pass_included";
					},
					mapModel: (entry, defaults) => mapWaferModel(providerId, baseUrl, entry, defaults),
				}),
		}),
	};
}

export function waferPassModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createWaferOptions("wafer-pass", config);
}

export function waferServerlessModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createWaferOptions("wafer-serverless", config);
}

// ---------------------------------------------------------------------------
// 8. OpenCode
// ---------------------------------------------------------------------------

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function normalizeOpenCodeBasePath(baseUrl: string | undefined, fallbackBasePath: string): string {
	const value = normalizeAnthropicBaseUrl(baseUrl, fallbackBasePath);
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function openCodeBaseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	defaultBasePath: string,
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const basePath = normalizeOpenCodeBasePath(config?.baseUrl, defaultBasePath);
	const discoveryBaseUrl = openCodeBaseUrlForApi("openai-completions", basePath);
	const references = createBundledReferenceMap<Api>(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const name = toModelName(entry.name, reference?.name ?? defaults.name);
						if (!reference) {
							return {
								...defaults,
								name,
							};
						}
						return {
							...reference,
							id: defaults.id,
							name,
							baseUrl: openCodeBaseUrlForApi(reference.api, basePath),
							contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
						};
					},
				}),
		}),
	};
}

export function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-go", "https://opencode.ai/zen/go", config);
}

// ---------------------------------------------------------------------------
// 9. Ollama
// ---------------------------------------------------------------------------

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl);
	return {
		providerId: "ollama",
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							model.thinking = metadata.thinking;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl, resolveMetadata);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

// ---------------------------------------------------------------------------
// 12.5. LM Studio
// ---------------------------------------------------------------------------

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio" as any);
	return {
		providerId: "lm-studio",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 20. Xiaomi
// ---------------------------------------------------------------------------

export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	// Xiaomi splits API keys across two backends: standard `sk-` keys hit
	// api.xiaomimimo.com; "token plan" `tp-` keys are scoped to a regional
	// cluster and are tried in order until discovery succeeds.
	const TOKEN_PLAN_BASE_URLS = [
		"https://token-plan-sgp.xiaomimimo.com/v1",
		"https://token-plan-ams.xiaomimimo.com/v1",
		"https://token-plan-cn.xiaomimimo.com/v1",
	] as const;
	const STANDARD_BASE_URL = "https://api.xiaomimimo.com/v1";
	const isTokenPlanKey = apiKey?.startsWith("tp-");
	// Token-plan keys always use a TP cluster; config?.baseUrl (from catalog)
	// would incorrectly pin to the standard endpoint (api.xiaomimimo.com).
	const baseUrl = isTokenPlanKey ? TOKEN_PLAN_BASE_URLS[0] : (config?.baseUrl ?? STANDARD_BASE_URL);
	const references = createBundledReferenceMap<"openai-completions">("xiaomi");
	const fetchModels = (url: string) =>
		fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "xiaomi",
			baseUrl: url,
			apiKey,
			filterModel: (_entry, model) => !model.id.includes("-tts"),
			mapModel: (entry, defaults) => {
				const reference = references.get(defaults.id);
				const model = mapWithBundledReference(entry, defaults, reference);
				return {
					...model,
					name: toModelName(entry.display_name, model.name),
				};
			},
		});
	return {
		providerId: "xiaomi",
		...(apiKey && {
			fetchDynamicModels: async () => {
				if (!isTokenPlanKey) {
					return fetchModels(baseUrl);
				}
				for (const url of TOKEN_PLAN_BASE_URLS) {
					const result = await fetchModels(url);
					if (result) return result;
				}
				return null;
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 22. vLLM
// ---------------------------------------------------------------------------

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://127.0.0.1:8000/v1";
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
					};
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// Local-first runtimes: LocalAI, Jan, llamafile, TabbyAPI, llama.cpp
// ---------------------------------------------------------------------------

export interface LocalAiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

/** LocalAI — OpenAI drop-in, default http://127.0.0.1:8080/v1. */
export function localaiModelManagerOptions(
	config?: LocalAiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LOCALAI_BASE_URL ?? "http://127.0.0.1:8080/v1";
	const references = createBundledReferenceMap<"openai-completions">(
		"localai" as Parameters<typeof getBundledModels>[0],
	);
	return {
		providerId: "localai",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "localai",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, references.get(defaults.id)),
			}),
	};
}

export interface JanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

/** Jan — desktop app API, default http://127.0.0.1:1337/v1. */
export function janModelManagerOptions(config?: JanModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.JAN_BASE_URL ?? "http://127.0.0.1:1337/v1";
	const references = createBundledReferenceMap<"openai-completions">("jan" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "jan",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "jan",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, references.get(defaults.id)),
			}),
	};
}

export interface LlamafileModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

/** llamafile — single-file executables, default http://127.0.0.1:8080/v1. */
export function llamafileModelManagerOptions(
	config?: LlamafileModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LLAMAFILE_BASE_URL ?? "http://127.0.0.1:8080/v1";
	const references = createBundledReferenceMap<"openai-responses">(
		"llamafile" as Parameters<typeof getBundledModels>[0],
	);
	return {
		providerId: "llamafile",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "llamafile",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, references.get(defaults.id)),
			}),
	};
}

export interface TabbyApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

/** TabbyAPI — ExLlamaV2, default http://127.0.0.1:5000/v1. */
export function tabbyapiModelManagerOptions(
	config?: TabbyApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.TABBYAPI_BASE_URL ?? "http://127.0.0.1:5000/v1";
	const references = createBundledReferenceMap<"openai-completions">(
		"tabbyapi" as Parameters<typeof getBundledModels>[0],
	);
	return {
		providerId: "tabbyapi",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "tabbyapi",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, references.get(defaults.id)),
			}),
	};
}

export interface LlamaCppModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	executablePath?: string;
	modelPath?: string;
	contextSize?: number;
	threads?: number;
	autoStart?: boolean;
}

/**
 * llama.cpp — manages a `llama-server` lifecycle via {@link ensureLlamaCpp}
 * before listing models. Default http://127.0.0.1:8080.
 */
export function llamaCppModelManagerOptions(
	config?: LlamaCppModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://127.0.0.1:8080";
	const references = createBundledReferenceMap<"openai-responses">(
		"llama.cpp" as Parameters<typeof getBundledModels>[0],
	);
	return {
		providerId: "llama.cpp",
		fetchDynamicModels: async () => {
			const handle = await ensureLlamaCpp({
				baseUrl,
				executablePath: config?.executablePath,
				modelPath: config?.modelPath,
				contextSize: config?.contextSize,
				threads: config?.threads,
				autoStart: config?.autoStart,
			});
			return fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "llama.cpp",
				baseUrl: `${handle.baseUrl.replace(/\/$/, "")}/v1`,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, references.get(defaults.id)),
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 23. NanoGPT
// ---------------------------------------------------------------------------

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async () => {
				// Track base IDs that have :thinking variants so we can mark them reasoning-capable.
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
				});
				if (!models) return null;
				// Mark base models as reasoning-capable when a :thinking variant existed.
				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. GitHub Copilot
// ---------------------------------------------------------------------------

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function inferCopilotApi(modelId: string): Api {
	if (/^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId)) {
		return "anthropic-messages";
	}
	if (modelId.startsWith("gpt-5") || modelId.startsWith("oswe")) {
		return "openai-responses";
	}
	return "openai-completions";
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
			? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
			: configuredBaseUrl;
	const providerRefs = createBundledReferenceMap<Api>("github-copilot");
	const resolveReference = createReferenceResolver(providerRefs);
	return {
		providerId: "github-copilot",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl,
					apiKey,
					headers: OPENCODE_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: Model<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): Model<Api> => {
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						// Copilot exposes token limits under capabilities.limits.*.
						// max_context_window_tokens is the model's total usable window;
						// max_prompt_tokens is Copilot's prompt/summarization budget and
						// must only be a fallback when total-window fields are absent.
						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						if (reference) {
							return {
								...reference,
								api,
								provider: "github-copilot",
								baseUrl,
								name,
								contextWindow,
								maxTokens,
								headers: { ...OPENCODE_HEADERS, ...(providerRefs.get(defaults.id)?.headers ?? {}) },
								...(api === "openai-completions"
									? {
											compat: {
												supportsStore: false,
												supportsDeveloperRole: false,
												supportsReasoningEffort: false,
											},
										}
									: {}),
							};
						}
						return {
							...defaults,
							api,
							baseUrl,
							name,
							contextWindow,
							maxTokens,
							headers: { ...OPENCODE_HEADERS },
							...(api === "openai-completions"
								? {
										compat: {
											supportsStore: false,
											supportsDeveloperRole: false,
											supportsReasoningEffort: false,
										},
									}
								: {}),
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// Models.dev provider descriptors for generate-models.ts
// ---------------------------------------------------------------------------

export const UNK_CONTEXT_WINDOW = 222_222;
export const UNK_MAX_TOKENS = 8_888;

/** Describes how to map models.dev API data for a single provider. */
export interface ModelsDevProviderDescriptor {
	/** Key in the models.dev API response JSON (e.g., "anthropic", "amazon-bedrock") */
	modelsDevKey: string;
	/** Provider ID in our system */
	providerId: string;
	/** Default API type for this provider's models */
	api: Api;
	/** Default base URL */
	baseUrl: string;
	/** Default context window fallback (default: UNKNNOWN_CONTEXT_WINDOW) */
	defaultContextWindow?: number;
	/** Default max tokens fallback (default: UNKNNOWN_MAX_TOKENS) */
	defaultMaxTokens?: number;
	/** Optional compat overrides applied to every model from this provider */
	compat?: Model<Api>["compat"];
	/** Optional static headers applied to every model */
	headers?: Record<string, string>;
	/**
	 * Optional filter: return false to skip a model.
	 * Called with (modelId, rawModel). Default: skip if tool_call !== true.
	 */
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	/**
	 * Optional transform: modify the mapped model before it's added.
	 * Can return null to skip the model, or an array to emit multiple models.
	 */
	transformModel?: (model: Model<Api>, modelId: string, raw: ModelsDevModel) => Model<Api> | Model<Api>[] | null;
	/**
	 * Optional: override the API type per-model.
	 * Called with (modelId, raw). Return the API type to use.
	 * If not provided, uses the `api` field.
	 */
	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

// Bedrock cross-region prefix helpers
const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

function createOpenCodeApiResolution(
	basePath: string,
	idOverrides: Readonly<Record<string, Api>> = {},
): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;
	// Per-API base URLs on the OpenCode-style endpoint:
	// - openai-completions / openai-responses / google-generative-ai → /v1
	// - anthropic-messages → bare basePath (the Anthropic client appends /v1/messages)
	const baseUrlForApi = (api: Api): string => (api === "anthropic-messages" ? basePath : completionsBaseUrl);
	const overrideRules: ApiResolutionRule[] = Object.entries(idOverrides).map(([id, api]) => ({
		matches: modelId => modelId === id,
		resolved: { api, baseUrl: baseUrlForApi(api) },
	}));
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			// Per-id overrides take precedence over npm-based heuristics so we can
			// correct upstream metadata mismatches (see OPENCODE_GO_API_RESOLUTION).
			...overrideRules,
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen");
// OpenCode Go: models.dev declares minimax-m2.7 / qwen3.5-plus / qwen3.6-plus
// with `provider.npm = "@ai-sdk/anthropic"`, but the OpenCode Go gateway only
// serves them at `https://opencode.ai/zen/go/v1/chat/completions` (verified
// against https://opencode.ai/zen/go/v1/models and the upstream endpoint
// table at https://opencode.ai/docs/go/#endpoints — minimax-m2.5 works the
// same way and lacks an `npm` field on models.dev so it already falls through
// to the openai-completions default). Without this override the resolver
// would POST anthropic-style requests to /v1/messages and the gateway would
// return its `Page Not Found` HTML (issue #887). Override the resolver so
// regenerating models.json keeps the correct routing.
const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen/go", {
	"minimax-m2.7": "openai-completions",
	"qwen3.5-plus": "openai-completions",
	"qwen3.6-plus": "openai-completions",
});

const COPILOT_BASE_URL = "https://api.githubcopilot.com";

const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => /^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId),
		resolved: { api: "anthropic-messages", baseUrl: COPILOT_BASE_URL },
	},
	{
		matches: modelId => modelId.startsWith("gpt-5") || modelId.startsWith("oswe"),
		resolved: { api: "openai-responses", baseUrl: COPILOT_BASE_URL },
	},
];

function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_VERTEX_OPENAI_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi";
const GOOGLE_VERTEX_ANTHROPIC_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict";

function resolveGoogleVertexApi(modelId: string, raw: ModelsDevModel): { api: Api; baseUrl: string } {
	if (raw.provider?.npm === "@ai-sdk/google-vertex/anthropic") {
		return {
			api: "anthropic-messages",
			baseUrl: GOOGLE_VERTEX_ANTHROPIC_BASE_URL.replace("{model}", modelId),
		};
	}
	if (modelId.includes("/") || raw.provider?.npm === "@ai-sdk/openai-compatible") {
		return { api: "openai-completions", baseUrl: GOOGLE_VERTEX_OPENAI_BASE_URL };
	}
	return { api: "google-vertex", baseUrl: GOOGLE_VERTEX_BASE_URL };
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	// --- Amazon Bedrock ---
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (id.startsWith("ai21.jamba")) return false;
			if (id.startsWith("amazon.titan-text-express") || id.startsWith("mistral.mistral-7b-instruct-v0"))
				return false;
			return true;
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: Model<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};
			// Also emit EU variants for Claude models
			if (modelId.startsWith("anthropic.claude-")) {
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${toModelName(m.name, modelId)} (EU)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	// --- Anthropic ---
	anthropicMessagesDescriptor("anthropic", "anthropic", "https://api.anthropic.com", {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (
				id.startsWith("claude-3-5-haiku") ||
				id.startsWith("claude-3-7-sonnet") ||
				id === "claude-3-opus-20240229" ||
				id === "claude-3-sonnet-20240229"
			)
				return false;
			return true;
		},
	}),
	// --- Google ---
	simpleModelsDevDescriptor(
		"google",
		"google",
		"google-generative-ai",
		"https://generativelanguage.googleapis.com/v1beta",
	),
	// --- OpenAI ---
	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),
	// --- Groq ---
	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),
	// --- Cerebras ---
	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),
	// --- Together ---
	openAiCompletionsDescriptor("together", "together", "https://api.together.xyz/v1"),
	// --- NVIDIA ---
	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),
	// --- xAI ---
	openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1"),
	// --- DeepSeek ---
	openAiCompletionsDescriptor("deepseek", "deepseek", "https://api.deepseek.com", {
		// Only ship the v4 family as built-ins; older deepseek-chat / deepseek-reasoner
		// ids are kept off the catalog until the issue thread asks for them.
		filterModel: (id, m) => m.tool_call === true && id.startsWith("deepseek-v4"),
		compat: {
			// DeepSeek V4 only accepts `high`/`max`; map lower OMP levels upward so
			// subagent "minimal" turns stay in documented thinking mode instead of
			// sending unsupported effort strings.
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
			maxTokensField: "max_tokens",
			// DeepSeek V4 thinking mode rejects the `tool_choice` control parameter.
			// Tool calls still work without it; the API defaults to auto when tools exist.
			supportsToolChoice: false,
			// DeepSeek V4's OpenAI format docs enable thinking with both the toggle and
			// reasoning_effort. Keep the toggle explicit for built-in models.
			extraBody: { thinking: { type: "enabled" } },
			// DeepSeek emits chain-of-thought via `reasoning_content` and requires it
			// to round-trip on assistant tool-call messages so the model can resume
			// from prior thinking (interleaved.field=reasoning_content on models.dev,
			// matches the kimi/openrouter handling already in detectCompat).
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: true,
		},
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	// --- zAI ---
	anthropicMessagesDescriptor("zai-coding-plan", "zai", "https://api.z.ai/api/anthropic"),
	// --- Xiaomi ---
	openAiCompletionsDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/v1", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
		compat: {
			supportsStore: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		},
	}),
	// --- MiniMax Coding Plan ---
	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	// --- Alibaba Coding Plan ---
	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),
	// --- Zhipu Coding Plan ---
	openAiCompletionsDescriptor(
		"zhipu-coding-plan",
		"zhipu-coding-plan",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		{
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		},
	),
];

const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

const MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("google-vertex", "google-vertex", "google-vertex", GOOGLE_VERTEX_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: resolveGoogleVertexApi,
	}),
];

const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	// --- Cloudflare AI Gateway ---
	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
	),
	// --- Mistral ---
	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),
	// --- OpenCode Zen ---
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- OpenCode Go ---
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- GitHub Copilot ---
	openAiCompletionsDescriptor("github-copilot", "github-copilot", COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...OPENCODE_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			// compat only applies to openai-completions models
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),
	// --- MiniMax (Anthropic) ---
	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),
	// --- Qwen Portal ---
	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),

	// --- ZenMux ---
	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (modelId.startsWith("anthropic/")) {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];
/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];
