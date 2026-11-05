import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions } from "./lifecycle-actions.js";
import { parseTranscriptNote, readList, readString, type TranscriptNote } from "./transcript-note.js";

// How "Transcribe this recording" guesses the mode of the note a recording is
// linked from (#189–#193, against #122). Every transcriber is a hand-off, so a
// missing request is a missing mode and never a missing transcriber.

const AUDIO = "Recording 20261019091200.m4a";
const NOTE = "Recording 20261019091200.md";

// A transcript note another recording linked from `linkedFrom` already has.
const sibling = (mode: string, linkedFrom: string): string => `---
rule-version: 1
audio: "[[Recording 20261019080000.m4a]]"
audio-bytes: 1000
mode: ${mode}
recorded: 2026-10-19T08:00:00+02:00
linked-from: "[[${linkedFrom}]]"
speaker-split: ${mode === "meeting"}
attempt: 1
transcribe: requested
---
`;

interface Setup {
	world: FakeWorld;
	actions: RecordingActions;
	/** The notes that embed a recording, as Obsidian's resolved links would list them. */
	embeddedIn: Map<string, string[]>;
	written(): TranscriptNote;
}

function setup(): Setup {
	const world = makeFakeWorld();
	for (const mode of ["dailyLog", "cursor", "meeting"] as const) {
		world.currentSettings.transcribers[mode].kind = "hand-off";
	}
	world.vault.binaries.set(AUDIO, 2_314_752);
	const embeddedIn = new Map<string, string[]>();
	const actions = new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: async (_path, step) => ({ ran: true, value: await step() }),
		noteProperties: world.noteProperties,
		notesEmbedding: (audioPath) => embeddedIn.get(audioPath) ?? [],
		confirm: async () => true,
		refresh: async () => {},
	});
	const written = (): TranscriptNote => {
		const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
		assert.ok(note, "a transcript note was written");
		return note;
	};
	return { world, actions, embeddedIn, written };
}

describe("a note that names participants is a meeting note", () => {
	it("gets the meeting request with no other recording and no notice", async () => {
		const s = setup();
		s.world.noteProperties.set("Meetings/Standup.md", "participants", ["Anna", "Bo"]);
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "Meetings/Standup.md" });
		assert.equal(result.changed, true);
		const note = s.written();
		assert.equal(readString(note, "mode"), "meeting");
		assert.equal(readString(note, "speaker-split"), "true");
		assert.deepEqual(readList(note, "participants"), ["Anna", "Bo"]);
		assert.doesNotMatch(result.message, /daily log|guess/i);
	});
});

describe("a daily log is a daily log", () => {
	it("gets the daily-log request and no notice whatever mode its other recordings had", async () => {
		const s = setup();
		s.world.vault.seed("Recording 20261019080000.md", sibling("cursor", "2026-10-19"));
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "2026-10-19.md" });
		assert.equal(readString(s.written(), "mode"), "daily-log");
		assert.doesNotMatch(result.message, /daily log|guess/i);
	});

	it("is recognised for a date other than the recording's own, in the configured folder", async () => {
		const s = setup();
		s.world.currentSettings.useDailyNotesSettings = false;
		s.world.currentSettings.dailyLogFolder = "Journal";
		s.world.currentSettings.dailyLogFormat = "YYYYMMDD";
		s.world.vault.seed("Recording 20261019080000.md", sibling("cursor", "20260101"));
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "Journal/20260101.md" });
		assert.equal(readString(s.written(), "mode"), "daily-log");
		assert.doesNotMatch(result.message, /daily log|guess/i);
	});
});

describe("the audio file in focus", () => {
	it("a recording embedded in one meeting note is requested as from that note", async () => {
		const s = setup();
		s.embeddedIn.set(AUDIO, ["Meetings/Standup.md"]);
		s.world.noteProperties.set("Meetings/Standup.md", "participants", ["Anna"]);
		const result = await s.actions.transcribe(AUDIO);
		const note = s.written();
		assert.equal(readString(note, "mode"), "meeting");
		assert.equal(readString(note, "linked-from"), "[[Standup]]");
		assert.doesNotMatch(result.message, /not embedded/);
	});

	it("a recording embedded in no note still says so", async () => {
		const s = setup();
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(readString(s.written(), "mode"), "daily-log");
		assert.match(result.message, /not .*in any note/);
	});

	it("notes that disagree give the daily log and a notice naming them", async () => {
		const s = setup();
		s.embeddedIn.set(AUDIO, ["Meetings/Standup.md", "Other.md"]);
		s.world.noteProperties.set("Meetings/Standup.md", "participants", ["Anna"]);
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(readString(s.written(), "mode"), "daily-log");
		assert.match(result.message, /Meetings\/Standup\.md/);
		assert.match(result.message, /Other\.md/);
	});

	it("notes that agree give their answer", async () => {
		const s = setup();
		s.embeddedIn.set(AUDIO, ["A.md", "B.md"]);
		s.world.noteProperties.set("A.md", "participants", ["Anna"]);
		s.world.noteProperties.set("B.md", "participants", ["Bo"]);
		await s.actions.transcribe(AUDIO);
		assert.equal(readString(s.written(), "mode"), "meeting");
	});
});

describe("a guessed mode with no transcriber", () => {
	it("still says it guessed and why, with the choose-one sentence", async () => {
		const s = setup();
		s.world.currentSettings.transcribers.dailyLog.kind = "none";
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(result.changed, false);
		assert.match(result.message, /not .*in any note/);
		assert.match(result.message, /choose one in the settings/);
	});
});

describe("two notes with one name", () => {
	it("each gets its own recordings' mode, not the other's", async () => {
		const s = setup();
		s.world.vault.seed("Recording 20261019080000.md", sibling("meeting", "A/Standup"));
		await s.actions.transcribe(AUDIO, { linkedFrom: "B/Standup.md" });
		assert.equal(readString(s.written(), "mode"), "daily-log", "B/Standup has no recording of its own");

		const t = setup();
		t.world.vault.seed("Recording 20261019080000.md", sibling("meeting", "A/Standup"));
		await t.actions.transcribe(AUDIO, { linkedFrom: "A/Standup.md" });
		assert.equal(readString(t.written(), "mode"), "meeting");
	});
});
