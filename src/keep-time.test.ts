import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { FakeVault, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import {
	DAY_MS,
	KeepActions,
	KeepTime,
	ORDINARY_DEVICE_DELAY_MS,
	audioFate,
	audioLine,
	deletedEmbedWords,
	fateContextFor,
	keepOffers,
	keepTimeNeedsQuestion,
	keepTimeQuestion,
} from "./keep-time.js";
import {
	buildRequestNote,
	deriveState,
	formatTimestamp,
	markAgentRequested,
	markDone,
	markFailed,
	markCancelled,
	markTaken,
	markTryAgain,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

const AUDIO = "Recording 20261001090000.m4a";
const NOTE = "Recording 20261001090000.md";
const NOW = "2026-11-10T12:00:00+02:00";

/** A vault that notes what the transcript note said at the moment the audio was trashed. */
class WatchingVault extends FakeVault {
	readonly noteAtTrash: (string | null)[] = [];
	failTrash = false;
	constructor(private readonly watched: string) {
		super();
	}
	override async trash(path: string): Promise<void> {
		this.noteAtTrash.push(this.texts.get(this.watched) ?? null);
		if (this.failTrash) throw new Error("the trash is full");
		await super.trash(path);
	}
}

const at = (iso: string, daysAgo: number): string => {
	const t = new Date(new Date(iso).getTime() - daysAgo * DAY_MS);
	return formatTimestamp(t, 120);
};

interface NoteOptions {
	mode?: "daily-log" | "meeting";
	doneDaysAgo?: number;
	split?: boolean;
	state?: "done" | "done-without-speaker-split" | "taken" | "failed" | "cancelled" | "waiting";
	text?: string;
}

/** A transcript note in the state `options` describes, as text. */
function noteText(options: NoteOptions = {}): string {
	const meeting = options.mode === "meeting";
	let note: TranscriptNote = buildRequestNote({
		audio: AUDIO,
		audioBytes: 5000,
		mode: options.mode ?? "daily-log",
		recorded: at(NOW, (options.doneDaysAgo ?? 0) + 0.01),
		speakerSplit: options.split ?? meeting,
		attempt: 1,
	});
	const when = at(NOW, options.doneDaysAgo ?? 0);
	switch (options.state ?? "done") {
		case "done":
			note = markDone(markTaken(note, { name: "pc", at: when }), { at: when, seconds: 60, text: options.text ?? "Plain words." });
			break;
		case "done-without-speaker-split":
			note = markDone(markTaken(note, { name: "pc", at: when }), { at: when, seconds: 60, text: options.text ?? "Plain words.", withoutSpeakerSplit: true });
			break;
		case "taken":
			note = markTaken(note, { name: "pc", at: when });
			break;
		case "failed":
			note = markFailed(markTaken(note, { name: "pc", at: when }), { at: when, reason: "no" });
			break;
		case "cancelled":
			note = markCancelled(note);
			break;
		case "waiting":
			break;
	}
	return serializeTranscriptNote(note);
}

interface Rig {
	world: FakeWorld;
	vault: WatchingVault;
	keepTime: KeepTime;
	read(): TranscriptNote;
}

function rig(text: string | null, role: "ordinary" | "serving" = "serving", days: number | null = 30): Rig {
	const world = makeFakeWorld();
	const vault = new WatchingVault(NOTE);
	world.vault = vault;
	world.clock.set(NOW);
	world.device.deviceRole = role;
	world.currentSettings.keepTimeDays = days;
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	world.currentSettings.transcribers.meeting.kind = "hand-off";
	vault.binaries.set(AUDIO, 5000);
	if (text !== null) vault.seed(NOTE, text);
	const keepTime = new KeepTime({
		vault,
		clock: world.clock,
		device: world.device,
		settings: world.settings,
		resolveFile: (target) => (vault.binaries.has(target) ? target : null),
		exclusively: async (_path, fn) => ({ ran: true, value: await fn() }),
	});
	return {
		world,
		vault,
		keepTime,
		read: () => {
			const note = parseTranscriptNote(vault.texts.get(NOTE) ?? "");
			assert.ok(note);
			return note;
		},
	};
}

const tickAt = (r: Rig): ReturnType<KeepTime["tick"]> => r.keepTime.tick(r.world.clock.now());

describe("the keep time and what it deletes", () => {
	it("deletes the audio of a finished recording once the keep time has passed", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }));
		const result = await tickAt(r);
		assert.deepEqual(result.deleted, [NOTE]);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		assert.equal(readString(r.read(), "audio-deleted"), "2026-11-10");
	});

	it("leaves it before the keep time has passed", async () => {
		const r = rig(noteText({ doneDaysAgo: 29 }));
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(readString(r.read(), "audio-deleted"), undefined);
	});

	it("deletes nothing while the keep time is empty", async () => {
		const r = rig(noteText({ doneDaysAgo: 400 }), "serving", null);
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, []);
	});

	it("writes audio-deleted before it trashes the file", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }));
		await tickAt(r);
		assert.equal(r.vault.noteAtTrash.length, 1);
		assert.match(r.vault.noteAtTrash[0] ?? "", /\naudio-deleted: 2026-11-10\n/);
	});

	it("takes the line off again, and says so, when the trash fails", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }));
		r.vault.failTrash = true;
		const result = await tickAt(r);
		assert.deepEqual(result.deleted, []);
		assert.equal(result.failed.length, 1);
		assert.match(result.failed[0].message, /trash is full/);
		assert.equal(readString(r.read(), "audio-deleted"), undefined);
		assert.ok(r.vault.binaries.has(AUDIO));
	});

	it("does nothing for a recording that has no transcript note", async () => {
		const r = rig(null);
		const result = await tickAt(r);
		assert.deepEqual(result, { deleted: [], failed: [] });
		assert.deepEqual(r.vault.trashed, []);
		assert.ok(r.vault.binaries.has(AUDIO));
	});

	it("does not touch the note when the audio file is not in the vault (Sync has not delivered it)", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }));
		r.vault.binaries.delete(AUDIO);
		const result = await tickAt(r);
		assert.deepEqual(result.deleted, []);
		assert.equal(readString(r.read(), "audio-deleted"), undefined);
	});

	it("refuses, loudly, to trash a link that is not a recording", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }).replace(`[[${AUDIO}]]`, "[[Plans.md]]"));
		r.vault.texts.set("Plans.md", "my plans");
		const nonAudio = new KeepTime({
			vault: r.vault,
			clock: r.world.clock,
			device: r.world.device,
			settings: r.world.settings,
			resolveFile: (target) => (target === "Plans.md" ? target : null),
			exclusively: async (_path, fn) => ({ ran: true, value: await fn() }),
		});
		const result = await nonAudio.tick(r.world.clock.now());
		assert.equal(result.failed.length, 1);
		assert.match(result.failed[0].message, /not a recording/);
		assert.deepEqual(r.vault.trashed, []);
	});
});

