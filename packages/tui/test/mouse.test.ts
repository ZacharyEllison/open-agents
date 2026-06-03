import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@open-agents/tui";
import { Editor } from "@open-agents/tui/components/editor";
import { parseMouseEvent } from "@open-agents/tui/mouse";
import { visibleWidth } from "@open-agents/tui/utils";
import { defaultEditorTheme } from "./test-themes";

describe("parseMouseEvent", () => {
	it("parses left-button press", () => {
		expect(parseMouseEvent("\x1b[<0;12;5M")).toEqual({
			button: 0,
			col: 12,
			row: 5,
			type: "press",
		});
	});

	it("parses left-button release", () => {
		expect(parseMouseEvent("\x1b[<0;12;5m")).toEqual({
			button: 0,
			col: 12,
			row: 5,
			type: "release",
		});
	});

	it("parses motion with button held", () => {
		expect(parseMouseEvent("\x1b[<35;20;5M")).toEqual({
			button: 3,
			col: 20,
			row: 5,
			type: "move",
		});
	});

	it("parses scroll wheel up", () => {
		expect(parseMouseEvent("\x1b[<64;10;8M")).toEqual({
			button: 64,
			col: 10,
			row: 8,
			type: "press",
		});
	});

	it("parses scroll wheel down", () => {
		expect(parseMouseEvent("\x1b[<65;10;8M")).toEqual({
			button: 65,
			col: 10,
			row: 8,
			type: "press",
		});
	});

	it("returns null for non-mouse input", () => {
		expect(parseMouseEvent("a")).toBeNull();
		expect(parseMouseEvent("\x1b[A")).toBeNull();
	});
});

describe("Editor handleMouseClick", () => {
	it("moves cursor to the clicked grapheme on a single line", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setText("hello world");
		editor.focused = true;

		const width = 40;
		const lines = editor.render(width);
		const contentLine = lines[0] ?? "";
		const targetCol = 1 + visibleWidth("hello "); // 1-based, after "hello "
		expect(contentLine.indexOf(CURSOR_MARKER)).toBeGreaterThanOrEqual(0);

		editor.handleMouseClick(1, targetCol);
		const pos = editor.getCursor();
		expect(pos.line).toBe(0);
		expect(pos.col).toBe("hello ".length);
	});

	it("moves cursor on a wrapped line using visual row index", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderVisible(false);
		editor.setText("one two three four five");
		editor.focused = true;

		const width = 8;
		const lines = editor.render(width);
		expect(lines.length).toBeGreaterThan(1);

		const clickCol = 1 + visibleWidth("thr");
		editor.handleMouseClick(2, clickCol);

		const pos = editor.getCursor();
		expect(pos.col).toBe("one two ".length + "thr".length);
	});
});
