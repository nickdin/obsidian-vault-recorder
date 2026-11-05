import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	type ActiveEditorAdapter,
	insertAtSnapshot,
	snapshotCursor,
} from "./cursor-snapshot.js";

const LINK = "![[Recording 20260422101500.m4a]]";

function makeAdapter(
	filePath: string | null,
	cursor: { line: number; ch: number } | null,
): ActiveEditorAdapter {
	return {
		getActiveFilePath: () => filePath,
		getCursor: () => cursor,
	};
}

describe("snapshotCursor", () => {
	it("returns null when there is no active file", () => {
		const snap = snapshotCursor(makeAdapter(null, { line: 2, ch: 0 }));
		assert.equal(snap, null);
	});

	it("returns null when there is no cursor", () => {
		const snap = snapshotCursor(makeAdapter("Notes/test.md", null));
		assert.equal(snap, null);
	});

	it("returns a snapshot for valid input", () => {
		const snap = snapshotCursor(makeAdapter("Notes/test.md", { line: 3, ch: 7 }));
		assert.deepEqual(snap, { filePath: "Notes/test.md", line: 3, ch: 7 });
	});
});

describe("insertAtSnapshot", () => {
	it("inserts the link at the exact cursor position in the line", () => {
		const content = "line 0\nline 1 here\nline 2\n";
		const res = insertAtSnapshot(content, LINK, 1, 7);
		assert.equal(res.outcome, "inserted-at-position");
		assert.equal(res.result, "line 0\nline 1 " + LINK + "here\nline 2\n");
	});

	it("inserts at the start of the line when ch=0", () => {
		const content = "first\nsecond\n";
		const res = insertAtSnapshot(content, LINK, 0, 0);
		assert.equal(res.outcome, "inserted-at-position");
		assert.equal(res.result, LINK + "first\nsecond\n");
	});

	it("clamps ch to the line length when it is too high", () => {
		const content = "short\nsecond\n";
		const res = insertAtSnapshot(content, LINK, 0, 999);
		assert.equal(res.outcome, "inserted-at-position");
		assert.equal(res.result, "short" + LINK + "\nsecond\n");
	});

	it("falls back to appending when the line is out of bounds (too high)", () => {
		const content = "line 0\nline 1\n";
		const res = insertAtSnapshot(content, LINK, 99, 0);
		assert.equal(res.outcome, "fallback-append");
		assert.equal(res.result, "line 0\nline 1\n" + LINK + "\n");
	});

	it("falls back to appending when the line is negative", () => {
		const content = "text\n";
		const res = insertAtSnapshot(content, LINK, -1, 0);
		assert.equal(res.outcome, "fallback-append");
		assert.equal(res.result, "text\n" + LINK + "\n");
	});

	it("handles the empty file (line=0 is in bounds, because split gives [''])", () => {
		// "".split("\n") returns [""], length 1 → line=0 is in bounds, while
		// line=1 would be out of bounds. Both cases are tested separately.
		const res = insertAtSnapshot("", LINK, 0, 0);
		// In bounds: lines=[""], which becomes LINK.
		assert.equal(res.outcome, "inserted-at-position");
		assert.equal(res.result, LINK);
	});

	it("is idempotent when the link is already somewhere in the file", () => {
		const content = "before\n" + LINK + "\nafter\n";
		const res = insertAtSnapshot(content, LINK, 0, 0);
		assert.equal(res.outcome, "already-present");
		assert.equal(res.result, content);
	});
});
