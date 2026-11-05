import { test } from "node:test";
import assert from "node:assert/strict";
import { generateFilename } from "./filename.js";

test("generateFilename pads and follows the fixed pattern with .m4a", () => {
	// The month in Date is zero-indexed: 3 is April.
	const result = generateFilename(new Date(2026, 3, 15, 8, 12, 0), "m4a");
	assert.equal(result, "Recording 20260415081200.m4a");
});

test("generateFilename pads every field with zeroes (.m4a)", () => {
	const result = generateFilename(new Date(2026, 0, 1, 0, 0, 0), "m4a");
	assert.equal(result, "Recording 20260101000000.m4a");
});

test("generateFilename handles the end of the year (.m4a)", () => {
	const result = generateFilename(new Date(2026, 11, 31, 23, 59, 59), "m4a");
	assert.equal(result, "Recording 20261231235959.m4a");
});

test("generateFilename produces a .webm extension when asked for one", () => {
	const result = generateFilename(new Date(2026, 3, 15, 8, 12, 0), "webm");
	assert.equal(result, "Recording 20260415081200.webm");
});

test("generateFilename pads .webm identically to .m4a", () => {
	const result = generateFilename(new Date(2026, 0, 1, 0, 0, 0), "webm");
	assert.equal(result, "Recording 20260101000000.webm");
});
