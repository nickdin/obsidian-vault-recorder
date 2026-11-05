import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	MIN_AUDIO_BYTES,
	Lifecycle,
	defaultAdapters,
	type Adapters,
	type NoteStatusChange,
	type StoppedRecording,
	type TranscriberAdapter,
} from "./lifecycle.js";
import {
	FakeClock,
	FakeVault,
	audioOfSize,
	makeFakeWorld,
	type FakeWorld,
} from "./lifecycle-fakes.js";
import { insertRecordingLink } from "./note-insert.js";
import {
	markCancelled,
	markDone,
	markTaken,
	parseTranscriptNote,
	serializeTranscriptNote,
} from "./transcript-note.js";
import { DEFAULT_SETTINGS, type TranscriberEntry } from "./settings-data.js";

const FILENAME = "Recording 20261019093539.m4a";
const DAILY_LOG = "Journal/2026-10-19.md";
const GOOD_AUDIO = 20_000;
// The note-insert module owns the notes heading and its Swedish spelling; the
// tests here ask it what the daily log should become instead of repeating it.
const DAILY_LOG_BEFORE = "Earlier thought.\n";

function dailyStop(overrides: Partial<StoppedRecording> = {}): StoppedRecording {
	return {
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(GOOD_AUDIO),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
		...overrides,
	};
}

function worldWithDailyLog(): { world: FakeWorld; lifecycle: Lifecycle } {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
	return { world, lifecycle: new Lifecycle(world) };
}

describe("recordingStopped: what is kept", () => {
	it("keeps nothing from a silent recording, and says so", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		const result = await lifecycle.recordingStopped(dailyStop({ peak: 0.01 }));
		assert.equal(result.outcome, "silent");
		assert.deepEqual(result.messages, ["The recording was silent — no file saved"]);
		assert.deepEqual(world.vault.created, []);
	});

	it("keeps nothing from a header-only blob, and says so", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		const result = await lifecycle.recordingStopped(
			dailyStop({ audio: audioOfSize(MIN_AUDIO_BYTES - 1) }),
		);
		assert.equal(result.outcome, "too-short");
		assert.deepEqual(result.messages, [
			"The recording was too short or too quiet — no file saved",
		]);
		assert.deepEqual(world.vault.created, []);
	});

	it("keeps a recording exactly at the size limit", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		const result = await lifecycle.recordingStopped(
			dailyStop({ audio: audioOfSize(MIN_AUDIO_BYTES) }),
		);
		assert.equal(result.outcome, "saved");
		assert.equal(world.vault.binaries.get(FILENAME), MIN_AUDIO_BYTES);
	});
});

