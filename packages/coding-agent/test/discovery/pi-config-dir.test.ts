import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@open-agents/coding-agent/capability/types";
import { getConfigDirs } from "@open-agents/coding-agent/config";
import { getUserPath } from "@open-agents/coding-agent/discovery/helpers";

describe("OA_CONFIG_DIR", () => {
	const original = process.env.OA_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.OA_CONFIG_DIR;
		} else {
			process.env.OA_CONFIG_DIR = original;
		}
	});

	test("getUserPath uses OA_CONFIG_DIR for native userAgent", () => {
		process.env.OA_CONFIG_DIR = ".config/omp";
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		const result = getUserPath(ctx, "native", "commands");
		expect(result).toBe(path.join(ctx.home, ".config/omp/agent", "commands"));
	});

	test("getConfigDirs respects OA_CONFIG_DIR for user base", () => {
		process.env.OA_CONFIG_DIR = ".config/omp";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/omp", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".omp", level: "user" });
	});
});
