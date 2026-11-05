import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isAudioPath } from "./audio-file.js";

describe("isAudioPath", () => {
	it("accepts what the plugin records and what Obsidian plays as audio", () => {
		for (const ext of ["m4a", "webm", "mp3", "wav", "ogg", "flac", "3gp"]) {
			assert.equal(isAudioPath(`Recording 20261019091200.${ext}`), true, ext);
		}
	});

	it("ignores case and the folder", () => {
		assert.equal(isAudioPath("Audio/Old/Memo.M4A"), true);
	});

	it("refuses an image, a PDF, a note and a name with no extension", () => {
		for (const path of ["pic.png", "scan.pdf", "2026-10-19.md", "Recording 20261019091200", "dir.m4a/readme"]) {
			assert.equal(isAudioPath(path), false, path);
		}
	});
});
