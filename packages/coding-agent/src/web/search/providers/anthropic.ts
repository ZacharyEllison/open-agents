/**
 * Anthropic Web Search Provider — disabled in the local-first build.
 *
 * Claude's built-in `web_search` tool is a hosted cloud feature. The
 * local-first refactor removed all Anthropic provider infrastructure from
 * `@open-agents/ai`, so this provider reports itself unavailable and throws if
 * invoked. The provider id is retained so the search-provider registry and
 * `SearchProviderId` union remain stable.
 */
import type { AuthStorage } from "@open-agents/ai";
import type { SearchResponse } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

/** Search provider for Anthropic Claude web search (disabled). */
export class AnthropicProvider extends SearchProvider {
	readonly id = "anthropic";
	readonly label = "Anthropic";

	isAvailable(_authStorage: AuthStorage): Promise<boolean> | boolean {
		return false;
	}

	search(_params: SearchParams): Promise<SearchResponse> {
		throw new Error("Anthropic web search is unavailable in the local-first build");
	}
}
