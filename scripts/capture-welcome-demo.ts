/**
 * Renders the TUI welcome screen to stdout (ANSI) for README capture pipelines.
 * Usage: bun scripts/capture-welcome-demo.ts > /tmp/welcome.ansi
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { WelcomeComponent } from "../packages/coding-agent/src/modes/components/welcome";
import { initTheme } from "../packages/coding-agent/src/modes/theme/theme";

const pkg = JSON.parse(
	readFileSync(path.join(import.meta.dir, "../packages/coding-agent/package.json"), "utf8"),
) as { version: string };

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
const lines = welcome.render(termWidth);
for (const line of lines) {
	process.stdout.write(`${line}\n`);
}