describe("recordingStopped: where it goes and what links to it", () => {
	it("saves the audio at the top of the vault when no folder is set anywhere", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.audioPath, FILENAME);
		assert.equal(world.vault.binaries.get(FILENAME), GOOD_AUDIO);
	});

	it("saves into the audio folder setting, creating the folder", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		world.currentSettings.audioFolder = "/x/Recordings/";
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.audioPath, `x/Recordings/${FILENAME}`);
		assert.ok(world.vault.folders.has("x/Recordings"));
	});

	it("saves at the top of the vault when the audio folder is typed as a slash, whatever Obsidian's setting", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		world.currentSettings.audioFolder = "/";
		world.vault.attachmentFolder = "Attachments";
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.audioPath, FILENAME);
	});

	it("falls back to Obsidian's attachment folder when the setting is empty", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		world.vault.attachmentFolder = "Attachments";
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.audioPath, `Attachments/${FILENAME}`);
	});

	it("links the recording from the daily log through the notes section", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		await lifecycle.recordingStopped(dailyStop());
		const linked = await world.vault.read(DAILY_LOG);
		assert.equal(linked, insertRecordingLink(DAILY_LOG_BEFORE, FILENAME, DEFAULT_SETTINGS.notesHeading));
		assert.ok(linked?.includes(`![[${FILENAME}]]`));
	});

	it("puts a cursor-mode link at the cursor", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Notes/Idea.md", "first\nsecond\n");
		const lifecycle = new Lifecycle(world);
		await lifecycle.recordingStopped({
			mode: "cursor",
			filename: FILENAME,
			peak: 0.3,
			audio: audioOfSize(GOOD_AUDIO),
			linkTarget: {
				kind: "cursor",
				snapshot: { filePath: "Notes/Idea.md", line: 1, ch: 3 },
			},
		});
		assert.equal(
			await world.vault.read("Notes/Idea.md"),
			`first\nsec![[${FILENAME}]]ond\n`,
		);
	});

	it("tells the user when the cursor's line has gone and the link went to the end", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Notes/Idea.md", "only line\n");
		const lifecycle = new Lifecycle(world);
		const result = await lifecycle.recordingStopped({
			mode: "meeting",
			filename: FILENAME,
			peak: 0.3,
			audio: audioOfSize(GOOD_AUDIO),
			linkTarget: {
				kind: "cursor",
				snapshot: { filePath: "Notes/Idea.md", line: 9, ch: 0 },
			},
		});
		assert.equal(await world.vault.read("Notes/Idea.md"), `only line\n![[${FILENAME}]]\n`);
		assert.deepEqual(result.messages, [
			"The cursor position is no longer valid — the link was added at the end of the file",
			`Recording saved: ${FILENAME}`,
		]);
	});

	it("saves the audio and says it is unlinked when the daily log is gone", async () => {
		const world = makeFakeWorld();
		const lifecycle = new Lifecycle(world);
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.outcome, "saved");
		assert.equal(world.vault.binaries.get(FILENAME), GOOD_AUDIO);
		assert.equal(
			result.messages[0],
			"The daily log could not be found at stop — the recording was saved but not linked",
		);
	});

	it("is safe to run again for the same recording: one audio file, one link", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		await lifecycle.recordingStopped(dailyStop());
		const afterFirst = await world.vault.read(DAILY_LOG);
		await lifecycle.recordingStopped(dailyStop());
		assert.equal(await world.vault.read(DAILY_LOG), afterFirst);
		assert.deepEqual(world.vault.created, [FILENAME]);
	});

	it("refuses to replace an existing file of the same name with different audio in a typed folder", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		world.currentSettings.audioFolder = "Recordings";
		await world.vault.createBinary(`Recordings/${FILENAME}`, audioOfSize(GOOD_AUDIO + 1));
		await assert.rejects(lifecycle.recordingStopped(dailyStop()), /already exists/);
	});

	it("saves beside a different file of the same name under Obsidian's suffix, and links that name", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		await world.vault.createBinary(FILENAME, audioOfSize(GOOD_AUDIO + 1));
		const suffixed = "Recording 20261019093539 1.m4a";
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.audioPath, suffixed);
		assert.equal(world.vault.binaries.get(suffixed), GOOD_AUDIO);
		assert.equal(world.vault.binaries.get(FILENAME), GOOD_AUDIO + 1);
		assert.equal(await world.vault.read(DAILY_LOG), insertRecordingLink(DAILY_LOG_BEFORE, suffixed, DEFAULT_SETTINGS.notesHeading));
		assert.deepEqual(result.messages, [`Recording saved: ${suffixed}`]);
	});

	it("saves a cursor recording beside its note when Obsidian's attachment setting is ./", async () => {
		const world = makeFakeWorld();
		world.vault.attachmentFolder = "./";
		world.vault.seed("Projects/Sub/Idea.md", "first\n");
		const lifecycle = new Lifecycle(world);
		const result = await lifecycle.recordingStopped({
			mode: "cursor",
			filename: FILENAME,
			peak: 0.3,
			audio: audioOfSize(GOOD_AUDIO),
			linkTarget: { kind: "cursor", snapshot: { filePath: "Projects/Sub/Idea.md", line: 0, ch: 5 } },
		});
		assert.equal(result.audioPath, `Projects/Sub/${FILENAME}`);
		assert.equal(world.vault.binaries.get(`Projects/Sub/${FILENAME}`), GOOD_AUDIO);
		assert.ok(world.vault.folders.has("Projects/Sub"));
	});
});

