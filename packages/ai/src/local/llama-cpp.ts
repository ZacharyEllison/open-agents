import * as os from "node:os";
import { $which, logger } from "@open-agents/utils";

/**
 * Configuration for an idempotent `llama-server` (llama.cpp) lifecycle.
 *
 * When a server is already reachable at {@link LlamaCppConfig.baseUrl} it is
 * reused as-is. When it is not and {@link LlamaCppConfig.modelPath} is set,
 * a new `llama-server` process is spawned and owned by this process.
 */
export interface LlamaCppConfig {
	/** Path to the `llama-server` binary; searched in PATH if omitted. */
	executablePath?: string;
	/** Path to the `.gguf` model file; required for auto-start. */
	modelPath?: string;
	/** Base URL of the server. Default: http://127.0.0.1:8080 */
	baseUrl?: string;
	/** `-c` context size flag. Default: 4096 */
	contextSize?: number;
	/** `-t` thread count flag. Default: os.availableParallelism() */
	threads?: number;
	/** Auto-start the server when unreachable. Default: true when modelPath is set. */
	autoStart?: boolean;
}

export interface LlamaCppHandle {
	readonly baseUrl: string;
	/** Only set when this process owns (spawned) the server. */
	readonly pid?: number;
	stop(): Promise<void>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_CONTEXT_SIZE = 4096;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;

/** Idempotency cache keyed by `${executablePath}|${modelPath}|${baseUrl}`. */
const handles = new Map<string, LlamaCppHandle>();

function cacheKey(config: LlamaCppConfig, baseUrl: string): string {
	return `${config.executablePath ?? ""}|${config.modelPath ?? ""}|${baseUrl}`;
}

async function isHealthy(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal });
		return res.status === 200;
	} catch {
		return false;
	}
}

async function waitForHealth(baseUrl: string): Promise<boolean> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isHealthy(baseUrl)) return true;
		await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
	}
	return false;
}

/**
 * Ensure a `llama-server` is reachable, returning a handle. Repeated calls with
 * the same effective key return the cached handle (idempotent).
 */
export async function ensureLlamaCpp(config: LlamaCppConfig): Promise<LlamaCppHandle> {
	const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	const key = cacheKey(config, baseUrl);

	const cached = handles.get(key);
	if (cached && (await isHealthy(baseUrl))) {
		return cached;
	}

	// Already running externally — adopt it without taking ownership.
	if (await isHealthy(baseUrl)) {
		const handle: LlamaCppHandle = { baseUrl, stop: async () => {} };
		handles.set(key, handle);
		return handle;
	}

	const autoStart = config.autoStart ?? config.modelPath != null;
	if (!autoStart) {
		throw new Error(`llama.cpp server not reachable at ${baseUrl} and autoStart is disabled`);
	}
	if (!config.modelPath) {
		throw new Error("llama.cpp autoStart requires a modelPath (.gguf file)");
	}

	const executable = config.executablePath ?? $which("llama-server");
	if (!executable) {
		throw new Error("llama-server binary not found in PATH; set executablePath");
	}

	const url = new URL(baseUrl);
	const port = url.port || "8080";
	const host = url.hostname || "127.0.0.1";
	const threads = config.threads ?? os.availableParallelism();
	const contextSize = config.contextSize ?? DEFAULT_CONTEXT_SIZE;

	logger.debug("Starting llama-server", { executable, modelPath: config.modelPath, port });
	const proc = Bun.spawn(
		[
			executable,
			"-m",
			config.modelPath,
			"-c",
			String(contextSize),
			"-t",
			String(threads),
			"--host",
			host,
			"--port",
			port,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);

	const ready = await waitForHealth(baseUrl);
	if (!ready) {
		proc.kill();
		throw new Error(`llama-server failed to become healthy at ${baseUrl} within ${HEALTH_TIMEOUT_MS}ms`);
	}

	const handle: LlamaCppHandle = {
		baseUrl,
		pid: proc.pid,
		stop: async () => {
			proc.kill();
			handles.delete(key);
		},
	};
	handles.set(key, handle);
	return handle;
}
