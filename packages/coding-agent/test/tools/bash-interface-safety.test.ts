import { describe, expect, it } from "bun:test";
import {
	getInterfaceTierBashBlockReason,
	isInterfaceTierBashCommandAllowed,
} from "../../src/tools/bash-interface-safety";

describe("interface tier bash safety", () => {
	it("allows common read-only commands", () => {
		expect(isInterfaceTierBashCommandAllowed("git status")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("git pull origin main")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("git log -5 --oneline")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("ls -la")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("cat README.md")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("bun check")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("bun test")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("npm test")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("make")).toBe(true);
		expect(isInterfaceTierBashCommandAllowed("cd src && git status 2>&1")).toBe(true);
	});

	it("blocks destructive or mutating commands", () => {
		expect(isInterfaceTierBashCommandAllowed("rm -rf node_modules")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("npm install")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("bun add lodash")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("git commit -m x")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("git push")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("git reset --hard HEAD~1")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("echo hi > out.txt")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("sed -i 's/a/b/' file.ts")).toBe(false);
	});

	it("requires every pipeline segment to be allowed", () => {
		expect(isInterfaceTierBashCommandAllowed("git status && rm x")).toBe(false);
		expect(isInterfaceTierBashCommandAllowed("git status | head")).toBe(true);
	});

	it("returns a delegation hint when blocked", () => {
		const reason = getInterfaceTierBashBlockReason("rm x");
		expect(reason).toContain("Interface tier");
		expect(reason).toContain("task");
	});
});