// --- The hand-off transcriber at stop -------------------------------------------------------

const NOTE_PATH = "Recording 20261019093539.md";
const handOff = (world: FakeWorld, mode: "dailyLog" | "cursor" | "meeting"): void => {
	world.currentSettings.transcribers[mode].kind = "hand-off";
};

function meetingStop(): StoppedRecording {
	return {
		mode: "meeting",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(14_123_456),
		linkTarget: {
			kind: "cursor",
			snapshot: { filePath: "Meetings/2026-10-19 Planning.md", line: 0, ch: 0 },
		},
	};
}

describe("recordingStopped with a hand-off transcriber", () => {
	it("leaves a daily-log request beside the audio, with only the properties that apply", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		handOff(world, "dailyLog");
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.transcriptNotePath, NOTE_PATH);
		assert.equal(
			await world.vault.read(NOTE_PATH),
			[
				"---",
				"rule-version: 1",
				`audio: "[[${FILENAME}]]"`,
				`audio-bytes: ${GOOD_AUDIO}`,
				"mode: daily-log",
				"recorded: 2026-10-19T09:35:39+02:00",
				'linked-from: "[[2026-10-19]]"',
				"speaker-split: false",
				"attempt: 1",
				"transcribe: requested",
				"transcribe-kind: hand-off",
				"---",
				"",
			].join("\n"),
		);
	});

	it("asks a meeting for a speaker split and copies participants, owner and language", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Meetings/2026-10-19 Planning.md", "Agenda\n");
		world.noteProperties.set("Meetings/2026-10-19 Planning.md", "participants", [
			"[[Anna Svensson]]",
			"Bo Berg",
		]);
		world.currentSettings.ownerName = "[[Robin Example]]";
		world.currentSettings.language = "sv";
		handOff(world, "meeting");
		await new Lifecycle(world).recordingStopped(meetingStop());
		assert.equal(
			await world.vault.read(NOTE_PATH),
			[
				"---",
				"rule-version: 1",
				`audio: "[[${FILENAME}]]"`,
				"audio-bytes: 14123456",
				"mode: meeting",
				"recorded: 2026-10-19T09:35:39+02:00",
				'linked-from: "[[2026-10-19 Planning]]"',
				"speaker-split: true",
				'participants: ["[[Anna Svensson]]", "Bo Berg"]',
				'owner: "[[Robin Example]]"',
				'language: "sv"',
				"attempt: 1",
				"transcribe: requested",
				"transcribe-kind: hand-off",
				"---",
				"",
			].join("\n"),
		);
	});

	it("leaves out owner, language and participants when there are none to give", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Meetings/2026-10-19 Planning.md", "Agenda\n");
		world.noteProperties.set("Meetings/2026-10-19 Planning.md", "participants", []);
		handOff(world, "meeting"); // ownerName "" and language "detect" are the defaults
		await new Lifecycle(world).recordingStopped(meetingStop());
		const written = (await world.vault.read(NOTE_PATH)) ?? "";
		for (const key of ["participants:", "owner:", "language:"]) {
			assert.ok(!written.includes(key), `${key} should be absent`);
		}
		assert.ok(written.includes("speaker-split: true"));
	});

	it("reads the participants from the property the setting names", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Meetings/2026-10-19 Planning.md", "Agenda\n");
		world.currentSettings.participantsProperty = "attendees";
		world.noteProperties.set("Meetings/2026-10-19 Planning.md", "participants", ["Wrong"]);
		world.noteProperties.set("Meetings/2026-10-19 Planning.md", "attendees", ["Right"]);
		handOff(world, "meeting");
		await new Lifecycle(world).recordingStopped(meetingStop());
		assert.ok((await world.vault.read(NOTE_PATH))?.includes('participants: ["Right"]'));
	});

	it("does not ask for a speaker split in cursor mode", async () => {
		const world = makeFakeWorld();
		world.vault.seed("Notes/Idea.md", "first\n");
		handOff(world, "cursor");
		await new Lifecycle(world).recordingStopped({
			...meetingStop(),
			mode: "cursor",
			linkTarget: { kind: "cursor", snapshot: { filePath: "Notes/Idea.md", line: 0, ch: 0 } },
		});
		const written = (await world.vault.read(NOTE_PATH)) ?? "";
		assert.ok(written.includes("mode: cursor"));
		assert.ok(written.includes("speaker-split: false"));
	});

	it("writes the stop time in the clock's own zone, not the machine's", async () => {
		const { world } = worldWithDailyLog();
		const clock = new FakeClock("2026-10-19T09:35:39-05:00", -300);
		const lifecycle = new Lifecycle({ ...world, clock });
		handOff(world, "dailyLog");
		await lifecycle.recordingStopped(dailyStop());
		assert.ok((await world.vault.read(NOTE_PATH))?.includes("recorded: 2026-10-19T09:35:39-05:00"));
	});

	it("puts the note in the transcript folder when one is set, and beside the audio when not", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		handOff(world, "dailyLog");
		world.currentSettings.audioFolder = "x/Recordings";
		await lifecycle.recordingStopped(dailyStop());
		assert.ok(await world.vault.read(`x/Recordings/${NOTE_PATH}`));

		const second = worldWithDailyLog();
		handOff(second.world, "dailyLog");
		second.world.currentSettings.transcriptFolder = "/x/Transcripts/";
		const result = await second.lifecycle.recordingStopped(dailyStop());
		assert.equal(result.transcriptNotePath, `x/Transcripts/${NOTE_PATH}`);
		assert.ok(second.world.vault.folders.has("x/Transcripts"));
	});

	it("creates no note with 'none' chosen, as before", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.transcriptNotePath, undefined);
		assert.deepEqual(world.vault.created, [FILENAME]);
		assert.deepEqual(await world.vault.listTranscriptNotes(), []);
	});

	it("creates no note for a recording that is not kept", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		handOff(world, "dailyLog");
		await lifecycle.recordingStopped(dailyStop({ peak: 0 }));
		assert.deepEqual(world.vault.created, []);
	});

	it("is idempotent: a second stop with the same name leaves the note as it is, answer and all", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		handOff(world, "dailyLog");
		await lifecycle.recordingStopped(dailyStop());
		const asked = parseTranscriptNote((await world.vault.read(NOTE_PATH)) ?? "");
		assert.ok(asked);
		const answered = markDone(
			markTaken(asked, { name: "a program", at: "2026-10-19T09:36:00+02:00" }),
			{ at: "2026-10-19T09:40:00+02:00", seconds: 5, text: "Hello." },
		);
		await world.vault.write(NOTE_PATH, serializeTranscriptNote(answered));

		const second = await lifecycle.recordingStopped(dailyStop());
		assert.equal(second.outcome, "saved");
		assert.equal(second.transcriptNotePath, undefined);
		assert.deepEqual(second.messages, [`Recording saved: ${FILENAME}`]);
		assert.equal(await world.vault.read(NOTE_PATH), serializeTranscriptNote(answered));
		assert.deepEqual(world.vault.created, [FILENAME, NOTE_PATH]);
	});

	it("keeps the recording and says so when the request cannot be written", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		const vault = new (class extends FakeVault {
			override async create(path: string, text: string): Promise<void> {
				if (path.endsWith(".md")) throw new Error("disk full");
				return super.create(path, text);
			}
		})();
		vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		const lifecycle = new Lifecycle({ ...world, vault });
		handOff(world, "dailyLog");
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.outcome, "saved");
		assert.equal(vault.binaries.get(FILENAME), GOOD_AUDIO);
		assert.ok(result.messages.some((m) => m.includes("transcript request could not be written: disk full")));
		assert.equal(result.messages.at(-1), `Recording saved: ${FILENAME}`);
	});

	it("still writes the request, and says the link failed, when the link cannot be written", async () => {
		const world = makeFakeWorld();
		const vault = new (class extends FakeVault {
			override async write(path: string, text: string): Promise<void> {
				if (path === DAILY_LOG) throw new Error("file is locked");
				return super.write(path, text);
			}
		})();
		vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		const lifecycle = new Lifecycle({ ...world, vault });
		handOff(world, "dailyLog");
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.equal(result.outcome, "saved");
		assert.equal(vault.binaries.get(FILENAME), GOOD_AUDIO);
		assert.equal(result.transcriptNotePath, NOTE_PATH);
		assert.notEqual(await vault.read(NOTE_PATH), null);
		assert.ok(result.messages.some((m) => m.includes("not linked: file is locked")));
		assert.equal(result.messages.at(-1), `Recording saved: ${FILENAME}`);
	});

	it("says so when the chosen kind has no adapter, and writes no request", async () => {
		const { world, lifecycle } = worldWithDailyLog();
		world.currentSettings.transcribers.dailyLog.kind = "service";
		const result = await lifecycle.recordingStopped(dailyStop());
		assert.ok(result.messages.some((m) => m.includes("No transcriber of kind 'service'")));
		assert.equal(result.transcriptNotePath, undefined);
	});
});

