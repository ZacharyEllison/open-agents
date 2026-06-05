/**
 * Structured parser for tool prompt `.md` files (`../prompts/tools/*.md`).
 *
 * Phase 4a groundwork for "Slim prompt prefill": the tool docs are monolithic
 * prose today, rendered verbatim onto the wire via `prompt.render`. To wire a
 * slim tool profile later (Phase 4b) we need to split each doc into addressable
 * sections — a short `summary`, a representative `primaryExample`, the full
 * `examples`/`parameters` payloads, and the remaining `deferredSections` prose —
 * WITHOUT changing what bytes ship today.
 *
 * The parser operates on the raw template text (handlebars markers intact),
 * exactly as the tool descriptions are consumed before `prompt.render`. Section
 * boundaries come from the docs' existing structure (top-level XML-style tags
 * like `<instruction>`/`<examples>`, markdown headings, and `## Parameters`),
 * plus two lightweight handlebars-comment conventions that are stripped at
 * render and therefore never reach the wire:
 *
 *   {{!-- @summary --}}   marks the leading summary paragraph
 *   {{!-- @example --}}   marks a representative example line (for docs that
 *                         have no `<examples>` block)
 *
 * `getSection("all")` returns the document verbatim, so the existing
 * render path stays byte-for-byte identical until Phase 4b opts into slim mode.
 */

/** Marker comments are handlebars comments so they vanish under `prompt.render`. */
const SUMMARY_MARKER = /\{\{!--\s*@summary\s*--\}\}/;
const EXAMPLE_MARKER = /\{\{!--\s*@example\s*--\}\}/;
/** Any handlebars comment, e.g. `{{! ... }}` or `{{!-- ... --}}`. */
const HANDLEBARS_COMMENT = /\{\{!.*?\}\}/g;

/** Whole-line opening top-level tag, e.g. `<instruction>` (not self-closing). */
const OPENING_TAG = /^<([a-zA-Z][\w-]*)>\s*$/;
/** Whole-line closing top-level tag, e.g. `</instruction>`. */
const CLOSING_TAG = /^<\/([a-zA-Z][\w-]*)>\s*$/;
/** Markdown heading line, e.g. `# Files` or `## Parameters`. */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
/** Inline code span, e.g. `` `path` ``. */
const INLINE_CODE = /`([^`]+)`/;
/** Opening/closing fenced code block. */
const FENCE = /^\s*(```|~~~)/;

export type ToolPromptSectionKind = "summary" | "instruction" | "parameters" | "examples" | "details";

/** Section accessor used by the slim-wire profile builder (Phase 4b). */
export type ToolPromptSectionRequest = ToolPromptSectionKind | "all";

export interface ToolPromptSection {
	readonly kind: ToolPromptSectionKind;
	/** Tag name or heading text this section came from; `null` for the summary. */
	readonly label: string | null;
	/** Verbatim source slice for this section (boundary line through the next). */
	readonly raw: string;
}

export interface ParsedToolPrompt {
	/** The exact original document text. */
	readonly source: string;
	/** First paragraph — the one-line/one-paragraph wire summary. */
	readonly summary: string;
	/** A single representative example, or `null` when the doc has none. */
	readonly primaryExample: string | null;
	/** Inner content of the examples block, or `null`. */
	readonly examples: string | null;
	/** Parameter/argument documentation, or `null`. */
	readonly parameters: string | null;
	/** Instruction/parameter/edge-case prose deferred off the slim wire. */
	readonly deferredSections: string;
	/** Ordered structural sections; concatenating `raw` reproduces `source`. */
	readonly sections: readonly ToolPromptSection[];
	/**
	 * Return a section's text. `"all"` yields the verbatim source (the existing
	 * render input); the named kinds yield that section's payload, or `""` when
	 * the document has no such section.
	 */
	getSection(section: ToolPromptSectionRequest): string;
}

interface PhysicalLine {
	readonly text: string;
	/** Inclusive start offset into `source`. */
	readonly start: number;
}

function splitPhysicalLines(source: string): PhysicalLine[] {
	const lines: PhysicalLine[] = [];
	let offset = 0;
	for (const text of source.split("\n")) {
		lines.push({ text, start: offset });
		// Every split point except a trailing one consumed one "\n".
		offset += text.length + 1;
	}
	return lines;
}

function stripMarkers(text: string): string {
	return text.replace(HANDLEBARS_COMMENT, "").trim();
}

