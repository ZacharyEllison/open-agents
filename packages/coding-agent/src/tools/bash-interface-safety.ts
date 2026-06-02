/**
 * Bash command policy for the interface tier (taskDepth === 0).
 *
 * The worker tier runs commands without these checks; the interface may only
 * run read-only / non-destructive shell commands for context gathering.
 */

/** Patterns that always block interface-tier bash, even inside larger pipelines. */
const INTERFACE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\s>>/,
	/(?<![&\d])>(?!>)/,
	/\b[12]>\s*(?![&|])/,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall|wheel)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bbun\s+(add|remove|install|update|publish|link|unlink)\b/i,
	/\bsed\b/i,
	/\bawk\b[^|;\n]*\s+-i\b/i,
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|clean|cherry-pick|revert|stash|init|clone|worktree|am|apply|format-patch)\b/i,
	/\bgit\s+push\b[^|;\n]*--force\b/i,
	/\bgit\s+reset\b[^|;\n]*--hard\b/i,
];

/** Leading command shapes allowed for interface-tier segments (after destructive scan). */
const INTERFACE_SAFE_COMMAND_PATTERNS: readonly RegExp[] = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*true\b/,
	/^\s*false\b/,
	/^\s*test\b/,
	/^\s*\[/,
	/^\s*git\s+(status|log|diff|show|branch|remote|fetch|pull|ls-|rev-parse|describe|blame|grep|config\s+--get|stash\s+list|tag\s+-l)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|test|run\s+test)\b/i,
	/^\s*yarn\s+(list|info|why|audit|test)\b/i,
	/^\s*pnpm\s+(list|why|outdated|audit)\b/i,
	/^\s*bun\s+(test|check|pm\s+ls|pm\s+list|run\s+test)\b/i,
	/^\s*bun\s+pm\b/i,
	/^\s*make\b/,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*python3\s+--version/i,
	/^\s*pip\s+(list|show|freeze)\b/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

const INTERFACE_TIER_DENIED_MESSAGE =
	"Interface tier: bash command blocked (read-only). Delegate file edits and destructive operations via the `task` tool.";

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === "&" && command[i + 1] === "&") {
				const trimmed = current.trim();
				if (trimmed) segments.push(trimmed);
				current = "";
				i += 1;
				continue;
			}
			if (ch === ";" || ch === "|") {
				const trimmed = current.trim();
				if (trimmed) segments.push(trimmed);
				current = "";
				if (ch === "|" && command[i + 1] === "|") {
					i += 1;
				}
				continue;
			}
		}
		current += ch;
	}

	const tail = current.trim();
	if (tail) segments.push(tail);
	return segments;
}

function stripEnvAssignments(segment: string): string {
	let rest = segment.trim();
	for (;;) {
		const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\s]+)\s+/);
		if (!match) break;
		rest = rest.slice(match[0].length);
	}
	return rest.trim();
}

function isInterfaceSegmentAllowed(segment: string): boolean {
	const normalized = stripEnvAssignments(segment);
	if (!normalized) return false;
	if (INTERFACE_DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(normalized))) {
		return false;
	}
	return INTERFACE_SAFE_COMMAND_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isInterfaceTierBashCommandAllowed(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	const segments = splitShellSegments(trimmed);
	if (segments.length === 0) return false;
	return segments.every(isInterfaceSegmentAllowed);
}

export function getInterfaceTierBashDenialMessage(command: string): string {
	return `${INTERFACE_TIER_DENIED_MESSAGE}\n\nCommand: ${command}`;
}

/** Throws via caller — returns message when blocked. */
export function getInterfaceTierBashBlockReason(command: string): string | undefined {
	if (isInterfaceTierBashCommandAllowed(command)) return undefined;
	return getInterfaceTierBashDenialMessage(command);
}
