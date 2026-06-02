import { describe, expect, it } from "bun:test";
import { migrateModelRolesToTiers } from "../src/config/model-tier-legacy";

describe("modelRoles → modelTiers migration", () => {
	it("maps legacy roles to tiers with priority within each tier", () => {
		const raw: Record<string, unknown> = {
			modelRoles: {
				default: "anthropic/claude-sonnet",
				plan: "anthropic/claude-opus",
				task: "openai/gpt-4o",
				slow: "openai/gpt-4o-mini",
				smol: "ollama/qwen2.5:1.5b",
			},
		};

		expect(migrateModelRolesToTiers(raw)).toBe(true);
		expect(raw.modelRoles).toBeUndefined();
		expect(raw.modelTiers).toEqual({
			interface: "anthropic/claude-sonnet",
			worker: "openai/gpt-4o",
			compactor: "ollama/qwen2.5:1.5b",
		});
	});

	it("remaps legacy keys already stored under modelTiers", () => {
		const raw: Record<string, unknown> = {
			modelTiers: {
				default: "provider/main",
				task: "provider/worker",
				smol: "provider/tiny",
			},
		};

		expect(migrateModelRolesToTiers(raw)).toBe(true);
		expect(raw.modelTiers).toEqual({
			interface: "provider/main",
			worker: "provider/worker",
			compactor: "provider/tiny",
		});
	});

	it("does not overwrite tiers the user already configured", () => {
		const raw: Record<string, unknown> = {
			modelRoles: {
				default: "anthropic/claude-sonnet",
				task: "openai/gpt-4o",
			},
			modelTiers: {
				worker: "custom/worker-model",
			},
		};

		expect(migrateModelRolesToTiers(raw)).toBe(true);
		expect(raw.modelTiers).toEqual({
			interface: "anthropic/claude-sonnet",
			worker: "custom/worker-model",
		});
	});
});
