import { describe, expect, test } from "bun:test";
import {
	createCompactorOnnxSummarizer,
	isCompactorOnnxEnabled,
	resolveCompactorOnnxModelKey,
} from "../src/compaction/compactor-onnx";
import { Settings } from "../src/config/settings";

describe("compactor ONNX settings", () => {
	test("defaults to server compaction (online)", () => {
		const settings = Settings.isolated({});
		expect(resolveCompactorOnnxModelKey(settings)).toBeUndefined();
		expect(isCompactorOnnxEnabled(settings)).toBe(false);
		expect(createCompactorOnnxSummarizer(settings)).toBeUndefined();
	});

	test("enables local compaction for a memory-model key", () => {
		const settings = Settings.isolated({ "providers.compactorOnnxModel": "qwen3-1.7b" });
		expect(resolveCompactorOnnxModelKey(settings)).toBe("qwen3-1.7b");
		expect(isCompactorOnnxEnabled(settings)).toBe(true);
		expect(createCompactorOnnxSummarizer(settings)).toBeDefined();
	});
});
