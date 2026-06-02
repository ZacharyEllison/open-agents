import { $env, extractHttpStatusFromError } from "@open-agents/utils";
import { getCustomApi } from "./api-registry";
import type { Effort } from "./model-thinking";
import { modelOmitsReasoningEffort, requireSupportedEffort } from "./model-thinking";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. Only the two local
// OpenAI-compatible transports remain after the local-first refactor.
import { streamOpenAICompletions, streamOpenAIResponses } from "./providers/register-builtins";
import { isUsageLimitError } from "./rate-limit-utils";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	StreamOptions,
	ToolChoice,
} from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { withRequestDebugFetch } from "./utils/request-debug";

type KeyResolver = string | (() => string | undefined);

const serviceProviderMap: Record<string, KeyResolver> = {
	ollama: "OLLAMA_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	vllm: "VLLM_API_KEY",
	"lm-studio": "LM_STUDIO_API_KEY",
	localai: "LOCALAI_API_KEY",
	jan: "JAN_API_KEY",
	llamafile: "LLAMAFILE_API_KEY",
	tabbyapi: "TABBYAPI_API_KEY",
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 * Checks Bun.env, then cwd/.env, then ~/.env.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `omp auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const requestOptions = withRequestDebugFetch(options as StreamOptions | undefined) as
		| OptionsForApi<TApi>
		| undefined;

	// Check custom API registry first (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, requestOptions as StreamOptions);
	}

	const apiKey = requestOptions?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	const providerOptions = { ...requestOptions, apiKey };

	const api: Api = model.api;
	switch (api) {
		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

		case "openai-responses":
			return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);

		default:
			throw new Error(`Unhandled API: ${api}`);
	}
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return extractHttpStatusFromError({ message: message.errorMessage });
}

function isRetryableUpstreamError(error: unknown, status: number | undefined, message: string | undefined): boolean {
	// 401 means the credential is bad. Usage-limit phrasing (Codex's
	// "You have hit your ChatGPT usage limit", Anthropic's "usage_limit_reached",
	// Google's "resource_exhausted") means this account is parked but a
	// sibling credential can usually pick the request up. Both are
	// rotatable via `onAuthError` — the auth-gateway maps the former to
	// `invalidateCredentialMatching` and the latter to `markUsageLimitReached`.
	if (status === 401) return true;
	void error;
	return !!message && isUsageLimitError(message);
}

function createAssistantAuthError(message: AssistantMessage): Error & { status?: number } {
	const error: Error & { status?: number } = new Error(message.errorMessage ?? "Provider authentication failed");
	const status = extractStatusFromAssistantError(message);
	if (status !== undefined) error.status = status;
	return error;
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const requestOptions = withRequestDebugFetch(options);
	const retryApiKey = requestOptions?.onAuthError
		? (requestOptions.apiKey ?? getEnvApiKey(model.provider))
		: undefined;
	if (retryApiKey) {
		const outer = new AssistantMessageEventStream();
		const onAuthError = requestOptions!.onAuthError!;
		const runAttempt = async (apiKey: string, captureAuthFailure: boolean): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const inner = streamSimple(model, context, { ...requestOptions, apiKey, onAuthError: undefined });
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						captureAuthFailure &&
						event.type === "error" &&
						isRetryableUpstreamError(
							event.error,
							extractStatusFromAssistantError(event.error),
							event.error.errorMessage,
						)
					) {
						return { error: createAssistantAuthError(event.error), bufferedEvents, terminalEvent: event };
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (
					!emittedReplayUnsafeEvent &&
					captureAuthFailure &&
					isRetryableUpstreamError(
						error,
						extractHttpStatusFromError(error),
						error instanceof Error ? error.message : undefined,
					)
				) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			const failure = await runAttempt(retryApiKey, true);
			if (!failure) return;
			let nextKey: string | undefined;
			try {
				nextKey = await onAuthError(model.provider, retryApiKey, failure.error);
			} catch {
				nextKey = undefined;
			}
			if (!nextKey || nextKey === retryApiKey) {
				emitFailure(failure);
				return;
			}
			await runAttempt(nextKey, false);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return streamPiNative(model, context, requestOptions);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.streamSimple(model, context, requestOptions);
	}

	const apiKey = requestOptions?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const providerOptions = mapOptionsForApi(model, requestOptions, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

export const OUTPUT_FALLBACK_BUFFER = 4000;

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;
	// Models with compat.supportsReasoningEffort: false reason natively but
	// reject the wire effort param. The wire-side omitReasoningEffort gate
	// (providers/xai-responses.ts:78) is the actual strip; returning
	// undefined here avoids a redundant requireSupportedEffort throw that
	// would defeat the gate and surface a confusing
	// "Compaction failed: Thinking effort high is not supported by..." to
	// the user.
	if (modelOmitsReasoningEffort(model)) return undefined;
	return requireSupportedEffort(model, reasoning);
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		providerSessionState: options?.providerSessionState,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
		fetch: options?.fetch,
	};

	switch (model.api) {
		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		default:
			throw new Error(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}
