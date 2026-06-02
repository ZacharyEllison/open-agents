import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME, migrateLegacyConfigDirIfNeeded } from "../src/dirs";

describe("migrateLegacyConfigDirIfNeeded", () => {
	let tempHome: string;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "oa-config-migrate-"));
		originalConfigDir = process.env.OA_CONFIG_DIR;
		delete process.env.OA_CONFIG_DIR;
	});

	afterEach(() => {
		fs.rmSync(tempHome, { recursive: true, force: true });
		if (originalConfigDir === undefined) {
			delete process.env.OA_CONFIG_DIR;
		} else {
			process.env.OA_CONFIG_DIR = originalConfigDir;
		}
	});

	it("renames ~/.omp to ~/.open-agent when only the legacy directory exists", () => {
		const legacyRoot = path.join(tempHome, LEGACY_CONFIG_DIR_NAME);
		const newRoot = path.join(tempHome, CONFIG_DIR_NAME);
		fs.mkdirSync(path.join(legacyRoot, "agent"), { recursive: true });
		fs.writeFileSync(path.join(legacyRoot, "stats.db"), "stats");

		expect(migrateLegacyConfigDirIfNeeded(tempHome)).toBe(true);
		expect(fs.existsSync(legacyRoot)).toBe(false);
		expect(fs.existsSync(newRoot)).toBe(true);
		expect(fs.readFileSync(path.join(newRoot, "stats.db"), "utf-8")).toBe("stats");
	});

	it("is a no-op when the new directory already exists", () => {
		const legacyRoot = path.join(tempHome, LEGACY_CONFIG_DIR_NAME);
		const newRoot = path.join(tempHome, CONFIG_DIR_NAME);
		fs.mkdirSync(legacyRoot, { recursive: true });
		fs.mkdirSync(newRoot, { recursive: true });

		expect(migrateLegacyConfigDirIfNeeded(tempHome)).toBe(false);
		expect(fs.existsSync(legacyRoot)).toBe(true);
		expect(fs.existsSync(newRoot)).toBe(true);
	});

	it("is a no-op when OA_CONFIG_DIR is set", () => {
		process.env.OA_CONFIG_DIR = ".custom-agent-config";
		const legacyRoot = path.join(tempHome, LEGACY_CONFIG_DIR_NAME);
		fs.mkdirSync(legacyRoot, { recursive: true });

		expect(migrateLegacyConfigDirIfNeeded(tempHome)).toBe(false);
		expect(fs.existsSync(legacyRoot)).toBe(true);
	});
});
