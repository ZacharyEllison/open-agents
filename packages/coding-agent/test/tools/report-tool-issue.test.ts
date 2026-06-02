import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@open-agents/coding-agent/config/settings";
import type { ToolSession } from "@open-agents/coding-agent/tools";
import {
	__resetAutoQaDbForTests,
	createReportToolIssueTool,
	openAutoQaDb,
} from "@open-agents/coding-agent/tools/report-tool-issue";
import { hookFetch, setAgentDir } from "@open-agents/utils";

function makeSession(): ToolSession {
	// Only the members report-tool-issue touches are needed; the rest of the
	// ToolSession surface is irrelevant to local recording.
	return {
		settings: Settings.isolated({ "dev.autoqa": true }),
		getActiveModelString: () => "test-model",
	} as unknown as ToolSession;
}

describe("report_tool_issue (local-only)", () => {
	let dir: string;
	let prevAgentDir: string | undefined;

	beforeEach(async () => {
		prevAgentDir = process.env.OA_AGENT_DIR;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "autoqa-test-"));
		setAgentDir(dir);
		__resetAutoQaDbForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		__resetAutoQaDbForTests();
		if (prevAgentDir !== undefined) setAgentDir(prevAgentDir);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("records grievances to the local SQLite db", async () => {
		const tool = createReportToolIssueTool(makeSession(), ["find"]);
		const result = await tool.execute("call-1", { tool: "find", report: "weird ordering" });

		expect(result.content[0]).toMatchObject({ type: "text", text: "Noted, thanks!" });

		const db = openAutoQaDb();
		expect(db).not.toBeNull();
		const rows = db!.prepare("SELECT model, tool, report FROM grievances ORDER BY id ASC").all();
		expect(rows).toEqual([{ model: "test-model", tool: "find", report: "weird ordering" }]);
	});

	it("performs no network egress when recording", async () => {
		const fetchSpy = vi.fn(() => new Response("unexpected", { status: 200 }));
		using _hook = hookFetch(fetchSpy);

		const tool = createReportToolIssueTool(makeSession(), ["find"]);
		await tool.execute("call-1", { tool: "find", report: "no phone home" });

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("silently drops reports for tools outside the active allowlist", async () => {
		const tool = createReportToolIssueTool(makeSession(), ["find"]);
		await tool.execute("call-1", { tool: "not-a-builtin", report: "ignored" });

		const db = openAutoQaDb();
		const rows = db!.prepare("SELECT id FROM grievances").all();
		expect(rows).toEqual([]);
	});
});
