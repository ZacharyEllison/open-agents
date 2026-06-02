import type { AuthCredential, AuthCredentialStore, StoredAuthCredential } from "./auth-storage";

/**
 * No-op credential store for keyless local builds.
 * Credentials are never persisted; env-var API keys are resolved by {@link AuthStorage}.
 */
export class NullAuthCredentialStore implements AuthCredentialStore {
	close(): void {}

	listAuthCredentials(_provider?: string): StoredAuthCredential[] {
		return [];
	}

	updateAuthCredential(_id: number, _credential: AuthCredential): void {}

	deleteAuthCredential(_id: number, _disabledCause: string): void {}

	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		return false;
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		return [];
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		return [];
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {}

	getCache(_key: string, _options?: { includeExpired?: boolean }): string | null {
		return null;
	}

	setCache(_key: string, _value: string, _expiresAtSec: number): void {}

	cleanExpiredCache(): void {}
}
