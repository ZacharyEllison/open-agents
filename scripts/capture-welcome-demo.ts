/**
 * Renders the TUI welcome screen to stdout (ANSI) for README capture pipelines.
 * Usage: bun scripts/capture-welcome-demo.ts > /tmp/welcome.ansi
 *        bun scripts/capture-welcome-demo.ts --animate   # ~3.5s triforce shimmer for VHS
 *        bun scripts/capture-welcome-demo.ts --full-demo # ~11s welcome + interaction for VHS GIF
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { WelcomeComponent } from "../packages/coding-agent/src/modes/components/welcome";
import { initTheme, theme } from "../packages/coding-agent/src/modes/theme/theme";
import { padding, visibleWidth } from "@open-agents/tui";
import { renderStatusLine } from "../packages/coding-agent/src/tui";

const SHIMMER_TICK_MS = 125;
const SHIMMER_ANIM_MS = 3500;
const FULL_DEMO_FRAMES = 88;

const USER_CMD = "Refactor the auth module to use JWT tokens";
const NEXT_CMD = "Run the auth test suite";

const pkg = JSON.parse(
	readFileSync(path.join(import.meta.dir, "../packages/coding-agent/package.json"), "utf8"),
) as { version: string };

const animate = process.argv.includes("--animate");
const fullDemo = process.argv.includes("--full-demo");

if (animate && fullDemo) {
	process.stderr.write("error: use only one of --animate or --full-demo\n");
	process.exit(1);
}

// Deterministic tip (first line in tips.txt) for stable README assets.
const originalRandom = Math.random;
Math.random = () => 0;

process.env.COLORTERM = "truecolor";
process.env.TERM = "xterm-256color";

await initTheme("dark");

const welcome = new WelcomeComponent(
	pkg.version,
	"qwen2.5-coder:7b",
	"ollama",
	[
		{ name: "open-agents README capture", timeAgo: "just now" },
		{ name: "local model wiring", timeAgo: "2h" },
		{ name: "tier delegation smoke", timeAgo: "1d" },
	],
	[
		{ name: "typescript-language-server", status: "ready", fileTypes: ["ts", "tsx", "js"] },
		{ name: "rust-analyzer", status: "ready", fileTypes: ["rs"] },
	],
);

Math.random = originalRandom;

const termWidth = 100;

function padLineToWidth(line: string, width: number): string {
	const vis = visibleWidth(line);
	if (vis >= width) {
		return line;
	}
	return line + padding(width - vis);
}

function writeFrame(tick: number): void {
	for (const line of welcome.withShimmerTick(tick, termWidth)) {
		process.stdout.write(`${padLineToWidth(line, termWidth)}\n`);
	}
}

function buildWelcomeLines(tick: number): string[] {
	return welcome.withShimmerTick(tick, termWidth).map(line => padLineToWidth(line, termWidth));
}

function dimRule(): string {
	return theme.fg("dim", theme.boxRound.horizontal.repeat(79));
}

function promptPrefix(): string {
	return `  ${theme.fg("accent", `${theme.nav.cursor} `)}`;
}

function buildInteraction(frame: number): string[] {
	const lines: string[] = [];

	if (frame <= 24) {
		return lines;
	}

	if (frame >= 33 && frame <= 72) {
		lines.push(`  ${theme.fg("userMessageText", USER_CMD)}`);
		lines.push("");
	}

	if (frame >= 33 && frame <= 40) {
		lines.push(
			`  ${renderStatusLine(
				{
					icon: "running",
					spinnerFrame: frame - 33,
					title: "Read",
					description: "src/auth/...",
				},
				theme,
			)}`,
		);
	}

	if (frame >= 41 && frame <= 48) {
		lines.push(`  ${theme.fg("muted", "Found 3 files, searching for token usage...")}`);
	}

	if (frame >= 49 && frame <= 56) {
		lines.push(`  ${theme.fg("muted", "Delegating to worker with context...")}`);
	}

	if (frame >= 57 && frame <= 72) {
		lines.push(...buildWorkerCard(frame));
	}

	return lines;
}

function buildWorkerCard(frame: number): string[] {
	const d = theme.fg.bind(theme, "dim");
	const m = theme.fg.bind(theme, "muted");
	const branch = d(theme.tree.branch);
	const last = d(theme.tree.last);
	const vert = d(theme.tree.vertical);
	const lines: string[] = [];

	const header = `${d("┌")}${d("─")} ${theme.fg("accent", "task")}: ${theme.bold("RefactorAuth")} ${d("─".repeat(28))}`;
	lines.push(`  ${header}`);

	if (frame >= 59) {
		lines.push(`  ${branch} ${m("Editing src/auth/middleware.ts")}`);
	}
	if (frame >= 61) {
		lines.push(`  ${vert}  ${d("- import { verifySession } from './session';")}`);
		lines.push(`  ${vert}  ${theme.fg("success", "+ import { verifyJWT } from './jwt';")}`);
	}
	if (frame >= 65) {
		lines.push(`  ${branch} ${m("Editing src/auth/login.ts")}`);
	}
	if (frame >= 67) {
		lines.push(`  ${vert}  ${d("- return createSession(user);")}`);
		lines.push(`  ${vert}  ${theme.fg("success", "+ return signJWT({ sub: user.id, role: user.role });")}`);
	}
	if (frame >= 71) {
		lines.push(
			`  ${last} ${theme.fg("success", theme.status.success)} ${theme.fg("success", "Complete")} ${d("(2 files changed)")}`,
		);
	}

	return lines;
}

function buildPromptLine(frame: number): string {
	const placeholder = theme.fg("dim", "Ask anything…");
	const cursor = theme.inverse(" ");

	if (frame >= 25 && frame <= 32) {
		const typed = USER_CMD.slice(0, frame - 24);
		return `${promptPrefix()}${theme.fg("text", typed)}${cursor}`;
	}

	if (frame >= 33 && frame <= 72) {
		return `${promptPrefix()}${placeholder}`;
	}

	if (frame >= 73) {
		const typed = NEXT_CMD.slice(0, frame - 72);
		return `${promptPrefix()}${theme.fg("text", typed)}${cursor}`;
	}

	return `${promptPrefix()}${placeholder}`;
}

function buildFullDemoLines(frame: number): string[] {
	const lines = buildWelcomeLines(frame - 1);
	lines.push(padLineToWidth("", termWidth));
	lines.push(padLineToWidth(dimRule(), termWidth));
	lines.push(padLineToWidth("", termWidth));

	const interaction = buildInteraction(frame);
	for (const line of interaction) {
		lines.push(padLineToWidth(line, termWidth));
	}
	if (interaction.length > 0) {
		lines.push(padLineToWidth("", termWidth));
	}

	lines.push(padLineToWidth(buildPromptLine(frame), termWidth));
	return lines;
}

function writeLinesAtHome(lines: string[], lineCount: number, moveHome: boolean): void {
	if (moveHome) {
		process.stdout.write("\x1b[H");
	}
	for (let i = 0; i < lineCount; i++) {
		process.stdout.write(`${lines[i] ?? padLineToWidth("", termWidth)}\n`);
	}
}

if (fullDemo) {
	let maxFrameLines = 0;
	for (let frame = 1; frame <= FULL_DEMO_FRAMES; frame++) {
		maxFrameLines = Math.max(maxFrameLines, buildFullDemoLines(frame).length);
	}

	for (let frame = 1; frame <= FULL_DEMO_FRAMES; frame++) {
		const lines = buildFullDemoLines(frame);
		writeLinesAtHome(lines, maxFrameLines, frame > 1);
		if (frame < FULL_DEMO_FRAMES) {
			await Bun.sleep(SHIMMER_TICK_MS);
		}
	}
} else if (animate) {
	const ticks = Math.ceil(SHIMMER_ANIM_MS / SHIMMER_TICK_MS);
	let maxFrameLines = 0;
	const frames: string[][] = [];
	for (let t = 0; t < ticks; t++) {
		const lines = buildWelcomeLines(t);
		frames.push(lines);
		maxFrameLines = Math.max(maxFrameLines, lines.length);
	}

	for (let t = 0; t < ticks; t++) {
		writeLinesAtHome(frames[t]!, maxFrameLines, t > 0);
		if (t < ticks - 1) {
			await Bun.sleep(SHIMMER_TICK_MS);
		}
	}
} else {
	writeFrame(0);
}
