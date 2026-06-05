/**
 * Single enforcement point for "first-turn memory recall appears exactly once".
 *
 * A recall snippet has two delivery paths that historically raced:
 *   1. The backend's `beforeAgentStartPrompt` returns it as a trailing block at
 *      agent start (immediate first-turn delivery before any rebuild).
 *   2. The backend's developer-instructions fold `lastRecallSnippet` into the
 *      base prompt on the next `refreshBaseSystemPrompt` (its long-term home).
 *
 * When a concurrent `refreshBaseSystemPrompt` (mental-model load, tool
 * activation, TTL reload) fires during the first turn, both paths can land the
 * same snippet — once inside the base block and once as the trailing block —
 * doubling the recall in context. `mergeRecallBlock` collapses that: it only
 * appends the trailing block when the base prompt does not already carry the
 * snippet, so recall is present exactly once regardless of which path won.
 */
export function mergeRecallBlock(baseSystemPrompt: readonly string[], injected: string | undefined): string[] {
	if (!injected) return [...baseSystemPrompt];
	const trimmed = injected.trim();
	if (trimmed.length > 0 && baseSystemPrompt.some(block => block.includes(trimmed))) {
		return [...baseSystemPrompt];
	}
	return [...baseSystemPrompt, injected];
}