describe("what holds the audio", () => {
	/** Whether a tick leaves the audio; `days` 0 makes everything with a done time due at once. */
	const held = async (text: string, setup?: (r: Rig) => void, days = 30): Promise<boolean> => {
		const r = rig(text, "serving", days);
		setup?.(r);
		await tickAt(r);
		return r.vault.trashed.length === 0;
	};
	const old = { doneDaysAgo: 40 } as const;

	it("keep-audio exempts one recording", async () => {
		const note = parseTranscriptNote(noteText(old));
		assert.ok(note);
		assert.equal(await held(serializeTranscriptNote(setProperty(note, "keep-audio", "true"))), true);
	});

	it("a recording waiting for its transcript", async () => {
		assert.equal(await held(noteText({ state: "waiting" }), undefined, 0), true);
	});

	it("a recording being transcribed, however short the keep time", async () => {
		assert.equal(await held(noteText({ state: "taken" }), undefined, 0), true);
	});

	it("a recording overdue, which is still being transcribed", async () => {
		assert.equal(await held(noteText({ ...old, state: "taken" }), undefined, 0), true);
	});

	it("a failed recording", async () => {
		assert.equal(await held(noteText({ state: "failed" }), undefined, 0), true);
	});

	it("a cancelled recording, even one that carries an old answer", async () => {
		const failedOnce = parseTranscriptNote(noteText({ state: "failed" }));
		assert.ok(failedOnce);
		assert.equal(await held(serializeTranscriptNote(markCancelled(failedOnce)), undefined, 0), true);
	});

	it("a split that was asked for and failed (a hand-off meeting done without split)", async () => {
		assert.equal(await held(noteText({ ...old, mode: "meeting", state: "done-without-speaker-split" })), true);
	});

	it("but a meeting a service answered, which never has a split, counts as done", async () => {
		const answered = parseTranscriptNote(noteText({ ...old, mode: "meeting", state: "done-without-speaker-split" }));
		assert.ok(answered);
		// A service takes a note in its device's name and id (`claimNote`); a program does not write the id.
		const r = rig(serializeTranscriptNote(setProperty(answered, "transcriber-device", "device-1")));
		r.world.currentSettings.transcribers.meeting.kind = "service";
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
	});

	it("a meeting a hand-off program answered without the split stays held after the mode is switched to a service", async () => {
		const r = rig(noteText({ ...old, mode: "meeting", state: "done-without-speaker-split" }));
		assert.equal(readString(r.read(), "transcriber"), "pc");
		r.world.currentSettings.transcribers.meeting.kind = "service";
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(readString(r.read(), "audio-deleted"), undefined);
	});

	it("a speaker still unnamed, until naming is finished", async () => {
		const text = "[00:00:01] **Speaker 1:** Hello.\n\n[00:00:09] **Speaker 2:** Hi.";
		const base = noteText({ ...old, mode: "meeting", state: "done", text });
		assert.equal(await held(base), true);
		const note = parseTranscriptNote(base);
		assert.ok(note);
		const finished = serializeTranscriptNote(setProperty(note, "naming", "finished"));
		assert.equal(await held(finished), false);
	});

	it("an agent that is still working is not a hold: the keep time means transcript and split", async () => {
		const note = parseTranscriptNote(noteText(old));
		assert.ok(note);
		assert.equal(await held(serializeTranscriptNote(markAgentRequested(note))), false);
	});
});

