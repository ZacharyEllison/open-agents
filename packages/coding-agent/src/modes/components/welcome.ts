import {
	type Component,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@open-agents/tui";
import { APP_NAME } from "@open-agents/utils";
import { theme } from "../../modes/theme/theme";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

export function renderWelcomeTip(tip: string, boxWidth: number): string[] {
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const wrappedBody = wrapTextWithAnsi(replaceTabs(tip), bodyBudget);
	if (wrappedBody.length === 0) return [];

	const encoding = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
	const purple = Bun.color("#b48cff", encoding) ?? "";
	const lightBlue = Bun.color("#9ccfff", encoding) ?? "";
	const italic = "\x1b[3m";
	const dim = "\x1b[2m";
	const reset = "\x1b[0m";
	const continuationIndent = padding(labelWidth);

	return wrappedBody.map((body, index) =>
		index === 0
			? ` ${italic}${purple}${label}${dim}${lightBlue}${body}${reset}`
			: ` ${italic}${continuationIndent}${dim}${lightBlue}${body}${reset}`,
	);
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

/**
 * Premium welcome screen with animated triforce logo and two-column layout.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: ReturnType<typeof setInterval> | null = null;
	#shimmerTimer: ReturnType<typeof setInterval> | null = null;
	#shimmerTick = 0;
	/** Tip chosen once per instance so re-renders (intro, LSP updates) don't shuffle it. */
	readonly #tip: string | undefined = TIPS.length > 0 ? TIPS[Math.floor(Math.random() * TIPS.length)] : undefined;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
	) {}

	invalidate(): void {}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		this.#animStart = performance.now();
		this.#ensureShimmer(requestRender);
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
	}

	/** Continuous triforce shimmer (~8 fps). */
	#ensureShimmer(requestRender: () => void): void {
		if (this.#shimmerTimer != null) return;
		this.#shimmerTimer = setInterval(() => {
			this.#shimmerTick++;
			requestRender();
		}, SHIMMER_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
	}

	dispose(): void {
		if (this.#shimmerTimer != null) {
			clearInterval(this.#shimmerTimer);
			this.#shimmerTimer = null;
		}
		this.#stopAnimation();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	/** Render one frame with a fixed shimmer tick (README/VHS capture; no timer). */
	withShimmerTick(tick: number, termWidth: number): string[] {
		const prev = this.#shimmerTick;
		this.#shimmerTick = tick;
		try {
			return this.render(termWidth);
		} finally {
			this.#shimmerTick = prev;
		}
	}

	render(termWidth: number): string[] {
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 26;
		const minLeftCol = 12; // logo width
		const minRightCol = 20;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome back!"),
			visibleWidth(this.modelName),
			visibleWidth(this.providerName),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Logo: pick a frame from the intro animation if active, else the resting frame.
		// Pad all logo lines to the widest visible width so #centerText shifts them uniformly
		// (the art uses internal leading spaces for alignment; per-line centering would skew it).
		const logoColored = this.#currentLogoFrame();
		const logoMaxW = Math.max(...logoColored.map(l => visibleWidth(l)));
		const logoPadded = logoColored.map(l => l + padding(logoMaxW - visibleWidth(l)));

		// Left column - centered content
		const leftLines = [
			"",
			this.#centerText(theme.bold("Welcome back!"), leftCol),
			"",
			...logoPadded.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", this.modelName), leftCol),
			this.#centerText(theme.fg("borderMuted", this.providerName), leftCol),
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, 3)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.success", "success")
						: server.status === "connecting"
							? theme.styledSymbol("status.pending", "muted")
							: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Tips"))}`,
			` ${theme.fg("dim", "?")}${theme.fg("muted", " for keyboard shortcuts")}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " to run python")}`,
			separator,
			` ${theme.bold(theme.fg("accent", "LSP Servers"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		// Randomly picked tip, rendered directly beneath the box.
		lines.push(...this.#renderTip(boxWidth));

		return lines;
	}

	/**
	 * Render the per-instance tip line: a purple "Tip:" label followed by the
	 * tip body in dimmed light blue, the whole line italicized. Returns `[]`
	 * when no tip is available or the box is too narrow to be useful.
	 */
	#renderTip(boxWidth: number): string[] {
		if (!this.#tip) return [];
		return renderWelcomeTip(this.#tip, boxWidth);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}

	/** Pick the logo frame for the current shimmer tick (intro adds a brief boost). */
	#currentLogoFrame(): readonly string[] {
		let phase = (this.#shimmerTick * SHIMMER_PHASE_STEP) % 1;
		if (this.#animStart != null) {
			const elapsed = performance.now() - this.#animStart;
			if (elapsed < INTRO_MS) {
				const progress = elapsed / INTRO_MS;
				phase = (phase + (1 - progress) * 0.35) % 1;
			}
		}
		return renderTriforceLogo(phase);
	}
}

/** Filled triforce (three solid block triangles around the inverted center gap) for the welcome screen and setup splash. */
export const TRIFORCE_ART = [
	"          ████",
	"        ████████",
	"      ████████████",
	"    ████        ████",
	"  ████████    ████████",
	"████████████████████████",
] as const;

/** @deprecated Use {@link TRIFORCE_ART}. Kept for setup splash imports during transition. */
export const PI_LOGO = [...TRIFORCE_ART];

const GOLD_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[120, 85, 20],
	[180, 130, 30],
	[220, 175, 45],
	[255, 215, 80],
];
const GOLD_RAMP_256 = [136, 178, 214, 220, 227];

function goldEscape(t: number): string {
	if (TERMINAL.trueColor) {
		const stops = GOLD_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		const r = a[0] + (b[0] - a[0]) * f;
		const g = a[1] + (b[1] - a[1]) * f;
		const bl = a[2] + (b[2] - a[2]) * f;
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const idx = Math.min(GOLD_RAMP_256.length - 1, Math.max(0, Math.floor(t * (GOLD_RAMP_256.length - 1) + 0.5)));
	return `\x1b[38;5;${GOLD_RAMP_256[idx]}m`;
}

/** Width of the widest row; the inverted center gap and the bottom-triangle split align to its midpoint. */
const TRIFORCE_WIDTH = Math.max(...TRIFORCE_ART.map(l => l.length));
/** Rows 0..TOP_ROWS-1 form the top triangle; rows TOP_ROWS+ split left/right at the midpoint. */
const TRIFORCE_TOP_ROWS = 3;

/** Which of the three triforce triangles owns a glyph at (row, col). */
function triforceTriangleIndex(row: number, col: number): number {
	if (row < TRIFORCE_TOP_ROWS) return 0;
	return col < TRIFORCE_WIDTH / 2 ? 1 : 2;
}

/**
 * Render the triforce with a gentle golden shimmer. The triangle edge glyphs stay
 * intact; only their gold tint animates, as a bright glint that sweeps diagonally
 * across each triangle on an independent phase offset.
 */
export function renderTriforceLogo(phase: number): string[] {
	const reset = "\x1b[0m";
	const rows = TRIFORCE_ART.length;
	const span = TRIFORCE_WIDTH + rows;
	return TRIFORCE_ART.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			const tri = triforceTriangleIndex(y, x);
			const sweep = (phase + tri / 3 + (x + y) / span) % 1;
			const glint = 0.5 + 0.5 * Math.sin(sweep * Math.PI * 2);
			result += goldEscape(glint) + char + reset;
		}
		return result;
	});
}

/** Multi-stop palette for the diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[255, 92, 200], // hot pink
	[200, 110, 255], // violet
	[120, 130, 255], // periwinkle
	[60, 200, 255], // bright cyan
	[120, 255, 220], // mint
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [199, 171, 135, 99, 75, 51, 87];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (TERMINAL.trueColor) {
		// 5-stop palette widens the visible color range and avoids the
		// deep-blue valley a naive HSL lerp falls into.
		const stops = GRADIENT_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		let r = a[0] + (b[0] - a[0]) * f;
		let g = a[1] + (b[1] - a[1]) * f;
		let bl = a[2] + (b[2] - a[2]) * f;
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const ramp = GRADIENT_RAMP_256;
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	// span+1 so `base` stays strictly < 1: avoids the wrap-around at the
	// far corner mapping back to t=0 (hot pink) on the resting frame.
	const span = Math.max(1, cols + rows - 1);
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
			const base = (x + (rows - 1 - y)) / span;
			const t = (((base + phase) % 1) + 1) % 1;
			result += gradientEscape(t, shine) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Shimmer cadence (~8 fps). */
const SHIMMER_TICK_MS = 125;
/** Phase advance per shimmer tick. */
const SHIMMER_PHASE_STEP = 0.08;
