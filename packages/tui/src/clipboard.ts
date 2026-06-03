import * as os from "node:os";

/**
 * Write text to the system clipboard using OSC 52 (preferred) with a native fallback.
 * OSC 52 works in iTerm2, Kitty, Alacritty, WezTerm, tmux (set-clipboard on), etc.
 */
export function writeToClipboard(text: string): void {
	// OSC 52: set clipboard via terminal escape sequence
	const encoded = Buffer.from(text).toString("base64");
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);

	// Also attempt native clipboard as fallback (fire-and-forget, non-blocking)
	writeToNativeClipboard(text);
}

function writeToNativeClipboard(text: string): void {
	const platform = os.platform();
	try {
		if (platform === "darwin") {
			const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
			proc.stdin.write(text);
			proc.stdin.end();
		} else if (platform === "linux") {
			// Try xclip first, fall back to xsel
			const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe", stderr: "ignore" });
			proc.stdin.write(text);
			proc.stdin.end();
		}
		// Windows: clip.exe could be used but isn't a target platform
	} catch {
		// Silently ignore clipboard failures — OSC 52 is the primary mechanism
	}
}
