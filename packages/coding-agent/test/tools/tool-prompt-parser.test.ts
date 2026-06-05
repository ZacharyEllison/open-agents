/**
 * Contract for `parseToolPrompt`, the Phase 4a groundwork that sections the
 * tool prompt `.md` docs so a later slim-wire profile can pull a short summary +
 * one example while deferring the verbose prose.
 *
 * The load-bearing guarantees this defends:
 *  - Sectioning is lossless: concatenating the structural sections (and the
 *    `"all"` accessor) reproduces the source byte-for-byte, so no behavioral
 *    rule (bash coreutils ban, read selector grammar) can silently drop.
 *  - The summary/example markers are handlebars comments that never reach the
 *    wire — rendering the marked source matches rendering the marker-free source.
 *  - Representative docs expose a non-empty summary and primaryExample.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { prompt } from "@open-agents/utils";
import bashDoc from "../../src/prompts/tools/bash.md" with { type: "text" };
import findDoc from "../../src/prompts/tools/find.md" with { type: "text" };
import readDoc from "../../src/prompts/tools/read.md" with { type: "text" };
import { parseToolPrompt } from "../../src/tools/tool-prompt-parser";

const TOOLS_DIR = path.join(import.meta.dir, "../../src/prompts/tools");

describe("parseToolPrompt section extraction", () => {
	it("extracts a non-empty summary and primaryExample for read/bash/find", () => {
		for (const doc of [readDoc, bashDoc, findDoc]) {
			const parsed = parseToolPrompt(doc);
			expect(parsed.summary.length).toBeGreaterThan(0);
			expect(parsed.primaryExample).not.toBeNull();
			expect((parsed.primaryExample ?? "").length).toBeGreaterThan(0);
		}
	});

	it("takes the first paragraph as the summary, not the whole preamble", () => {
		const read = parseToolPrompt(readDoc);
		expect(read.summary).toBe(
			"Read files, directories, archives, SQLite databases, images, documents, internal resources, and web URLs through a single `path` string.",
		);
		// Summary stops at the first blank line — it must not absorb later prose.
		expect(read.summary).not.toContain("<instruction>");
		expect(read.summary).not.toContain("Selectors");
	});

	it("pulls the examples block + first entry for a doc that has <examples>", () => {
		const find = parseToolPrompt(findDoc);
		expect(find.examples).not.toBeNull();
		expect(find.examples ?? "").toContain(`{"paths": ["src/**/*.ts"]}`);
		// primaryExample is the first labelled entry, not the entire block.
		expect(find.primaryExample).toContain("# Find files");
		expect(find.primaryExample).toContain(`{"paths": ["src/**/*.ts"]}`);
		expect(find.primaryExample).not.toContain("Multiple targets");
	});

	it("surfaces parameter docs via ## Parameters", () => {
		const read = parseToolPrompt(readDoc);
		expect(read.parameters).not.toBeNull();
		expect(read.parameters ?? "").toContain("`path`");
		expect(read.getSection("parameters")).toBe(read.parameters ?? "");
	});

	it("uses an explicit @example marker when there is no <examples> block", () => {
		const bash = parseToolPrompt(bashDoc);
		expect(bash.examples).toBeNull();
		// The marker sits before the `env:` instruction line in bash.md.
		expect(bash.primaryExample).toContain(`env: { NAME: "…" }`);

		const read = parseToolPrompt(readDoc);
		expect(read.examples).toBeNull();
		expect(read.primaryExample).toContain(":5-16,960-973");
	});
});

describe("parseToolPrompt losslessness", () => {
	it("reassembles sections back into the verbatim source for every tool doc", async () => {
		const files = (await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: TOOLS_DIR }))).sort();
		expect(files.length).toBe(37);
		for (const file of files) {
			const source = await Bun.file(path.join(TOOLS_DIR, file)).text();
			const parsed = parseToolPrompt(source);
			expect(parsed.sections.map(section => section.raw).join("")).toBe(source);
			expect(parsed.getSection("all")).toBe(source);
		}
	});

	it("preserves the behavioral rules that live in prose", () => {
		const bash = parseToolPrompt(bashDoc);
		// bash.md <critical> coreutils prohibition must survive sectioning.
		expect(bash.getSection("all")).toContain("NEVER use Linux coreutils");
		expect(bash.deferredSections).toContain("NEVER use Linux coreutils");
		expect(bash.deferredSections).toContain("NEVER redirect with `2>&1`");

		const read = parseToolPrompt(readDoc);
		// read.md selector grammar + FORBIDDEN bash equivalents must survive.
		expect(read.getSection("all")).toContain("cat`, `head`, `tail`");
		expect(read.deferredSections).toContain("`:50-200` — lines 50–200 inclusive.");
		expect(read.deferredSections).toContain("FORBIDDEN");
	});
});

describe("section markers never reach the wire", () => {
	it("renders identically with and without the @summary/@example markers", () => {
		const ctx = {
			asyncEnabled: true,
			ircEnabled: true,
			contextEnabled: true,
			IS_HL_MODE: true,
			INSPECT_IMAGE_ENABLED: true,
			DEFAULT_LIMIT: "200",
			DEFAULT_MAX_LINES: "2000",
		};
		for (const doc of [readDoc, bashDoc, findDoc]) {
			const markerFree = doc.replace(/\{\{!--\s*@(summary|example)\s*--\}\}\n?/g, "");
			expect(prompt.render(doc, ctx)).toBe(prompt.render(markerFree, ctx));
		}
	});

	it("strips the marker comments out of the rendered description", () => {
		const rendered = prompt.render(readDoc, { DEFAULT_LIMIT: "200", DEFAULT_MAX_LINES: "2000", IS_HL_MODE: true });
		expect(rendered).not.toContain("@summary");
		expect(rendered).not.toContain("{{!--");
		// And the real content still leads the description.
		expect(rendered.startsWith("Read files, directories")).toBe(true);
	});
});
