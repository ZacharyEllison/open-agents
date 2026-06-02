/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled by default; gated behind PI_AUTO_QA=1 / `dev.autoqa` so a user
 * who flips the setting off short-circuits injection entirely.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database; never throws.
 *
 * This is a LOCAL-ONLY feature: grievances live in the user's own SQLite at
 * `~/.omp/agent/autoqa.db` and never leave the machine. There is no upload,
 * no consent prompt, and no network egress. Inspect or wipe them via
 * `omp grievances`.
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentTool } from "@open-agents/agent";
import { $flag, getAgentDir, logger, VERSION } from "@open-agents/utils";
import * as z from "zod/v4";
import type { Settings } from "..";
import type { ToolSession } from "./index";

function buildReportToolIssueParams(activeBuiltinNames: readonly string[]) {
	// Enum gives the model a tight schema; the runtime check in `execute` is the
	// source of truth (handles models that ignore the enum and the empty-list
	// fallback used by call sites that don't know the active set yet).
	const toolSchema = activeBuiltinNames.length > 0 ? z.enum(activeBuiltinNames as [string, ...string[]]) : z.string();
	return z.object({
		tool: toolSchema.describe("tool name"),
		report: z
			.string()
			.describe("unexpected behavior; generic, NEVER PII (paths, file contents, identifiers, prompt text)"),
	});
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA") || !!settings?.get("dev.autoqa");
}

export function getAutoQaDbPath(): string {
	return path.join(getAgentDir(), "autoqa.db");
}

let cachedDb: Database | null = null;

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.omp/agent/autoqa.db`. Idempotently runs schema creation so every
 * consumer — tool execute path, the `omp grievances` CLI — sees the same
 * prepared schema. Returns `null` only on a hard open failure (filesystem
 * permissions, etc.); a missing file is created.
 *
 * Exported because the `omp grievances` CLI handlers need the handle too.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const db = new Database(getAutoQaDbPath());
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL
			);
		`);
		cachedDb = db;
		return db;
	} catch {
		return null;
	}
}

/** Test-only: close and clear the cached db handle. Never call from production code. */
export function __resetAutoQaDbForTests(): void {
	try {
		cachedDb?.close();
	} catch {}
	cachedDb = null;
}

export function createReportToolIssueTool(session: ToolSession, activeBuiltinNames: readonly string[] = []): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";
	// Snapshotted at construction time. The model's enum is built from the same
	// snapshot; mid-session drift (extensions registering later, etc.) is caught
	// by the silent-drop guard below.
	const allowedToolNames = new Set(activeBuiltinNames);

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		strict: false,
		approval: "write",
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: buildReportToolIssueParams(activeBuiltinNames),
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			// The row lives in the user's own SQLite at ~/.omp/agent/autoqa.db
			// and is never shipped anywhere — they own their local data and can
			// inspect or wipe it via `omp grievances`.
			try {
				const params = rawParams as { tool: string; report: string };
				// Some models emit `proxy_<name>` for tools routed through a
				// passthrough wrapper. Strip the prefix before allowlist check so
				// `proxy_read` lands as a report against `read`, not a silent drop.
				const canonicalTool = params.tool.startsWith("proxy_") ? params.tool.slice("proxy_".length) : params.tool;
				// Silently drop reports targeting tools that aren't shipped built-ins
				// (MCP servers, extensions that overrode a built-in name, typos).
				// Not the model's fault — no error, no DB row, just acknowledge.
				// Empty allowlist means the factory was called without a known active
				// set, so behave as before and record everything.
				if (allowedToolNames.size > 0 && !allowedToolNames.has(canonicalTool)) {
					return { content: [{ type: "text", text: "Noted, thanks!" }] };
				}
				const db = openAutoQaDb();
				if (db) {
					db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
						getModel(),
						VERSION,
						canonicalTool,
						params.report,
					);
				}
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
			};
		},
	};
}
