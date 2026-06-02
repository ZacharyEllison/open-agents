#!/usr/bin/env bun

/**
 * Local-first model catalog generation.
 *
 * After the local-first refactor, every built-in provider is a local
 * inference runtime (ollama, llama.cpp, vllm, lm-studio, localai, jan,
 * llamafile, tabbyapi). These providers expose their models dynamically at
 * runtime via `/v1/models` (see `fetchDynamicModels` in each provider's
 * model-manager options), so there is no remote catalog to pre-generate.
 *
 * `models.json` is therefore intentionally minimal. This script validates the
 * local descriptor shape and rewrites `models.json` as an empty catalog; the
 * runtime discovery path is the single source of truth for available models.
 */

import * as path from "node:path";
import { LOCAL_PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";

const packageRoot = path.join(import.meta.dir, "..");
const outputPath = path.join(packageRoot, "src", "models.json");

function main(): void {
	for (const descriptor of LOCAL_PROVIDER_DESCRIPTORS) {
		if (typeof descriptor.providerId !== "string" || typeof descriptor.createModelManagerOptions !== "function") {
			throw new Error(`Invalid local provider descriptor: ${String(descriptor.providerId)}`);
		}
	}

	const catalog: { models: Record<string, never> } = { models: {} };
	Bun.write(outputPath, `${JSON.stringify(catalog, null, "\t")}\n`);
	// eslint-disable-next-line no-console
	console.log(
		`Validated ${LOCAL_PROVIDER_DESCRIPTORS.length} local providers. ` +
			`models.json written as an empty catalog (runtime discovery is authoritative).`,
	);
}

main();
