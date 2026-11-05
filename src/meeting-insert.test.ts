import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { insertAtSnapshot, insertInMeetingNote } from "./cursor-snapshot.js";
import { Lifecycle, type StoppedRecording } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld } from "./lifecycle-fakes.js";

const NOTES = { text: "Notes", level: 1 };
const FILENAME = "Recording 20261019093539.m4a";
const EMBED = `![[${FILENAME}]]`;
const MEETING_NOTE = "Meetings/2026-10-19 Planning.md";

describe("insertInMeetingNote — the pure choice between the heading and the cursor", () => {
	it("inserts last in the notes section when the note has the heading, wherever the cursor was", () => {
		const content = "Agenda\n\n# Notes\nFirst.\n\n# Actions\n- one\n";
		// The cursor is on the first line, far above the heading.
		const res = insertInMeetingNote(content, EMBED, 0, 3, NOTES);
		assert.equal(res.outcome, "inserted-under-heading");
		assert.equal(res.result, `Agenda\n\n# Notes\nFirst.\n\n${EMBED}\n\n# Actions\n- one\n`);
	});

	it("inserts at the cursor when the note has no such heading — the same result as cursor mode", () => {
		const content = "Agenda\n\nNotes\n- one\n";
		const res = insertInMeetingNote(content, EMBED, 1, 0, NOTES);
		assert.equal(res.outcome, "inserted-at-position");
		assert.deepEqual(res, insertAtSnapshot(content, EMBED, 1, 0));
		assert.equal(res.result, `Agenda\n${EMBED}\nNotes\n- one\n`);
	});

	it("finds a near-miss heading by capitals, extra spaces after the # or a run of spaces inside", () => {
		const cases: Array<[string, string]> = [
			["# notes", "# notes"],
			["#  Notes", "#  Notes"],
			["# Notes   ", "# Notes   "],
			["# Daily   NOTES", "# Daily   NOTES"],
		];
		for (const [written] of cases) {
			const setting = written.includes("Daily") ? { text: "Daily notes", level: 1 } : NOTES;
			const content = `Agenda\n\n${written}\nFirst.\n\n# Actions\n- one\n`;
			const res = insertInMeetingNote(content, EMBED, 0, 3, setting);
			assert.equal(res.outcome, "inserted-under-heading", written);
			assert.equal(
				res.result,
				`Agenda\n\n${written}\nFirst.\n\n${EMBED}\n\n# Actions\n- one\n`,
				written,
			);
		}
	});

	it("treats a heading of another level as absent and uses the cursor", () => {
		const content = "Agenda\n## Notes\nA.\n";
		const res = insertInMeetingNote(content, EMBED, 0, 0, NOTES);
		assert.equal(res.outcome, "inserted-at-position");
		assert.equal(res.result, `${EMBED}Agenda\n## Notes\nA.\n`);
	});

	it("keeps the cursor's fallback: a position gone from the note appends at the end", () => {
		const res = insertInMeetingNote("Agenda\n", EMBED, 99, 0, NOTES);
		assert.equal(res.outcome, "fallback-append");
		assert.equal(res.result, `Agenda\n${EMBED}\n`);
	});

	it("takes the heading from the settings, text and level", () => {
		const content = "Intro\n\n## Minutes\nA.\n\n## Decisions\nB.\n";
		const res = insertInMeetingNote(content, EMBED, 0, 0, { text: "Minutes", level: 2 });
		assert.equal(res.outcome, "inserted-under-heading");
		assert.equal(res.result, `Intro\n\n## Minutes\nA.\n\n${EMBED}\n\n## Decisions\nB.\n`);
	});

	it("is idempotent whether or not the note has the heading", () => {
		const withHeading = "# Notes\nA.\n";
		const once = insertInMeetingNote(withHeading, EMBED, 0, 0, NOTES).result;
		const again = insertInMeetingNote(once, EMBED, 0, 0, NOTES);
		assert.equal(again.outcome, "already-present");
		assert.equal(again.result, once);
		const without = insertInMeetingNote("A\n", EMBED, 0, 0, NOTES).result;
		assert.equal(insertInMeetingNote(without, EMBED, 0, 0, NOTES).outcome, "already-present");
	});

	it("lands above the first subsection when the notes section holds one", () => {
		const content = "# Notes\nOwn.\n## Sub\nText.\n";
		const res = insertInMeetingNote(content, EMBED, 3, 0, NOTES);
		assert.equal(res.result, `# Notes\nOwn.\n\n${EMBED}\n\n## Sub\nText.\n`);
	});
});

