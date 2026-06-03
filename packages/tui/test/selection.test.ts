import { describe, expect, it } from "bun:test";
import { Editor } from "@open-agents/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

function createEditor(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.setText(text);
	editor.focused = true;
	return editor;
}

describe("Editor selection state", () => {
	it("starts with no selection", () => {
		const editor = createEditor("hello");
		expect(editor.hasSelection()).toBe(false);
		expect(editor.getSelectedText()).toBe("");
	});

	it("shift+right creates a selection", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		expect(editor.hasSelection()).toBe(true);
		expect(editor.getSelectedText()).toBe("h");
	});

	it("multiple shift+right extends selection", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		expect(editor.getSelectedText()).toBe("hel");
	});

	it("shift+left extends selection backwards", () => {
		const editor = createEditor("hello");
		editor.moveToLineEnd();
		editor.handleInput("\x1b[1;2D"); // shift+left
		editor.handleInput("\x1b[1;2D"); // shift+left
		expect(editor.getSelectedText()).toBe("lo");
	});

	it("shift+down extends selection across lines", () => {
		const editor = createEditor("line one\nline two");
		editor.moveToMessageStart();
		editor.handleInput("\x1b[1;2B"); // shift+down
		expect(editor.hasSelection()).toBe(true);
		const selected = editor.getSelectedText();
		expect(selected).toContain("line one\n");
	});

	it("shift+up extends selection upward", () => {
		const editor = createEditor("line one\nline two");
		editor.moveToMessageEnd();
		editor.handleInput("\x1b[1;2A"); // shift+up
		expect(editor.hasSelection()).toBe(true);
		const selected = editor.getSelectedText();
		expect(selected.length).toBeGreaterThan(0);
	});

	it("plain arrow clears selection", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		expect(editor.hasSelection()).toBe(true);
		editor.handleInput("\x1b[C"); // plain right (up arrow)
		expect(editor.hasSelection()).toBe(false);
	});

	it("shift+home selects to line start", () => {
		const editor = createEditor("hello world");
		editor.moveToLineEnd();
		// Move cursor to middle
		editor.moveToLineStart();
		editor.handleInput("\x1b[C"); // right
		editor.handleInput("\x1b[C"); // right
		editor.handleInput("\x1b[C"); // right
		editor.handleInput("\x1b[C"); // right
		editor.handleInput("\x1b[C"); // right — now at col 5
		editor.handleInput("\x1b[1;2H"); // shift+home
		expect(editor.getSelectedText()).toBe("hello");
	});

	it("shift+end selects to line end", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2F"); // shift+end
		expect(editor.getSelectedText()).toBe("hello world");
	});
});

describe("Editor word selection (ctrl+shift+arrow)", () => {
	it("ctrl+shift+right selects a word", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;6C"); // ctrl+shift+right
		expect(editor.hasSelection()).toBe(true);
		const selected = editor.getSelectedText();
		expect(selected).toBe("hello");
	});

	it("ctrl+shift+left selects a word backwards", () => {
		const editor = createEditor("hello world");
		editor.moveToLineEnd();
		editor.handleInput("\x1b[1;6D"); // ctrl+shift+left
		expect(editor.hasSelection()).toBe(true);
		const selected = editor.getSelectedText();
		expect(selected).toBe("world");
	});
});

describe("Editor typing with selection", () => {
	it("typing replaces selection", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right (select 'h')
		editor.handleInput("\x1b[1;2C"); // shift+right (select 'he')
		editor.handleInput("X"); // type X
		expect(editor.hasSelection()).toBe(false);
		expect(editor.getText()).toBe("Xllo");
	});

	it("backspace deletes selection without extra char", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x7f"); // backspace
		expect(editor.getText()).toBe("llo");
		expect(editor.getCursor().col).toBe(0);
	});

	it("delete key deletes selection", () => {
		const editor = createEditor("hello");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[3~"); // delete key
		expect(editor.getText()).toBe("llo");
	});

	it("newline replaces selection", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		// Select "hello"
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[1;2C");
		editor.handleInput("\x1b[13;2~"); // shift+enter (newline)
		expect(editor.getText()).toBe("\n world");
	});
});

describe("Editor select all", () => {
	it("shift+down + shift+end from start selects all text", () => {
		const editor = createEditor("hello\nworld");
		editor.moveToMessageStart();
		// Select all from start: shift+end (to end of line 0), shift+down, shift+end
		editor.handleInput("\x1b[1;2B"); // shift+down (extends to line 1, col 0)
		editor.handleInput("\x1b[1;2F"); // shift+end (extends to end of line 1)
		expect(editor.hasSelection()).toBe(true);
		expect(editor.getSelectedText()).toBe("hello\nworld");
	});
});

describe("Editor mouse drag selection", () => {
	it("drag selects text within a single line", () => {
		const editor = createEditor("hello world");
		editor.render(40);

		editor.handleMouseDragStart(1, 1);
		editor.handleMouseDrag(1, 6);
		editor.handleMouseDragEnd(1, 6);

		expect(editor.hasSelection()).toBe(true);
		expect(editor.getSelectedText()).toBe("hello");
	});

	it("click without drag clears selection", () => {
		const editor = createEditor("hello world");
		editor.render(40);

		// First select some text
		editor.handleMouseDragStart(1, 1);
		editor.handleMouseDrag(1, 6);
		editor.handleMouseDragEnd(1, 6);
		expect(editor.hasSelection()).toBe(true);

		// Click without dragging
		editor.handleMouseDragStart(1, 3);
		editor.handleMouseDragEnd(1, 3);
		expect(editor.hasSelection()).toBe(false);
	});
});

describe("Editor copy/cut selection", () => {
	it("cutSelection removes selected text", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[1;2C");
		expect(editor.getSelectedText()).toBe("hello");
		editor.cutSelection();
		expect(editor.getText()).toBe(" world");
		expect(editor.hasSelection()).toBe(false);
	});

	it("copySelection clears selection but preserves text", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[1;2C");
		editor.copySelection();
		expect(editor.getText()).toBe("hello world");
		expect(editor.hasSelection()).toBe(false);
	});
});

describe("Editor selection rendering", () => {
	it("renders selection with inverse video codes", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[1;2C");
		const lines = editor.render(40);
		const output = lines.join("");
		// Selection should include inverse video escape
		expect(output).toContain("\x1b[7m");
	});

	it("does not render inverse video without selection", () => {
		const editor = createEditor("hello world");
		editor.moveToLineStart();
		const lines = editor.render(40);
		const output = lines.join("");
		// No inverse video for selection (cursor uses it but only on one char)
		const inverseCount = output.split("\x1b[7m").length - 1;
		expect(inverseCount).toBeLessThanOrEqual(1); // At most the cursor glyph
	});
});

describe("Editor wide character selection", () => {
	it("selects CJK characters correctly", () => {
		const editor = createEditor("你好世界");
		editor.moveToLineStart();
		editor.handleInput("\x1b[1;2C"); // shift+right
		editor.handleInput("\x1b[1;2C"); // shift+right
		expect(editor.getSelectedText()).toBe("你好");
	});
});