function classifyTag(tag: string): ToolPromptSectionKind {
	const name = tag.toLowerCase();
	if (name === "instruction") return "instruction";
	if (name === "parameters") return "parameters";
	if (name === "examples") return "examples";
	return "details";
}

function classifyHeading(heading: string): ToolPromptSectionKind {
	const text = heading.toLowerCase();
	if (/\bparameters?\b/.test(text)) return "parameters";
	if (/\bexamples?\b/.test(text)) return "examples";
	return "details";
}

interface Boundary {
	readonly lineIndex: number;
	readonly kind: ToolPromptSectionKind;
	readonly label: string | null;
}

/**
 * Walk the document and find where each structural section begins. The summary
 * occupies the leading paragraph; everything after is split at top-level tags
 * and headings (tracking tag nesting so `# comment` lines inside `<examples>`
 * are not mistaken for new sections).
 */
function findBoundaries(lines: PhysicalLine[]): Boundary[] {
	const boundaries: Boundary[] = [{ lineIndex: 0, kind: "summary", label: null }];

	// Locate the end of the summary paragraph: the first blank line that follows
	// at least one line of (non-marker) summary content.
	let sawSummaryContent = false;
	let bodyStart = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const stripped = stripMarkers(lines[i].text);
		if (stripped === "") {
			if (sawSummaryContent) {
				// Skip the run of blank lines; body starts at the next content line.
				let j = i + 1;
				while (j < lines.length && stripMarkers(lines[j].text) === "") j++;
				bodyStart = j;
				break;
			}
			continue;
		}
		sawSummaryContent = true;
	}

	const tagStack: string[] = [];
	let pendingPreamble = bodyStart < lines.length;
	for (let i = bodyStart; i < lines.length; i++) {
		const trimmed = lines[i].text.trim();
		const closing = CLOSING_TAG.exec(trimmed);
		if (closing) {
			if (tagStack.length > 0 && tagStack[tagStack.length - 1] === closing[1]) tagStack.pop();
			continue;
		}
		if (tagStack.length > 0) continue;

		const opening = OPENING_TAG.exec(trimmed);
		if (opening) {
			tagStack.push(opening[1]);
			boundaries.push({ lineIndex: i, kind: classifyTag(opening[1]), label: opening[1] });
			pendingPreamble = false;
			continue;
		}

		const heading = HEADING.exec(trimmed);
		if (heading) {
			boundaries.push({ lineIndex: i, kind: classifyHeading(heading[2]), label: heading[2] });
			pendingPreamble = false;
			continue;
		}

		if (pendingPreamble) {
			// Free prose between the summary and the first tag/heading (e.g. the
			// handlebars conditionals atop `task.md`). Keep it as deferred detail.
			boundaries.push({ lineIndex: i, kind: "details", label: null });
			pendingPreamble = false;
		}
	}

	return boundaries;
}

function sliceSection(source: string, lines: PhysicalLine[], from: number, toExclusive: number): string {
	const start = lines[from].start;
	const end = toExclusive < lines.length ? lines[toExclusive].start : source.length;
	return source.slice(start, end);
}

function extractSummary(sectionRaw: string): string {
	const lines = sectionRaw.split("\n");
	// Honor the explicit `{{!-- @summary --}}` convention: when present, the
	// summary is the paragraph that immediately follows it. Otherwise fall back
	// to the leading paragraph so unmarked docs still parse.
	const markerLine = lines.findIndex(line => SUMMARY_MARKER.test(line));
	const from = markerLine === -1 ? 0 : markerLine + 1;
	const collected: string[] = [];
	for (let i = from; i < lines.length; i++) {
		const stripped = stripMarkers(lines[i]);
		if (stripped === "") {
			if (collected.length > 0) break;
			continue;
		}
		collected.push(stripped);
	}
	return collected.join("\n").trim();
}

function tagInner(sectionRaw: string, tag: string): string {
	const open = new RegExp(`^<${tag}>\\s*$`, "m");
	const close = new RegExp(`^</${tag}>\\s*$`, "m");
	const openMatch = open.exec(sectionRaw);
	const closeMatch = close.exec(sectionRaw);
	if (!openMatch) return sectionRaw.trim();
	const innerStart = openMatch.index + openMatch[0].length;
	const innerEnd = closeMatch ? closeMatch.index : sectionRaw.length;
	return sectionRaw.slice(innerStart, innerEnd).trim();
}

function headingBody(sectionRaw: string): string {
	const lines = sectionRaw.split("\n");
	if (lines.length > 0 && HEADING.test(lines[0].trim())) {
		return lines.slice(1).join("\n").trim();
	}
	return sectionRaw.trim();
}

