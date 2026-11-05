/**
 * A pure module for snapshotting the active editor position and inserting an
 * audio link at that position.
 *
 * No Obsidian import — every external value arrives through
 * `ActiveEditorAdapter`, which makes the module trivially unit-testable. The
 * wrapper in main.ts implements the adapter against
 * `app.workspace.getActiveViewOfType(MarkdownView)`.
 *
 * Three rules carry the module:
 *  - The snapshot is taken when the recording STARTS, not when it stops, so
 *    the link lands where the user was when they pressed the button.
 *  - If the position has become invalid by stop time (the line was deleted),
 *    the insertion falls back to appending at the end of the file.
 *  - A meeting note that has the notes heading takes its link last in the
 *    text under the notes heading, wherever the cursor was; one without it takes the link at
 *    the cursor, as cursor mode always does.
 */
import { insertUnderNotesHeading } from "./note-insert";
import type { NotesHeading } from "./settings-data";

export interface CursorSnapshot {
	filePath: string;
	line: number;
	ch: number;
}

/**
 * An adapter for reading the active file and cursor without tying the module
 * to the Obsidian API. Implemented in main.ts.
 */
export interface ActiveEditorAdapter {
	getActiveFilePath(): string | null;
	getCursor(): { line: number; ch: number } | null;
}

export function snapshotCursor(
	adapter: ActiveEditorAdapter,
): CursorSnapshot | null {
	const filePath = adapter.getActiveFilePath();
	if (!filePath) return null;
	const cursor = adapter.getCursor();
	if (!cursor) return null;
	return { filePath, line: cursor.line, ch: cursor.ch };
}

export type InsertOutcome =
	| "inserted-at-position"
	| "inserted-under-heading"
	| "fallback-append"
	| "already-present";

export interface InsertAtResult {
	result: string;
	outcome: InsertOutcome;
}

/**
 * Insert `link` at (line, ch) in content.
 *  - Idempotence: if the link is already in content, return it unchanged with
 *    the outcome "already-present".
 *  - An out-of-bounds line appends at the end with the outcome
 *    "fallback-append".
 *  - `ch` is clamped to [0, line.length], so a value that is too high lands at
 *    the end of the line rather than throwing or producing broken output.
 */
export function insertAtSnapshot(
	content: string,
	link: string,
	line: number,
	ch: number,
): InsertAtResult {
	if (content.includes(link)) {
		return { result: content, outcome: "already-present" };
	}

	const lines = content.split("\n");

	if (line < 0 || line >= lines.length) {
		const appended = appendWithNewline(content, link);
		return { result: appended, outcome: "fallback-append" };
	}

	const targetLine = lines[line];
	const clampedCh = Math.min(Math.max(ch, 0), targetLine.length);
	const newLine =
		targetLine.slice(0, clampedCh) + link + targetLine.slice(clampedCh);
	lines[line] = newLine;
	return { result: lines.join("\n"), outcome: "inserted-at-position" };
}

/**
 * Insert `link` into a meeting note: last in the text under the notes heading when the note
 * has the notes heading, otherwise at (line, ch) exactly as `insertAtSnapshot`
 * does. The same idempotence: a note already holding `link` is returned
 * unchanged with the outcome "already-present".
 */
export function insertInMeetingNote(
	content: string,
	link: string,
	line: number,
	ch: number,
	heading: NotesHeading,
): InsertAtResult {
	if (content.includes(link)) {
		return { result: content, outcome: "already-present" };
	}
	const underHeading = insertUnderNotesHeading(content, link, heading);
	if (underHeading !== null) {
		return { result: underHeading, outcome: "inserted-under-heading" };
	}
	return insertAtSnapshot(content, link, line, ch);
}

function appendWithNewline(content: string, link: string): string {
	if (content.length === 0) return `${link}\n`;
	if (content.endsWith("\n")) return `${content}${link}\n`;
	return `${content}\n${link}\n`;
}
