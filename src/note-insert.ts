/**
 * A pure module for inserting an embed link into a note file.
 * No Obsidian import — which makes the module trivially unit-testable.
 *
 * The notes heading is a setting, text plus level (`NotesHeading`), and this
 * module takes it as an argument. The rules below find the heading the way
 * whisper-transkribera does, and place the link where Effortless's shipped daily
 * log has room for it; they do not claim to agree with Effortless for any other
 * layout of the notes section:
 *
 *  - The heading is the first line, outside a fenced code block, that is an
 *    ATX heading of exactly the configured level whose text equals the
 *    configured text, regardless of capitals and of runs of blanks (before,
 *    inside and after the text). A heading of another level or with more or
 *    different words is a different heading. whisper-transkribera must match the
 *    same way so the two writers' links land in one section; its half is
 *    whisper-transkribera #77, still open, and until it lands whisper-transkribera
 *    matches the capitals exactly.
 *  - The notes section's own text ends at the next heading of ANY level — a
 *    deeper, the same or a shallower one — outside a fenced code block, or at the
 *    end of the file. A deeper heading ends it too: what sits under that heading
 *    is the subsection's text, not the notes'.
 *  - The link goes last in that text: below what is written there, above the
 *    next heading, with a blank line before it and a blank line after it (when a
 *    heading follows). That puts the link directly under `# Notes` and above
 *    `## Overdue` in Effortless's shipped daily log, where `## Overdue`,
 *    `## Today` and `## Calendar` are subsections nested under the level-1
 *    `# Notes`.
 *  - If the heading is missing, `insertRecordingLink` appends the heading, at
 *    its configured level, plus the link at the end of the file.
 *  - Idempotent: if the line is already anywhere in the file, the file is
 *    returned unchanged.
 */
import type { NotesHeading } from "./settings-data";

export function insertRecordingLink(
	content: string,
	fileName: string,
	heading: NotesHeading,
): string {
	const link = `![[${fileName}]]`;

	// Idempotence: this guards against duplicates if a recovery path runs after
	// a successful stop.
	if (content.includes(link)) {
		return content;
	}

	const inserted = insertUnderNotesHeading(content, link, heading);
	if (inserted !== null) return inserted;

	// No heading: create the heading plus the link at the end of the file.
	return appendNewSection(content, link, heading);
}

/**
 * Put `line` last in the text under the notes heading, or return `null` when the
 * note has no such heading (a blank heading text matches nothing, since
 * nothing could ever find it again). The caller decides what to do instead:
 * the daily-log mode creates the section, the meeting mode falls back to the
 * cursor.
 *
 * Does not check for `line` already being present; both callers do.
 */
export function insertUnderNotesHeading(
	content: string,
	line: string,
	heading: NotesHeading,
): string | null {
	const lines = content.split("\n");
	const found = findNotesSection(lines, heading);
	if (found === null) return null;
	const { headingIndex, ownTextEnd } = found;

	// The section's content is lines[headingIndex+1 .. ownTextEnd-1]. Trim the
	// trailing blank lines inside it so there is exactly ONE blank line before
	// the link, however the section happened to end.
	let contentEnd = ownTextEnd;
	while (contentEnd > headingIndex + 1 && lines[contentEnd - 1].trim() === "") {
		contentEnd--;
	}

	const before = lines.slice(0, contentEnd); // heading + section content, without trailing blanks
	const after = lines.slice(ownTextEnd); // the next heading onwards, if there is one

	// Assemble: before + blank line + link + (blank line + rest) where there is
	// a rest, otherwise just the blank line and the link.
	const rebuilt =
		after.length > 0
			? [...before, "", line, "", ...after]
			: [...before, "", line, ""];

	return rebuilt.join("\n");
}

/**
 * Classify what `insertRecordingLink` did, by comparing before with after.
 * The lifecycle gates on the outcome and writes the file back only when it is
 * "inserted", never when it is "already-present".
 */
export function classifyInsertOutcome(
	before: string,
	after: string,
): "inserted" | "already-present" {
	return before === after ? "already-present" : "inserted";
}

interface NotesSection {
	/** The line holding the heading. */
	headingIndex: number;
	/** One past the section's own text: the next heading of any level, or the end. */
	ownTextEnd: number;
}

/**
 * Find the notes heading and the end of its own text, or `null` when the note
 * has no such heading. The end is the first heading of any level after the notes
 * heading, or the end of the file; the level of the notes heading plays no part
 * in it. A line inside a fenced code block is text, never a heading.
 */
function findNotesSection(lines: string[], wanted: NotesHeading): NotesSection | null {
	const wantedText = normalizeHeadingText(wanted.text);
	if (wantedText === "") return null;
	const wantedLevel = clampLevel(wanted.level);

	let headingIndex = -1;
	let fence: { marker: string; length: number } | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, "");

		if (fence !== null) {
			if (closesFence(line, fence)) fence = null;
			continue;
		}
		const opening = openingFence(line);
		if (opening !== null) {
			fence = opening;
			continue;
		}

		const atx = atxHeading(line);
		if (atx === null) continue;

		if (headingIndex === -1) {
			if (atx.level === wantedLevel && normalizeHeadingText(atx.text) === wantedText) {
				headingIndex = i;
			}
			continue;
		}
		return { headingIndex, ownTextEnd: i };
	}

	return headingIndex === -1 ? null : { headingIndex, ownTextEnd: lines.length };
}

/** Heading text compared without capitals and with every run of blanks as one space. */
function normalizeHeadingText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function atxHeading(line: string): { level: number; text: string } | null {
	const match = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*))?$/.exec(line);
	if (match === null) return null;
	return { level: match[1].length, text: (match[2] ?? "").trim() };
}

export function openingFence(line: string): { marker: string; length: number } | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return null;
	// A backtick fence's info string may not hold a backtick: that is inline code.
	if (match[1][0] === "`" && match[2].includes("`")) return null;
	return { marker: match[1][0], length: match[1].length };
}

export function closesFence(line: string, fence: { marker: string; length: number }): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length;
}

/** A heading only has six levels, and a stored value may be anything. */
function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 1;
	return Math.min(6, Math.max(1, Math.round(level)));
}

function appendNewSection(content: string, link: string, heading: NotesHeading): string {
	if (heading.text.trim() === "") {
		throw new Error(
			"The notes heading in the settings is empty, so there is no section to put the link in",
		);
	}
	const written = `${"#".repeat(clampLevel(heading.level))} ${heading.text.trim()}`;
	if (content.length === 0) {
		return `${written}\n\n${link}\n`;
	}
	const separator = content.endsWith("\n") ? "\n" : "\n\n";
	return `${content}${separator}${written}\n\n${link}\n`;
}
