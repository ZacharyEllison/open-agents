/**
 * Prompt-cache key resolution shared by gateway wire-format parsers.
 */
/**
 * Priority order for resolving a client-supplied prompt-cache identity. The
 * first non-empty value wins. When none are present, the gateway derives a
 * stable UUID from the request's stable parts.
 */
const CACHE_KEY_HEADERS: readonly string[] = [
	"x-prompt-cache-key",
	"session_id",
	"conversation_id",
	"x-session-id",
	"x-conversation-id",
];

function readBodyCacheKey(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const root = body as Record<string, unknown>;
	// Explicit body fields (OpenAI Responses / Chat).
	const direct = root.prompt_cache_key;
	if (typeof direct === "string" && direct.length > 0) return direct;
	// Nested `metadata` (Codex CLI / Anthropic clients that route a session
	// identifier through the metadata bag).
	const metadata = root.metadata;
	if (metadata === null || typeof metadata !== "object") return undefined;
	const meta = metadata as Record<string, unknown>;
	for (const field of ["prompt_cache_key", "session_id", "conversation_id"] as const) {
		const v = meta[field];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/**
 * Resolve a prompt-cache identity from inbound request body + headers.
 * Order of precedence (first wins):
 *   1. Body `prompt_cache_key`
 *   2. Body `metadata.{prompt_cache_key,session_id,conversation_id}`
 *   3. Header `x-prompt-cache-key`
 *   4. Header `session_id` / `conversation_id` (Codex / ChatGPT-OAuth surface)
 *   5. Header `x-session-id` / `x-conversation-id` (common informal)
 * Returns undefined when none present; the gateway then derives a stable
 * UUID from the request's stable parts.
 */
export function resolvePromptCacheKey(body: unknown, headers?: Headers): string | undefined {
	const fromBody = readBodyCacheKey(body);
	if (fromBody) return fromBody;
	if (!headers) return undefined;
	for (const name of CACHE_KEY_HEADERS) {
		const v = headers.get(name);
		if (v && v.length > 0) return v;
	}
	return undefined;
}