// --- Looking at the notes: tick ------------------------------------------------------------------

describe("tick", () => {
	async function worldWithRequest(): Promise<{ world: FakeWorld; lifecycle: Lifecycle }> {
		const { world, lifecycle } = worldWithDailyLog();
		handOff(world, "dailyLog");
		await lifecycle.recordingStopped(dailyStop());
		return { world, lifecycle };
	}

	it("knows a request as waiting from the moment it is written", async () => {
		const { lifecycle } = await worldWithRequest();
		const status = lifecycle.statusOf(NOTE_PATH);
		assert.equal(status?.state.transcriber, "waiting");
		assert.equal(status?.state.transcriberOverdue, false);
		assert.equal(status?.waitingReason, null);
	});

	it("marks a waiting request overdue on the clock it is given, and says so to listeners once", async () => {
		const { lifecycle } = await worldWithRequest();
		const changes: NoteStatusChange[] = [];
		lifecycle.onNoteStateChanged((change) => changes.push(change));
		const heard = (): number => changes.length;

		await lifecycle.tick(new Date("2026-10-19T20:00:00+02:00"));
		assert.equal(heard(), 0);

		await lifecycle.tick(new Date("2026-10-20T09:36:00+02:00"));
		await lifecycle.tick(new Date("2026-10-20T09:37:00+02:00"));
		assert.equal(heard(), 1);
		assert.equal(changes[0].previous?.state.transcriberOverdue, false);
		assert.equal(changes[0].current?.state.transcriberOverdue, true);
	});

	it("tells listeners when a program takes and finishes the request, and when the note goes", async () => {
		const { world, lifecycle } = await worldWithRequest();
		const seen: string[] = [];
		const stop = lifecycle.onNoteStateChanged((change) =>
			seen.push(change.current?.state.transcriber ?? "gone"),
		);
		const now = new Date("2026-10-19T10:00:00+02:00");
		const asked = parseTranscriptNote((await world.vault.read(NOTE_PATH)) ?? "");
		assert.ok(asked);
		const taken = markTaken(asked, { name: "a program", at: "2026-10-19T09:36:00+02:00" });
		await world.vault.write(NOTE_PATH, serializeTranscriptNote(taken));
		await lifecycle.tick(now);
		await world.vault.write(
			NOTE_PATH,
			serializeTranscriptNote(markDone(taken, { at: "2026-10-19T09:40:00+02:00", seconds: 1, text: "t" })),
		);
		await lifecycle.tick(now);
		await world.vault.trash(NOTE_PATH);
		await lifecycle.tick(now);
		assert.deepEqual(seen, ["being-transcribed", "done", "gone"]);
		stop();
		await world.vault.create(NOTE_PATH, "---\nrule-version: 1\nattempt: 1\n---\n");
		await lifecycle.tick(now);
		assert.deepEqual(seen, ["being-transcribed", "done", "gone"]);
	});

	it("shows a cancel as cancelled", async () => {
		const { world, lifecycle } = await worldWithRequest();
		const asked = parseTranscriptNote((await world.vault.read(NOTE_PATH)) ?? "");
		assert.ok(asked);
		await world.vault.write(NOTE_PATH, serializeTranscriptNote(markCancelled(asked)));
		await lifecycle.tick(world.clock.now());
		assert.equal(lifecycle.statusOf(NOTE_PATH)?.state.transcriber, "cancelled");
	});

	it("looks at a note by its properties, not its folder, and ignores one that is not the plugin's", async () => {
		const { world, lifecycle } = await worldWithRequest();
		await world.vault.create("Elsewhere/Other.md", "---\ntranscribe: requested\n---\n");
		// listed as a candidate but with no rule-version in its properties:
		await world.vault.create("Elsewhere/Odd.md", "---\nrule-version: 1\n");
		await lifecycle.tick(world.clock.now());
		assert.deepEqual(lifecycle.statuses().map((s) => s.path), [NOTE_PATH]);
	});

	it("goes on past a note that cannot be handled, and says so on the console", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		handOff(world, "dailyLog");
		const boom: TranscriberAdapter = {
			kind: "hand-off",
			requestsTranscriptNote: true,
			waitingReason: () => null,
			tick: async ({ path }) => {
				if (path === "Recording 20261019093539.md") throw new Error("boom");
			},
		};
		const adapters: Adapters = { ...defaultAdapters(), transcribers: { "hand-off": boom, none: defaultAdapters().transcribers.none } };
		const lifecycle = new Lifecycle(world, adapters);
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.recordingStopped(dailyStop({ filename: "Recording 20261019093540.m4a" }));
		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void logged.push(args);
		try {
			await lifecycle.tick(world.clock.now());
		} finally {
			console.error = original;
		}
		assert.equal(logged.length, 1);
		assert.equal(lifecycle.statuses().length, 2);
	});
});

