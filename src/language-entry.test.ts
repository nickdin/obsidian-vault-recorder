import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { transcriptLanguage } from "./agent-language.js";
import { LANGUAGE_NAME_CODES, parseLanguageEntry } from "./language-entry.js";
import { buildRequestNote, formatTurn, markDone, serializeTranscriptNote } from "./transcript-note.js";

// The language box saves `detect` or a code the agent line can name: a name becomes its code,
// anything else is refused with a reason. Typed Swedish words below are test input, as a user types them.

const saved = (typed: string): string => {
	const result = parseLanguageEntry(typed);
	assert.ok(result.ok, `${JSON.stringify(typed)} was refused: ${result.ok ? "" : result.reason}`);
	return result.value;
};

describe("what the language box saves", () => {
	it("saves detect for an empty box, and for detect in any capitals with spaces at the ends", () => {
		for (const typed of ["", "detect", " Detect ", "   ", "DETECT"]) assert.equal(saved(typed), "detect", typed);
	});

	it("saves a code as the lowercase code", () => {
		assert.equal(saved("sv"), "sv");
		assert.equal(saved("SV"), "sv");
		assert.equal(saved(" sv "), "sv");
		assert.equal(saved("en"), "en");
	});

	it("turns an English name into its code, without regard to capitals or end spaces", () => {
		assert.equal(saved("Swedish"), "sv");
		assert.equal(saved("swedish"), "sv");
		assert.equal(saved("English"), "en");
		assert.equal(saved(" GERMAN "), "de");
	});

	it("turns a Swedish name into its code, without regard to capitals or end spaces", () => {
		assert.equal(saved("svenska"), "sv");
		assert.equal(saved("Svenska "), "sv");
		assert.equal(saved("engelska"), "en");
		assert.equal(saved("tyska"), "de");
	});

	it("refuses what is neither detect, a code nor a name, and says why", () => {
		for (const typed of ["xx", "Swedishh", "sv sv", "swedish please", "123"]) {
			const result = parseLanguageEntry(typed);
			assert.equal(result.ok, false, typed);
			if (!result.ok) {
				assert.match(result.reason, /not understood/i, typed);
				assert.match(result.reason, /detect/, typed);
				assert.match(result.reason, /sv/, typed);
			}
		}
	});

	it("saves a region tag as its two-letter code", () => {
		assert.equal(saved("sv-SE"), "sv");
		assert.equal(saved("en-US"), "en");
		assert.equal(saved(" EN-us "), "en");
	});

	it("refuses a three-letter alias and a prefix of a name, so typing English never saves eng on the way", () => {
		for (const typed of ["swe", "eng", "en-U", "sv-"]) {
			const result = parseLanguageEntry(typed);
			assert.equal(result.ok, false, typed);
		}
		assert.equal(saved("En"), "en");
	});

	it("still saves haw and yue, the two three-letter codes the transcribers take", () => {
		assert.equal(saved("haw"), "haw");
		assert.equal(saved("YUE"), "yue");
	});

	it("names the languages Whisper transcribes", () => {
		for (const name of ["English", "Chinese", "Spanish", "French", "Norwegian", "Danish", "Finnish", "Japanese", "Arabic", "Hindi", "Hawaiian", "Cantonese"]) {
			assert.ok(parseLanguageEntry(name).ok, name);
		}
	});
});

describe("every code the language box can save reaches the agent line", () => {
	const noteWith = (language: string): string =>
		serializeTranscriptNote(
			markDone(
				buildRequestNote({
					audio: "Recording 20261025095911.m4a",
					audioBytes: 20_000,
					mode: "daily-log",
					recorded: "2026-10-25T09:59:11+02:00",
					speakerSplit: false,
					language,
					attempt: 1,
				}),
				{ at: "2026-10-25T10:00:00+02:00", seconds: 4, text: formatTurn(0, "Speaker 1", "Okej. Mm.") },
			),
		);

	it("is named by transcriptLanguage when written into a transcript note", () => {
		const codes = new Set(LANGUAGE_NAME_CODES.values());
		assert.ok(codes.size > 50, `only ${codes.size} codes`);
		for (const code of codes) {
			assert.equal(saved(code), code);
			assert.notEqual(transcriptLanguage(noteWith(code)), null, code);
		}
	});

	it("is named by transcriptLanguage for a code typed in capitals", () => {
		assert.equal(transcriptLanguage(noteWith(saved("SV"))), "Swedish");
	});
});
