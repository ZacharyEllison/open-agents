/**
 * Proactive repair of common LLM tool-argument mistakes before Zod/JSON Schema
 * validation. Complements the reactive coercion pass in `@open-agents/ai` by
 * handling mismatches validation never surfaces as recoverable issues (e.g.
 * `undefined` where an array is required).
 */
import { toolWireSchema } from "@open-agents/ai/utils/schema/wire";
import type { AgentTool } from "./types";

export interface FixupResult {
	args: Record<string, unknown>;
	/** Human-readable descriptions of each repair applied. */
	corrections: string[];
}

type JsonScalarType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Tool-specific defaults for required array fields that reject an empty list. */
const TOOL_ARRAY_DEFAULTS: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> = {
	find: { paths: ["."] },
	search: { paths: ["."] },
};

const ARRAY_TO_STRING_JOINERS: Readonly<Record<string, Readonly<Record<string, (items: unknown[]) => string>>>> = {
	bash: {
		command: items => items.map(item => String(item)).join(" && "),
	},
};

const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(value: unknown): boolean {
	return value === undefined;
}

function addTypes(target: Set<JsonScalarType>, schema: Record<string, unknown>): void {
	const rawType = schema.type;
	if (typeof rawType === "string") {
		target.add(rawType as JsonScalarType);
		return;
	}
	if (Array.isArray(rawType)) {
		for (const entry of rawType) {
			if (typeof entry === "string") target.add(entry as JsonScalarType);
		}
	}
}

function collectExpectedTypes(schema: unknown, depth = 0): Set<JsonScalarType> {
	const types = new Set<JsonScalarType>();
	if (!isSchemaRecord(schema) || depth > 8) return types;

	addTypes(types, schema);

	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			for (const t of collectExpectedTypes(branch, depth + 1)) types.add(t);
		}
	}
	if (Array.isArray(schema.oneOf)) {
		for (const branch of schema.oneOf) {
			for (const t of collectExpectedTypes(branch, depth + 1)) types.add(t);
		}
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) {
			for (const t of collectExpectedTypes(branch, depth + 1)) types.add(t);
		}
	}

	if (types.size === 0 && schema.items !== undefined) {
		types.add("array");
	}

	return types;
}

function expectsArray(types: Set<JsonScalarType>): boolean {
	return types.has("array");
}

function expectsOnlyArray(types: Set<JsonScalarType>): boolean {
	return types.has("array") && !types.has("string");
}

function expectsString(types: Set<JsonScalarType>): boolean {
	return types.has("string");
}

function expectsOnlyString(types: Set<JsonScalarType>): boolean {
	return types.has("string") && !types.has("array");
}

function expectsNumber(types: Set<JsonScalarType>): boolean {
	return types.has("number") || types.has("integer");
}

function toolArrayDefault(toolName: string, key: string): readonly unknown[] | undefined {
	return TOOL_ARRAY_DEFAULTS[toolName]?.[key];
}

function joinArrayAsString(toolName: string, key: string, items: unknown[]): string | undefined {
	const joiner = ARRAY_TO_STRING_JOINERS[toolName]?.[key];
	return joiner ? joiner(items) : undefined;
}

function tryParseNumericString(value: string, types: Set<JsonScalarType>): number | undefined {
	if (!expectsNumber(types)) return undefined;
	const trimmed = value.trim();
	if (!trimmed || !NUMERIC_STRING_PATTERN.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function fixPropertyValue(
	toolName: string,
	key: string,
	value: unknown,
	propertySchema: unknown,
	required: Set<string>,
	corrections: string[],
): unknown {
	const expected = collectExpectedTypes(propertySchema);
	if (expected.size === 0) return value;

	if (isMissing(value)) {
		if (!expectsArray(expected)) return value;
		if (!required.has(key)) return value;

		const override = toolArrayDefault(toolName, key);
		const replacement = override ?? [];
		corrections.push(
			override ? `${key}: missing → default ${JSON.stringify(replacement)}` : `${key}: missing → empty array`,
		);
		return [...replacement];
	}

	if (typeof value === "string") {
		if (expectsOnlyArray(expected)) {
			corrections.push(`${key}: string → wrapped in array`);
			return [value];
		}
		const parsed = tryParseNumericString(value, expected);
		if (parsed !== undefined && expectsNumber(expected) && !expectsString(expected)) {
			corrections.push(`${key}: numeric string → number`);
			return parsed;
		}
		return value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		if (expectsString(expected) && !expectsNumber(expected)) {
			corrections.push(`${key}: ${typeof value} → string`);
			return String(value);
		}
		return value;
	}

	if (Array.isArray(value)) {
		if (!expectsString(expected) || expectsArray(expected)) return value;

		const joined = joinArrayAsString(toolName, key, value);
		if (joined !== undefined) {
			corrections.push(`${key}: array → joined command string`);
			return joined;
		}

		if (expectsOnlyString(expected) && value.length > 0) {
			corrections.push(`${key}: array → first element`);
			return value[0];
		}
	}

	if (isSchemaRecord(propertySchema) && propertySchema.properties && isSchemaRecord(value)) {
		return fixObjectProperties(toolName, propertySchema, value, corrections);
	}

	return value;
}

function fixObjectProperties(
	toolName: string,
	schema: Record<string, unknown>,
	args: Record<string, unknown>,
	corrections: string[],
): Record<string, unknown> {
	const properties = schema.properties;
	if (!isSchemaRecord(properties)) return args;

	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [],
	);

	let next = args;
	let changed = false;

	for (const [key, propertySchema] of Object.entries(properties)) {
		const current = key in next ? next[key] : undefined;
		const fixed = fixPropertyValue(toolName, key, current, propertySchema, required, corrections);
		if (fixed === current) continue;
		if (!changed) {
			next = { ...next };
			changed = true;
		}
		next[key] = fixed;
	}

	return next;
}

/**
 * Repair common malformed tool arguments using the tool's wire JSON Schema.
 * Only applies changes that reconcile type mismatches; well-formed calls pass
 * through unchanged.
 */
export function fixupToolArgs(tool: AgentTool, args: Record<string, unknown>): FixupResult {
	if (!isSchemaRecord(args)) {
		return { args, corrections: [] };
	}

	const wire = toolWireSchema(tool);
	if (wire.type !== "object" || !isSchemaRecord(wire.properties)) {
		return { args, corrections: [] };
	}

	const corrections: string[] = [];
	const fixed = fixObjectProperties(tool.name, wire, args, corrections);
	return { args: fixed, corrections };
}
