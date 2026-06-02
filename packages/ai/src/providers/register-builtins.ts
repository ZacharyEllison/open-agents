/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., openai) at
 * startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * NOTE: stream.ts currently imports providers directly, so this file is not yet
 * wired into the main streaming path. It provides the infrastructure for lazy
 * loading that can be integrated when stream.ts is refactored.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

const LAZY_STREAM_IDLE_TIMEOUT_ERROR = "Provider stream stalled while waiting for the next event";
const LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "Provider stream timed out while waiting for the first event";

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * Per-provider default overrides for the lazy stream watchdogs. These widen the
 * floor used when neither caller option nor env var pins a value. The env vars
 * (`OA_STREAM_FIRST_EVENT_TIMEOUT_MS`, `OA_STREAM_IDLE_TIMEOUT_MS`) still take
 * precedence; `StreamOptions.streamFirstEventTimeoutMs` / `streamIdleTimeoutMs`
 * still trump everything.
 */
interface LazyStreamLimits {
	defaultFirstEventTimeoutMs?: number;
	defaultIdleTimeoutMs?: number;
	/**
	 * The provider implementation already wraps its upstream transport with
	 * stream timeouts. Keep the lazy loader from racing it with generic errors.
	 */
	providerHandlesStreamTimeouts?: boolean;
}
const PROVIDER_HANDLED_STREAM_TIMEOUTS: LazyStreamLimits = {
	providerHandlesStreamTimeouts: true,
};

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
	options: OptionsForApi<TApi>,
	abortTracker: AbortSourceTracker,
	limits?: LazyStreamLimits,
): void {
	(async () => {
		try {
			const providerHandlesStreamTimeouts = limits?.providerHandlesStreamTimeouts === true;
			const idleTimeoutMs = providerHandlesStreamTimeouts
				? undefined
				: (options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(limits?.defaultIdleTimeoutMs));
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs: providerHandlesStreamTimeouts
					? 0
					: (options.streamFirstEventTimeoutMs ??
						getStreamFirstEventTimeoutMs(idleTimeoutMs, limits?.defaultFirstEventTimeoutMs)),
				errorMessage: LAZY_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () => abortTracker.abortLocally(new Error(LAZY_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () => abortTracker.abortLocally(new Error(LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
				abortSignal: options.signal,
				// The synthetic `start` event is yielded immediately by every provider before
				// the upstream model has emitted any tokens. Treating it as the first "real"
				// item would flip the watchdog from `firstItemTimeoutMs` to the much shorter
				// `idleTimeoutMs` while we're still legitimately waiting on the model's
				// first response (slow first-token from reasoning models, cold proxies, etc.).
				isProgressItem: event => (event as AssistantMessageEvent).type !== "start",
			});

			for await (const event of watchedSource) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			const message = createLazyLoadErrorMessage(model, error, stopReason);
			target.push({ type: "error", reason: stopReason, error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(
	model: Model<TApi>,
	error: unknown,
	stopReason: Extract<AssistantMessage["stopReason"], "aborted" | "error"> = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage:
			stopReason === "aborted" ? "Request was aborted" : error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
	limits?: LazyStreamLimits,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();
		const streamOptions = (options ?? {}) as OptionsForApi<TApi>;

		loadModule()
			.then(module => {
				const abortTracker = createAbortSourceTracker(streamOptions.signal);
				const providerOptions = { ...streamOptions, signal: abortTracker.requestSignal } as OptionsForApi<TApi>;
				const inner = module.stream(model, context, providerOptions);
				forwardStream(outer, inner, model, streamOptions, abortTracker, limits);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	openAIResponsesProviderModulePromise ||= import("./openai-responses").then(module => {
		const provider = module as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
// ---------------------------------------------------------------------------

export const streamOpenAICompletions = createLazyStream(
	loadOpenAICompletionsProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamOpenAIResponses = createLazyStream(
	loadOpenAIResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