describe("the clock", () => {
	it("starts at the done time, not at the time of recording", () => {
		const note = parseTranscriptNote(noteText({ doneDaysAgo: 5 }).replace(/^recorded: .*$/m, `recorded: ${at(NOW, 90)}`));
		assert.ok(note);
		const fate = audioFate(note, deriveState(note, new Date(NOW), 24), { keepTimeDays: 30 });
		assert.equal(fate.kind, "goes");
		if (fate.kind === "goes") assert.equal(fate.atMs, new Date(at(NOW, 5)).getTime() + 30 * DAY_MS);
	});

	it("restarts on try again: the old answer stops counting, and the new one starts the clock", async () => {
		const r = rig(noteText({ doneDaysAgo: 31 }));
		const again = markTryAgain(r.read());
		r.vault.seed(NOTE, serializeTranscriptNote(again));
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [], "waiting again, so held");

		const taken = markTaken(again, { name: "pc", at: formatTimestamp(r.world.clock.now(), 120) });
		const done = markDone(taken, { at: formatTimestamp(r.world.clock.now(), 120), seconds: 9, text: "New text." });
		r.vault.seed(NOTE, serializeTranscriptNote(done));
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [], "the clock starts at the new done time");

		r.world.clock.advance(31 * DAY_MS);
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
	});
});

