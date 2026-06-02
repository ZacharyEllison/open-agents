/**
 * Unified provider descriptors — single source of truth for provider metadata
 * used by both runtime model discovery (model-registry.ts) and catalog
 * generation (generate-models.ts).
 */
import { ensureLlamaCpp } from "../local/llama-cpp";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, KnownProvider } from "../types";
import type { OAuthProvider } from "../utils/oauth/types";
import {
	janModelManagerOptions,
	llamaCppModelManagerOptions,
	llamafileModelManagerOptions,
	lmStudioModelManagerOptions,
	localaiModelManagerOptions,
	ollamaModelManagerOptions,
	tabbyapiModelManagerOptions,
	vllmModelManagerOptions,
} from "./openai-compat";

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/** Environment variables to check for API keys during catalog generation. */
	envVars: string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: OAuthProvider;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: KnownProvider;
	createModelManagerOptions(config: { apiKey?: string; baseUrl?: string }): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** When true, successful runtime discovery replaces bundled provider models instead of merging fallback-only IDs. */
	dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

/** Config accepted by a {@link LocalServerManager}. */
export interface LocalServerConfig {
	baseUrl?: string;
	executablePath?: string;
	modelPath?: string;
	contextSize?: number;
	threads?: number;
	autoStart?: boolean;
}

/** Handle to a running local inference server. */
export interface LocalServerHandle {
	readonly baseUrl: string;
	readonly pid?: number;
	stop(): Promise<void>;
}

/** Lifecycle manager for a local inference server (e.g. llama.cpp's llama-server). */
export interface LocalServerManager {
	ensureRunning(config: LocalServerConfig): Promise<LocalServerHandle>;
	isRunning(config: LocalServerConfig): Promise<boolean>;
}

/** A provider descriptor describing a local-only inference runtime. */
export interface LocalProviderDescriptor extends ProviderDescriptor {
	readonly localProvider: true;
	readonly defaultPort: number;
	readonly defaultHost: string;
	readonly serverManager?: LocalServerManager;
}

const llamaCppServerManager: LocalServerManager = {
	ensureRunning: config => ensureLlamaCpp(config),
	isRunning: async config => {
		const baseUrl = (config.baseUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "");
		try {
			const res = await fetch(`${baseUrl}/health`);
			return res.status === 200;
		} catch {
			return false;
		}
	},
};

function localDescriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	defaultHost: string,
	defaultPort: number,
	serverManager?: LocalServerManager,
): LocalProviderDescriptor {
	return {
		providerId,
		defaultModel,
		createModelManagerOptions,
		allowUnauthenticated: true,
		localProvider: true,
		defaultHost,
		defaultPort,
		serverManager,
	};
}

/**
 * All built-in local inference runtimes. Discovery is unauthenticated and
 * optional — unreachable providers are silently skipped at runtime.
 */
export const LOCAL_PROVIDER_DESCRIPTORS: readonly LocalProviderDescriptor[] = [
	localDescriptor("ollama", "gpt-oss:20b", config => ollamaModelManagerOptions(config), "127.0.0.1", 11434),
	localDescriptor(
		"llama.cpp",
		"default",
		config => llamaCppModelManagerOptions(config),
		"127.0.0.1",
		8080,
		llamaCppServerManager,
	),
	localDescriptor("vllm", "gpt-oss-20b", config => vllmModelManagerOptions(config), "127.0.0.1", 8000),
	localDescriptor("lm-studio", "llama-3-8b", config => lmStudioModelManagerOptions(config), "127.0.0.1", 1234),
	localDescriptor("localai", "default", config => localaiModelManagerOptions(config), "127.0.0.1", 8080),
	localDescriptor("jan", "default", config => janModelManagerOptions(config), "127.0.0.1", 1337),
	localDescriptor("llamafile", "default", config => llamafileModelManagerOptions(config), "127.0.0.1", 8080),
	localDescriptor("tabbyapi", "default", config => tabbyapiModelManagerOptions(config), "127.0.0.1", 5000),
];

/** Backward-compatible alias — all providers are now local. */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = LOCAL_PROVIDER_DESCRIPTORS;

/** Default model IDs for all known (local) providers. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = {
	ollama: "gpt-oss:20b",
	"llama.cpp": "default",
	vllm: "gpt-oss-20b",
	"lm-studio": "llama-3-8b",
	localai: "default",
	jan: "default",
	llamafile: "default",
	tabbyapi: "default",
};
