import type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/** Register a custom OAuth provider (extensions). Login is unavailable in keyless builds. */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

export async function refreshOAuthToken(
	provider: OAuthProvider,
	_credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	throw new Error(`OAuth refresh is not available in this keyless build (${provider})`);
}

export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const creds = credentials[provider];
	if (!creds) {
		return null;
	}
	if (Date.now() >= creds.expires) {
		throw new Error(
			`OAuth credential for ${provider} is expired and must be refreshed via AuthStorage before getOAuthApiKey is called`,
		);
	}
	const needsStructuredApiKey =
		provider === "github-copilot" || provider === "google-gemini-cli" || provider === "google-antigravity";
	const apiKey = needsStructuredApiKey
		? JSON.stringify({
				token: creds.access,
				enterpriseUrl: creds.enterpriseUrl,
				projectId: creds.projectId,
				refreshToken: creds.refresh,
				expiresAt: creds.expires,
				email: creds.email,
				accountId: creds.accountId,
			})
		: creds.access;
	return { newCredentials: creds, apiKey };
}

/** Built-in OAuth login providers are not available in keyless builds. */
export function getOAuthProviders(): OAuthProviderInfo[] {
	return Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: false,
	}));
}

export type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";