describe("which device deletes", () => {
	const notYetAnHour = { doneDaysAgo: 30 + 30 / 1440 };
	const overAnHour = { doneDaysAgo: 30 + (ORDINARY_DEVICE_DELAY_MS * 2) / DAY_MS };

	it("the serving device deletes as soon as the audio is due", async () => {
		const r = rig(noteText(notYetAnHour), "serving");
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
	});

	it("an ordinary desktop gives a serving device the first hour, then deletes", async () => {
		const early = rig(noteText(notYetAnHour), "ordinary");
		await tickAt(early);
		assert.deepEqual(early.vault.trashed, []);

		const late = rig(noteText(overAnHour), "ordinary");
		await tickAt(late);
		assert.deepEqual(late.vault.trashed, [AUDIO]);
	});

	it("a phone never deletes", async () => {
		const r = rig(noteText({ doneDaysAgo: 400 }), "ordinary");
		r.world.device.phone = true;
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, []);
	});

	it("a device that finds the line already written does nothing, even with the audio still there", async () => {
		const note = parseTranscriptNote(noteText({ doneDaysAgo: 400 }));
		assert.ok(note);
		const r = rig(serializeTranscriptNote(setProperty(note, "audio-deleted", "2026-11-09")));
		const result = await tickAt(r);
		assert.deepEqual(result, { deleted: [], failed: [] });
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(readString(r.read(), "audio-deleted"), "2026-11-09", "the written date is not overwritten");
	});

	it("two devices on one vault delete once", async () => {
		const first = rig(noteText({ doneDaysAgo: 31 }));
		await tickAt(first);
		const second = new KeepTime({
			vault: first.vault,
			clock: first.world.clock,
			device: first.world.device,
			settings: first.world.settings,
			resolveFile: () => AUDIO,
			exclusively: async (_path, fn) => ({ ran: true, value: await fn() }),
		});
		const result = await second.tick(first.world.clock.now());
		assert.deepEqual(result.deleted, []);
		assert.equal(first.vault.noteAtTrash.length, 1);
	});
});

describe("what the note says", () => {
	const offsetOf = () => 120;

	it("draws the date the audio will go: the done time plus the keep time", () => {
		const note = parseTranscriptNote(noteText({ doneDaysAgo: 5 }));
		assert.ok(note);
		const fate = audioFate(note, deriveState(note, new Date(NOW), 24), { keepTimeDays: 30 });
		assert.equal(audioLine(fate, offsetOf), "Audio will be deleted 2026-12-05");
	});

	it("draws the written date after the deletion, and the holding note says the transcript is kept", () => {
		const note = parseTranscriptNote(noteText());
		assert.ok(note);
		const gone = setProperty(note, "audio-deleted", "2026-11-02");
		const fate = audioFate(gone, deriveState(gone, new Date(NOW), 24), { keepTimeDays: null });
		assert.equal(audioLine(fate, offsetOf), "Audio deleted 2026-11-02");
		assert.equal(deletedEmbedWords("2026-11-02"), "Audio deleted 2026-11-02, transcript kept");
	});

	it("says nothing about the audio while the keep time is empty or the transcript is unfinished", () => {
		const waiting = parseTranscriptNote(noteText({ state: "waiting" }));
		assert.ok(waiting);
		const state = deriveState(waiting, new Date(NOW), 24);
		assert.equal(audioLine(audioFate(waiting, state, { keepTimeDays: null }), offsetOf), null);
		assert.equal(audioLine(audioFate(waiting, state, { keepTimeDays: 30 }), offsetOf), null);
	});

	it("names the hold the user can act on", () => {
		const note = parseTranscriptNote(noteText());
		assert.ok(note);
		const kept = setProperty(note, "keep-audio", "true");
		const fate = audioFate(kept, deriveState(kept, new Date(NOW), 24), fateContextFor(kept, makeFakeWorld().currentSettings));
		assert.deepEqual(fate, { kind: "off" }, "the default settings have no keep time");
		const withDays = audioFate(kept, deriveState(kept, new Date(NOW), 24), { keepTimeDays: 30 });
		assert.equal(audioLine(withDays, offsetOf), "Audio is kept: keep audio is set");
	});
});

