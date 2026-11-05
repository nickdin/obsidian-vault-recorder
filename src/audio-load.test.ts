import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { loadRecording, resolveRecording, type LoadableAudio } from "./audio-load.js";
import { parseTranscriptNote, type TranscriptNote } from "./transcript-note.js";

/** An audio element that loads or fails when the test says so, and counts how often its source was set. */
class FakeAudio extends EventTarget {
	dataset: DOMStringMap = {};
	preload = "";
	readyState = 0;
	error: MediaError | null = null;
	sourcesSet = 0;
	private source = "";

	get src(): string {
		return this.source;
	}
	set src(value: string) {
		this.source = value;
		this.sourcesSet += 1;
	}
	pause(): void {}

	/** The file could not be read. */
	fail(message: string): void {
		this.error = { message } as MediaError;
		this.dispatchEvent(new Event("error"));
	}
	/** The file arrived and its length is known. */
	arrive(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("loadedmetadata"));
	}
}

describe("a recording that cannot be played gives a notice and loads nothing", () => {
	const noteWith = (...lines: string[]): TranscriptNote => {
		const note = parseTranscriptNote(
			["---", "rule-version: 1", ...lines, "attempt: 1", "transcribe: requested", "---", ""].join("\n"),
		);
		assert.ok(note);
		return note;
	};

	it("says the audio was deleted, with the date, and never looks the file up", () => {
		let lookups = 0;
		const found = resolveRecording(noteWith('audio: "[[Recording 1.m4a]]"', "audio-deleted: 2026-11-02"), () => {
			lookups += 1;
			return "file";
		});
		assert.ok("problem" in found);
		assert.match(found.problem, /audio was deleted 2026-11-02/);
		assert.equal(lookups, 0);
	});

	it("says the recording is not in the vault when its file is missing", () => {
		const found = resolveRecording(noteWith('audio: "[[Recording 1.m4a|alias]]"'), () => null);
		assert.ok("problem" in found);
		assert.match(found.problem, /The recording Recording 1\.m4a is not in the vault/);
	});

	it("says so when the note names no recording", () => {
		const found = resolveRecording(noteWith(), () => "file");
		assert.ok("problem" in found);
		assert.match(found.problem, /does not name its recording/);
	});

	it("hands back the file, looked up by the link's target, when there is one", () => {
		const asked: string[] = [];
		const found = resolveRecording(noteWith('audio: "[[Recording 1.m4a#t=3|alias]]"'), (target) => {
			asked.push(target);
			return "the file";
		});
		assert.deepEqual(found, { file: "the file" });
		assert.deepEqual(asked, ["Recording 1.m4a"]);
	});
});

const asLoadable =(fake: FakeAudio): LoadableAudio => fake as unknown as LoadableAudio;

describe("a recording that failed to load", () => {
	it("is loaded again on the next click, and plays once the file has arrived", async () => {
		const audio = new FakeAudio();
		const first = loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		audio.fail("not found");
		await assert.rejects(first, /could not be read/);
		assert.equal(audio.sourcesSet, 1);

		const second = loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		assert.equal(audio.sourcesSet, 2, "the source was set again");
		audio.arrive();
		await second;
	});

	it("is loaded again after the wait ran out", async () => {
		const audio = new FakeAudio();
		await assert.rejects(loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 5), /did not load/);
		const again = loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		assert.equal(audio.sourcesSet, 2);
		audio.arrive();
		await again;
	});

	it("does not reload a recording that is loading or loaded", async () => {
		const audio = new FakeAudio();
		const first = loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		audio.arrive();
		await first;
		await loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		assert.equal(audio.sourcesSet, 1, "a second click on the same recording keeps the file");
	});

	it("switches to another recording when asked for one", async () => {
		const audio = new FakeAudio();
		audio.readyState = 1;
		await loadRecording(asLoadable(audio), "Recording 1.m4a", "app://1", 50);
		await loadRecording(asLoadable(audio), "Recording 2.m4a", "app://2", 50);
		assert.equal(audio.src, "app://2");
	});
});