function stop(mode: StoppedRecording["mode"], line: number, ch: number): StoppedRecording {
	return {
		mode,
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(14_123_456),
		linkTarget: { kind: "cursor", snapshot: { filePath: MEETING_NOTE, line, ch } },
	};
}

describe("a stopped recording's link, through the lifecycle", () => {
	it("meeting mode puts the embed and the transcript link last in the notes section", async () => {
		const world = makeFakeWorld();
		world.vault.seed(MEETING_NOTE, "Agenda\n\n# Notes\nFirst.\n\n# Actions\n");
		world.currentSettings.transcribers.meeting.kind = "hand-off";
		await new Lifecycle(world).recordingStopped(stop("meeting", 0, 0));
		assert.equal(
			await world.vault.read(MEETING_NOTE),
			`Agenda\n\n# Notes\nFirst.\n\n${EMBED} [[Recording 20261019093539]]\n\n# Actions\n`,
		);
	});

	it("meeting mode puts it at the cursor when the note lacks the heading", async () => {
		const world = makeFakeWorld();
		world.vault.seed(MEETING_NOTE, "Agenda\n\nNotes\n");
		world.currentSettings.transcribers.meeting.kind = "hand-off";
		await new Lifecycle(world).recordingStopped(stop("meeting", 1, 0));
		assert.equal(
			await world.vault.read(MEETING_NOTE),
			`Agenda\n${EMBED} [[Recording 20261019093539]]\nNotes\n`,
		);
	});

	it("meeting mode follows a changed notes heading setting", async () => {
		const world = makeFakeWorld();
		world.vault.seed(MEETING_NOTE, "Agenda\n\n## Minutes\nFirst.\n\n## Decisions\n");
		world.currentSettings.notesHeading = { text: "Minutes", level: 2 };
		await new Lifecycle(world).recordingStopped(stop("meeting", 0, 0));
		assert.equal(
			await world.vault.read(MEETING_NOTE),
			`Agenda\n\n## Minutes\nFirst.\n\n${EMBED}\n\n## Decisions\n`,
		);
	});

	it("cursor mode stays at the cursor even when the note has the heading", async () => {
		const world = makeFakeWorld();
		world.vault.seed(MEETING_NOTE, "Agenda\n\n# Notes\nFirst.\n");
		await new Lifecycle(world).recordingStopped(stop("cursor", 0, 6));
		assert.equal(
			await world.vault.read(MEETING_NOTE),
			`Agenda${EMBED}\n\n# Notes\nFirst.\n`,
		);
	});

	it("the daily-log mode takes the configured heading and creates it when missing", async () => {
		const world = makeFakeWorld();
		world.currentSettings.notesHeading = { text: "Notes", level: 2 };
		world.vault.seed("Journal/2026-10-19.md", "# Day\n\nText.\n");
		await new Lifecycle(world).recordingStopped({
			mode: "dailyLog",
			filename: FILENAME,
			peak: 0.3,
			audio: audioOfSize(14_123_456),
			linkTarget: { kind: "daily-log", path: "Journal/2026-10-19.md" },
		});
		assert.equal(
			await world.vault.read("Journal/2026-10-19.md"),
			`# Day\n\nText.\n\n## Notes\n\n${EMBED}\n`,
		);
	});
});
