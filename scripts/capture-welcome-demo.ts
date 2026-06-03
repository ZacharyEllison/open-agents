/**
 * Renders the TUI welcome screen to stdout (ANSI) for README capture pipelines.
 * Usage: bun scripts/capture-welcome-demo.ts > /tmp/welcome.ansi
 *        bun scripts/capture-welcome-demo.ts --animate   # ~3.5s triforce shimmer for VHS
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { WelcomeComponent } from "../packages/coding-agent/src/modes/components/welcome";
import { initTheme } from "../packages/coding-agent/src/modes/theme/theme";

const SHIMMER_TICK_MS = 125;
const SHIMMER_ANIM_MS = 3500;

const pkg = JSON.parse(
	readFileSync(path.join(import.meta.dir, "../packages/coding-agent/package.json"), "utf8"),
) as { version: string };

const animate = process.argv.includes("--animate");

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

function writeFrame(tick: number): void {
	for (const line of welcome.withShimmerTick(tick, termWidth)) {
		process.stdout.write(`${line}\n`);
	}
}

if (animate) {
	const ticks = Math.ceil(SHIMMER_ANIM_MS / SHIMMER_TICK_MS);
	for (let t = 0; t < ticks; t++) {
		if (t > 0) {
			process.stdout.write("\x1b[2J\x1b[H");
		}
		writeFrame(t);
		if (t < ticks - 1) {
			await Bun.sleep(SHIMMER_TICK_MS);
		}
	}
} else {
	writeFrame(0);
}
