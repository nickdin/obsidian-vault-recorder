import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { renameSpeaker, writtenLabelAt } from "./naming.js";
import { formatTurn, markDone, parseTranscriptNote } from "./transcript-note.js";

const HEAD = `---
rule-version: 1
audio: "[[Recording 20261019093539.m4a]]"
audio-bytes: 14123456
mode: meeting
recorded: 2026-10-19T09:35:39+02:00
speaker-split: true
attempt: 1
transcribe: requested
---
`;

const parsed = parseTranscriptNote(HEAD);
assert.ok(parsed);
const note = markDone(parsed, {
	at: "2026-10-19T10:01:00+02:00",
	seconds: 60,
	text: [
		formatTurn(2, "[[Anna Svensson#Work]]", "Hello."),
		formatTurn(9, "[[Cecilia Dahl|Cia]]", "Hi."),
		formatTurn(15, "Speaker 1", "Yes."),
	].join("\n\n"),
});

describe("a reading-view click carries the label as written", () => {
	it("finds [[Name#Heading]] from what Obsidian shows, a time and the source", () => {
		assert.equal(writtenLabelAt(note.body, 2, "Anna Svensson > Work"), "[[Anna Svensson#Work]]");
	});

	it("lets the label be renamed, which the rendered words alone could not", () => {
		const shown = "Anna Svensson > Work";
		assert.equal(renameSpeaker(note, shown, "Bo"), note, "the rendered words match nothing");
		const written = writtenLabelAt(note.body, 2, shown);
		const after = renameSpeaker(note, written, "Bo");
		assert.ok(after.body.includes("**Bo:**"));
		assert.ok(!after.body.includes("Anna Svensson#Work"));
	});

	it("finds an aliased link and a numbered label too", () => {
		assert.equal(writtenLabelAt(note.body, 9, "Cia"), "[[Cecilia Dahl|Cia]]");
		assert.equal(writtenLabelAt(note.body, 15, "Speaker 1"), "Speaker 1");
	});

	it("tells two turns that start the same second apart by the words shown", () => {
		const twins = {
			...note,
			body: `${formatTurn(9, "Bo", "One.")}\n\n${formatTurn(9, "[[Anna Svensson#Work]]", "Two.")}\n\n${formatTurn(9, "Cy", "Three.")}`,
		};
		assert.equal(writtenLabelAt(twins.body, 9, "Anna Svensson > Work"), "[[Anna Svensson#Work]]");
		assert.equal(writtenLabelAt(twins.body, 9, "Cy"), "Cy");
	});

	it("falls back to the words shown when the source has no turn at that time", () => {
		assert.equal(writtenLabelAt(note.body, 99, "Anna Svensson > Work"), "Anna Svensson > Work");
	});
});
