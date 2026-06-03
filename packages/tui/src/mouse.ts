import type { Component } from "./tui";

export interface MouseEvent {
	/** 0=left, 1=middle, 2=right; 64=scroll up, 65=scroll down (wheel) */
	button: number;
	/** 1-based terminal column */
	col: number;
	/** 1-based terminal row */
	row: number;
	type: "press" | "release" | "move";
}

export interface MouseClickable {
	handleMouseClick(terminalRow: number, terminalCol: number): void;
}

export function isMouseClickable(component: Component | null): component is Component & MouseClickable {
	return (
		component !== null &&
		"handleMouseClick" in component &&
		typeof (component as MouseClickable).handleMouseClick === "function"
	);
}

/** Parse an SGR mouse sequence (`ESC [ < button ; col ; row M|m`). */
export function parseMouseEvent(data: string): MouseEvent | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	const rawButton = parseInt(match[1]!, 10);
	const col = parseInt(match[2]!, 10);
	const row = parseInt(match[3]!, 10);
	const isRelease = match[4] === "m";

	const button = rawButton & 0x03;
	const isMotion = (rawButton & 32) !== 0;

	return {
		button: rawButton & 64 ? 64 + button : button,
		col,
		row,
		type: isRelease ? "release" : isMotion ? "move" : "press",
	};
}