describe("the settings question", () => {
	it("asks when the keep time is turned on or shortened, never when it is lengthened or emptied", () => {
		assert.equal(keepTimeNeedsQuestion(null, 30), true);
		assert.equal(keepTimeNeedsQuestion(30, 7), true);
		assert.equal(keepTimeNeedsQuestion(7, 30), false);
		assert.equal(keepTimeNeedsQuestion(30, 30), false);
		assert.equal(keepTimeNeedsQuestion(30, null), false);
	});

	it("names how many recordings lose their audio now", async () => {
		const r = rig(noteText({ doneDaysAgo: 10 }), "serving", null);
		assert.equal(await r.keepTime.countLosingAudioNow(7, r.world.clock.now()), 1);
		assert.equal(await r.keepTime.countLosingAudioNow(30, r.world.clock.now()), 0);
		assert.match(keepTimeQuestion(7, 1), /1 recording loses its audio now/);
		assert.match(keepTimeQuestion(7, 12), /12 recordings lose their audio now/);
		assert.match(keepTimeQuestion(7, 12), /7 days/);
	});
});

describe("keep audio and delete audio on one recording", () => {
	function actions(r: Rig, answer = { yes: true }) {
		const asked: string[] = [];
		const keep = new KeepActions({
			vault: r.vault,
			clock: r.world.clock,
			settings: r.world.settings,
			resolveFile: (target) => (r.vault.binaries.has(target) ? target : null),
			exclusively: async (_path, step) => ({ ran: true, value: await step() }),
			whenFree: (_path, run) => run(),
			tell: () => {},
			confirm: async (question) => {
				asked.push(question);
				return answer.yes;
			},
			refresh: async () => {},
			notesLinkingTo: () => ["2026-10-01"],
		});
		return { keep, asked };
	}

	it("keep audio exempts the recording from the keep time, and can be taken off again", async () => {
		const r = rig(noteText({ doneDaysAgo: 40 }));
		const { keep } = actions(r);
		assert.equal((await keep.setKeepAudio(NOTE, true)).changed, true);
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, []);
		await keep.setKeepAudio(NOTE, false);
		await tickAt(r);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
	});

	it("offers keep and delete before the audio is gone, and nothing after", () => {
		const note = parseTranscriptNote(noteText());
		assert.ok(note);
		assert.deepEqual(keepOffers(note).map((o) => o.action), ["keep-audio", "delete-audio"]);
		assert.deepEqual(keepOffers(setProperty(note, "keep-audio", "true")).map((o) => o.action), ["release-audio", "delete-audio"]);
		assert.deepEqual(keepOffers(setProperty(note, "audio-deleted", "2026-11-02")), []);
	});

	it("delete audio asks once, naming the file and the notes that link to it, and then deletes it", async () => {
		const r = rig(noteText());
		const { keep, asked } = actions(r);
		const result = await keep.deleteAudio(NOTE);
		assert.equal(result.changed, true);
		assert.equal(asked.length, 1);
		assert.ok(asked[0].includes(AUDIO) && asked[0].includes("2026-10-01"));
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		assert.equal(readString(r.read(), "audio-deleted"), "2026-11-10");
		assert.equal(readString(r.read(), "transcribe"), "requested", "a finished recording is not cancelled");
	});

	it("a no leaves the audio and the note as they were", async () => {
		const r = rig(noteText());
		const before = r.vault.texts.get(NOTE);
		const { keep } = actions(r, { yes: false });
		assert.equal((await keep.deleteAudio(NOTE)).changed, false);
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(r.vault.texts.get(NOTE), before);
	});

	it("deleting by hand a recording still in the queue asks, deletes, and leaves it cancelled", async () => {
		const r = rig(noteText({ state: "waiting" }));
		const { keep, asked } = actions(r);
		await keep.deleteAudio(NOTE);
		assert.match(asked[0], /cancelled too/);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		const note = r.read();
		assert.equal(readString(note, "transcribe"), "cancelled");
		assert.equal(readString(note, "audio-deleted"), "2026-11-10");
		assert.equal(deriveState(note, r.world.clock.now(), 24).transcriber, "cancelled");
	});
});
