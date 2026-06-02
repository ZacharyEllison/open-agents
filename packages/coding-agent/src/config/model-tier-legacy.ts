/** Canonical tier ids (kept local so migration does not import the agent runtime). */
const MODEL_TIER_IDS = ["interface", "worker", "compactor"] as const;
type ModelTier = (typeof MODEL_TIER_IDS)[number];

/** Legacy `modelRoles` keys mapped to the 3-tier `modelTiers` schema. */
export const LEGACY_MODEL_ROLE_TO_TIER: Record<string, ModelTier> = {
	default: "interface",
	plan: "interface",
	designer: "interface",
	task: "worker",
	slow: "worker",
	vision: "worker",
	commit: "worker",
	smol: "compactor",
};

/**
 * When several legacy roles collapse to one tier, use the first role in this list
 * that has a non-empty value in the user's `modelRoles` record.
 */
export const MODEL_TIER_MIGRATION_ROLE_PRIORITY: Record<ModelTier, readonly string[]> = {
	interface: ["default", "plan", "designer"],
	worker: ["task", "slow", "vision", "commit"],
	compactor: ["smol"],
};

function shallowStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.trim()) {
			result[key] = item.trim();
		}
	}
	return result;
}

/**
 * Migrate `modelRoles` → `modelTiers` and rename legacy role keys already stored
 * under `modelTiers`. Returns true when `raw` was mutated.
 */
export function migrateModelRolesToTiers(raw: Record<string, unknown>): boolean {
	let changed = false;

	if ("modelRoles" in raw) {
		const roles = shallowStringRecord(raw.modelRoles);
		const tiers = shallowStringRecord(raw.modelTiers);

		for (const tier of MODEL_TIER_IDS) {
			if (tiers[tier]) continue;
			for (const role of MODEL_TIER_MIGRATION_ROLE_PRIORITY[tier]) {
				const value = roles[role];
				if (value) {
					tiers[tier] = value;
					changed = true;
					break;
				}
			}
		}

		for (const [key, value] of Object.entries(tiers)) {
			const mappedTier = LEGACY_MODEL_ROLE_TO_TIER[key];
			if (mappedTier && !tiers[mappedTier]) {
				tiers[mappedTier] = value;
				delete tiers[key];
				changed = true;
			}
		}

		raw.modelTiers = tiers;
		delete raw.modelRoles;
		changed = true;
	} else if (raw.modelTiers && typeof raw.modelTiers === "object" && !Array.isArray(raw.modelTiers)) {
		const tiers = shallowStringRecord(raw.modelTiers);
		let remapped = false;
		for (const [key, value] of Object.entries(tiers)) {
			const mappedTier = LEGACY_MODEL_ROLE_TO_TIER[key];
			if (mappedTier && mappedTier !== key && !tiers[mappedTier]) {
				tiers[mappedTier] = value;
				delete tiers[key];
				remapped = true;
			}
		}
		if (remapped) {
			raw.modelTiers = tiers;
			changed = true;
		}
	}

	return changed;
}