/**
 * First logical entry of an `<examples>` block: a leading `# comment` line plus
 * the code that follows it (or the first non-empty line when uncommented).
 */
function firstExampleEntry(examplesInner: string): string | null {
	const lines = examplesInner.split("\n");
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;
	if (start >= lines.length) return null;

	const entry: string[] = [lines[start].trim()];
	const startedWithComment = lines[start].trim().startsWith("#");
	for (let i = start + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed === "") {
			if (entry.length > 0) break;
			continue;
		}
		// A second `#`-comment begins the next entry.
		if (startedWithComment && trimmed.startsWith("#") && entry.length > 1) break;
		if (!startedWithComment && entry.length >= 1) break;
		entry.push(trimmed);
	}
	const joined = entry.join("\n").trim();
	return joined === "" ? null : joined;
}

/** Example pulled from an explicit `{{!-- @example --}}` marker: the marked content line. */
function markedExample(lines: PhysicalLine[]): string | null {
	for (let i = 0; i < lines.length; i++) {
		if (!EXAMPLE_MARKER.test(lines[i].text)) continue;
		// The marker may sit on its own line or inline before the example text.
		const sameLine = stripMarkers(lines[i].text);
		if (sameLine !== "") return sameLine;
		for (let j = i + 1; j < lines.length; j++) {
			const stripped = stripMarkers(lines[j].text);
			if (stripped !== "") return stripped;
		}
	}
	return null;
}

/** Fallback example for docs lacking both `<examples>` and an `@example` marker. */
function fallbackExample(source: string): string | null {
	const lines = source.split("\n");
	let inFence = false;
	const fenceBody: string[] = [];
	for (const line of lines) {
		if (FENCE.test(line)) {
			if (inFence) {
				const body = fenceBody.join("\n").trim();
				if (body !== "") return body;
				fenceBody.length = 0;
			}
			inFence = !inFence;
			continue;
		}
		if (inFence) fenceBody.push(line);
	}
	const inline = INLINE_CODE.exec(source);
	return inline ? inline[1].trim() : null;
}

export function parseToolPrompt(source: string): ParsedToolPrompt {
	const lines = splitPhysicalLines(source);
	const boundaries = findBoundaries(lines);

	const sections: ToolPromptSection[] = boundaries.map((boundary, index) => {
		const toExclusive = index + 1 < boundaries.length ? boundaries[index + 1].lineIndex : lines.length;
		return {
			kind: boundary.kind,
			label: boundary.label,
			raw: sliceSection(source, lines, boundary.lineIndex, toExclusive),
		};
	});

	const summarySection = sections.find(section => section.kind === "summary");
	const summary = summarySection ? extractSummary(summarySection.raw) : "";

	const examplesSection = sections.find(section => section.kind === "examples");
	const examplesInner = examplesSection
		? examplesSection.label
			? tagInner(examplesSection.raw, examplesSection.label)
			: headingBody(examplesSection.raw)
		: null;
	const examples = examplesInner && examplesInner !== "" ? examplesInner : null;

	const parametersSection = sections.find(section => section.kind === "parameters");
	const parametersBody = parametersSection
		? parametersSection.label && OPENING_TAG.test(`<${parametersSection.label}>`)
			? tagInner(parametersSection.raw, parametersSection.label)
			: headingBody(parametersSection.raw)
		: null;
	const parameters = parametersBody && parametersBody !== "" ? parametersBody : null;

	let primaryExample: string | null = null;
	if (examples) primaryExample = firstExampleEntry(examples);
	if (!primaryExample) primaryExample = markedExample(lines);
	if (!primaryExample) primaryExample = fallbackExample(source);

	const deferredSections = sections
		.filter(section => section.kind !== "summary" && section.kind !== "examples")
		.map(section => section.raw.trim())
		.filter(text => text !== "")
		.join("\n\n");

	const getSection = (section: ToolPromptSectionRequest): string => {
		if (section === "all") return source;
		if (section === "summary") return summary;
		if (section === "examples") return examples ?? "";
		if (section === "parameters") return parameters ?? "";
		return sections
			.filter(candidate => candidate.kind === section)
			.map(candidate => candidate.raw.trim())
			.filter(text => text !== "")
			.join("\n\n");
	};

	return {
		source,
		summary,
		primaryExample,
		examples,
		parameters,
		deferredSections,
		sections,
		getSection,
	};
}
