import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, type StoppedRecording } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";

const FILENAME = "Recording 20261019093539.m4a";
const MEETING_NOTE = "Meetings/2026-10-19 Planning.md";
const TRANSCRIPT_LINK = "[[Recording 20261019093539]]";
const EMBED = `![[${FILENAME}]]`;

function stop(
	mode: StoppedRecording["mode"],
	line: number,
	ch: number,
): StoppedRecording {
	return {
		mode,
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(14_123_456),
		linkTarget: { kind: "cursor", snapshot: { filePath: MEETING_NOTE, line, ch } },
	};
}

function worldWith(kind: "hand-off" | "none"): FakeWorld {
	const world = makeFakeWorld();
	world.vault.seed(MEETING_NOTE, "Agenda\n\nNotes\n");
	world.currentSettings.transcribers.meeting.kind = kind;
	world.currentSettings.transcribers.cursor.kind = kind;
	return world;
}

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe("a meeting recording's stop writes the embed and the transcript link", () => {
	it("writes both on one line, the link right after the embed", async () => {
		const world = worldWith("hand-off");
		await new Lifecycle(world).recordingStopped(stop("meeting", 1, 0));
		assert.equal(
			await world.vault.read(MEETING_NOTE),
			`Agenda\n${EMBED} ${TRANSCRIPT_LINK}\nNotes\n`,
		);
	});

	it("writes them once, however many times the same stop runs", async () => {
		const world = worldWith("hand-off");
		const lifecycle = new Lifecycle(world);
		await lifecycle.recordingStopped(stop("meeting", 1, 0));
		const afterFirst = await world.vault.read(MEETING_NOTE);
		await lifecycle.recordingStopped(stop("meeting", 1, 0));
		const afterSecond = await world.vault.read(MEETING_NOTE);
		assert.equal(afterSecond, afterFirst);
		assert.equal(occurrences(afterSecond ?? "", EMBED), 1);
		assert.equal(occurrences(afterSecond ?? "", TRANSCRIPT_LINK), 1);
	});

	it("does not add the transcript link to a note that already holds the embed", async () => {
		const world = worldWith("hand-off");
		world.vault.seed(MEETING_NOTE, `Agenda\n${EMBED}\n`);
		await new Lifecycle(world).recordingStopped(stop("meeting", 0, 0));
		assert.equal(await world.vault.read(MEETING_NOTE), `Agenda\n${EMBED}\n`);
	});

	it("writes no transcript link when the meeting's transcriber is none", async () => {
		const world = worldWith("none");
		await new Lifecycle(world).recordingStopped(stop("meeting", 1, 0));
		assert.equal(await world.vault.read(MEETING_NOTE), `Agenda\n${EMBED}\nNotes\n`);
	});

	it("writes no transcript link when the transcript note could not be written", async () => {
		const world = worldWith("hand-off");
		const create = world.vault.create.bind(world.vault);
		world.vault.create = async (path, text) => {
			if (path.endsWith(".md")) throw new Error("disk full");
			await create(path, text);
		};
		const result = await new Lifecycle(world).recordingStopped(stop("meeting", 1, 0));
		assert.equal(await world.vault.read(MEETING_NOTE), `Agenda\n${EMBED}\nNotes\n`);
		assert.ok(result.messages.some((m) => m.includes("disk full")));
	});

	it("leaves a cursor-mode embed without a transcript link", async () => {
		const world = worldWith("hand-off");
		await new Lifecycle(world).recordingStopped(stop("cursor", 1, 0));
		assert.equal(await world.vault.read(MEETING_NOTE), `Agenda\n${EMBED}\nNotes\n`);
		assert.ok(world.vault.texts.has("Recording 20261019093539.md"));
	});
});
