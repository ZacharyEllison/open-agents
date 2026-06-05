import { describe, expect, it } from "bun:test";
import { mergeRecallBlock } from "@open-agents/coding-agent/memory-backend/recall-merge";

const RECALL = "<memories>\n- user prefers tabs over spaces\n</memories>";

describe("mergeRecallBlock — first-turn recall appears exactly once", () => {
	it("appends the recall block when the base prompt does not carry it", () => {
		const base = ["HARNESS", "PROJECT context"];
		const merged = mergeRecallBlock(base, RECALL);
		expect(merged).toEqual(["HARNESS", "PROJECT context", RECALL]);
	});

	it("does not duplicate recall already folded into the base prompt", () => {
		// A concurrent refreshBaseSystemPrompt folded the snippet into block 1 via
		// the backend developer-instructions; the trailing block must be dropped.
		const base = ["HARNESS", `PROJECT context\n\n${RECALL}`];
		const merged = mergeRecallBlock(base, RECALL);
		expect(merged).toHaveLength(2);
		const occurrences = merged.join("\n").split(RECALL).length - 1;
		expect(occurrences).toBe(1);
	});

	it("returns the base unchanged when there is no recall snippet", () => {
		const base = ["HARNESS", "PROJECT context"];
		expect(mergeRecallBlock(base, undefined)).toEqual(base);
		expect(mergeRecallBlock(base, "   ")).toEqual([...base, "   "]);
	});
});