describe("adapters by kind", () => {
	const service = (reason: string | null, calls: string[]): TranscriberAdapter => ({
		kind: "service",
		requestsTranscriptNote: true,
		waitingReason: (_note, entry: TranscriberEntry) => (reason === null ? null : `${reason} (${entry.kind})`),
		tick: async ({ path, mode }) => void calls.push(`${mode}:${path}`),
	});

	it("hands a note to the adapter its mode has chosen, and to no other", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		world.vault.seed("Notes/Idea.md", "x\n");
		const calls: string[] = [];
		const lifecycle = new Lifecycle(world, {
			...defaultAdapters(),
			transcribers: { ...defaultAdapters().transcribers, service: service(null, calls) },
		});
		world.currentSettings.transcribers.dailyLog.kind = "service";
		world.currentSettings.transcribers.cursor.kind = "hand-off";
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.recordingStopped({
			mode: "cursor",
			filename: "Recording 20261019093541.m4a",
			peak: 0.3,
			audio: audioOfSize(GOOD_AUDIO),
			linkTarget: { kind: "cursor", snapshot: { filePath: "Notes/Idea.md", line: 0, ch: 0 } },
		});
		await lifecycle.tick(world.clock.now());
		assert.deepEqual(calls, [`dailyLog:${NOTE_PATH}`]);
	});

	it("exposes the adapter's waiting reason for a waiting note, and only a waiting one", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, DAILY_LOG_BEFORE);
		const lifecycle = new Lifecycle(world, {
			...defaultAdapters(),
			transcribers: {
				...defaultAdapters().transcribers,
				service: service("model not on this device", []),
			},
		});
		world.currentSettings.transcribers.dailyLog.kind = "service";
		await lifecycle.recordingStopped(dailyStop());
		assert.equal(lifecycle.statusOf(NOTE_PATH)?.waitingReason, "model not on this device (service)");

		const asked = parseTranscriptNote((await world.vault.read(NOTE_PATH)) ?? "");
		assert.ok(asked);
		await world.vault.write(
			NOTE_PATH,
			serializeTranscriptNote(markTaken(asked, { name: "x", at: "2026-10-19T09:36:00+02:00" })),
		);
		await lifecycle.tick(world.clock.now());
		assert.equal(lifecycle.statusOf(NOTE_PATH)?.waitingReason, null);
	});
});
