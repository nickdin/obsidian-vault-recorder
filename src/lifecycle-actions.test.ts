import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type Adapters } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions, TRY_AGAIN_NAMES_LOST, TRY_AGAIN_NAMING_CLEARED,TRY_AGAIN_QUESTION, tryAgainQuestion } from "./lifecycle-actions.js";
import { turnsIn, unnamedCount } from "./naming.js";
import {
	markDone,
	markFailed,
	formatTurn,
	markTaken,
	markAgentDone,
	markAgentRequested,
	markAgentWorking,
	parseTranscriptNote,
	readInteger,
	readList,
	readString,
	deriveState,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

const AUDIO = "Recording 20261019091200.m4a";
const NOTE = "Recording 20261019091200.md";

const REQUEST = `---
rule-version: 1
audio: "[[${AUDIO}]]"
audio-bytes: 2314752
mode: daily-log
recorded: 2026-10-19T09:12:00+02:00
linked-from: "[[2026-10-19]]"
speaker-split: false
attempt: 1
transcribe: requested
---
`;

const parse = (text: string | null): TranscriptNote => {
	const note = parseTranscriptNote(text ?? "");
	assert.ok(note, "a transcript note");
	return note;
};

interface Setup {
	world: FakeWorld;
	lifecycle: Lifecycle;
	asked: string[];
	actions: RecordingActions;
	answer: { yes: boolean; during?: () => void };
}

function setup(noteText: string | null = REQUEST, adapters?: Adapters, refreshWith: "tick" | "look" = "tick"): Setup {
	const world = makeFakeWorld();
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	if (noteText !== null) world.vault.seed(NOTE, noteText);
	const lifecycle = new Lifecycle(world, adapters);
	const asked: string[] = [];
	const answer: { yes: boolean; during?: () => void } = { yes: true };
	const actions = new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: (path, step) => lifecycle.exclusively(path, step),
		noteProperties: world.noteProperties,
		confirm: async (question) => {
			asked.push(question);
			answer.during?.();
			return answer.yes;
		},
		// "look" is main.ts's wiring: redraw what is on disk, dispatch nothing.
		refresh: (path) =>
			refreshWith === "look" ? lifecycle.look(path, world.clock.now()) : lifecycle.tick(world.clock.now()),
	});
	return { world, lifecycle, asked, actions, answer };
}

const stateOf = (s: Setup, hours = 24) =>
	deriveState(parse(s.world.vault.texts.get(NOTE) ?? null), s.world.clock.now(), hours);

const rewrite = (s: Setup, change: (note: TranscriptNote) => TranscriptNote): void => {
	s.world.vault.texts.set(NOTE, serialize(change(parse(s.world.vault.texts.get(NOTE) ?? null))));
};
import { serializeTranscriptNote as serialize } from "./transcript-note.js";

const AT = "2026-10-19T09:14:20+02:00";
const taken = (n: TranscriptNote) => markTaken(n, { name: "program", at: AT });
const done = (n: TranscriptNote) =>
	markDone(n, { at: AT, seconds: 98, text: "Remember to ask Anna about the budget." });

describe("the questions' wording", () => {
	// Spec #69, user story 24: "I want 'try again' to ask before replacing a
	// transcript that already has text, and to tell me names and the agent's
	// answer will be redone, so that my corrections are not lost silently."
	it("try again asks before replacing, and says names and the agent's answer will be redone (user story 24)", () => {
		assert.match(TRY_AGAIN_QUESTION, /replaces/);
		assert.match(TRY_AGAIN_QUESTION, /speaker names/);
		assert.match(TRY_AGAIN_QUESTION, /agent's answer/);
		assert.match(TRY_AGAIN_QUESTION, /redone/);
		assert.ok(TRY_AGAIN_QUESTION.endsWith("?"), "it is a question");
	});

	// Spec #69, user story 25: "have it leave the queue marked cancelled with a
	// way to ask again".
	it("the cancel notice says the note stays and it can be asked again (user story 25)", async () => {
		const s = setup();
		const result = await s.actions.cancel(NOTE);
		assert.match(result.message, /Cancelled/);
		assert.match(result.message, /note stays/);
		assert.match(result.message, /asks again/);
	});
});

describe("cancel", () => {
	it("on a waiting recording writes transcribe: cancelled and keeps the note", async () => {
		const s = setup();
		const result = await s.actions.cancel(NOTE);
		assert.equal(result.changed, true);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "transcribe"), "cancelled");
		assert.equal(stateOf(s).transcriber, "cancelled");
	});

	it("on a taken recording writes transcribe: cancelled and keeps the program's lines", async () => {
		const s = setup();
		rewrite(s, taken);
		assert.equal(stateOf(s).transcriber, "being-transcribed");
		await s.actions.cancel(NOTE);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "transcribe"), "cancelled");
		assert.equal(readString(note, "transcriber-state"), "taken");
		assert.equal(stateOf(s).transcriber, "cancelled");
	});

	it("leaves a finished recording alone", async () => {
		const s = setup();
		rewrite(s, done);
		const before = s.world.vault.texts.get(NOTE);
		const result = await s.actions.cancel(NOTE);
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});

	it("keeps a transcript that lands after the cancel, and shows it done", async () => {
		const s = setup();
		await s.actions.cancel(NOTE);
		rewrite(s, done);
		assert.equal(stateOf(s).transcriber, "done");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriber, "done");
		assert.match(s.world.vault.texts.get(NOTE) ?? "", /ask Anna about the budget/);
	});
});

describe("try again", () => {
	it("on a failed recording raises the attempt, asks for nothing and makes it wait", async () => {
		const s = setup();
		rewrite(s, (n) => markFailed(taken(n), { at: AT, reason: "the audio could not be decoded" }));
		const result = await s.actions.tryAgain(NOTE);
		assert.equal(result.changed, true);
		assert.deepEqual(s.asked, []);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readInteger(note, "attempt"), 2);
		assert.equal(readString(note, "transcribe"), "requested");
		assert.equal(stateOf(s).transcriber, "waiting");
	});

	it("on a note with text asks first, in the spec's words, and leaves the text until the program answers", async () => {
		const s = setup();
		rewrite(s, (n) => done(taken(n)));
		await s.actions.tryAgain(NOTE);
		assert.deepEqual(s.asked, [TRY_AGAIN_QUESTION]);
		assert.match(TRY_AGAIN_QUESTION, /names/);
		assert.match(TRY_AGAIN_QUESTION, /agent's answer/);
		const text = s.world.vault.texts.get(NOTE) ?? "";
		assert.match(text, /ask Anna about the budget/);
		assert.equal(readInteger(parse(text), "attempt"), 2);
		assert.equal(stateOf(s).transcriber, "waiting");
	});

	it("on a note with text writes nothing when the answer is no", async () => {
		const s = setup();
		rewrite(s, (n) => done(taken(n)));
		const before = s.world.vault.texts.get(NOTE);
		s.answer.yes = false;
		const result = await s.actions.tryAgain(NOTE);
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});

	it("keeps what was written to the note while the question was open", async () => {
		const s = setup();
		rewrite(s, (n) => done(taken(n)));
		// The person's own correction, typed in another pane while the dialog is open.
		s.answer.during = () => rewrite(s, (n) => setProperty(n, "corrected-by-hand", "yes"));
		await s.actions.tryAgain(NOTE);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "corrected-by-hand"), "yes");
		assert.equal(readInteger(note, "attempt"), 2);
	});

	it("is not offered once the audio is deleted", async () => {
		const s = setup();
		rewrite(s, (n) => markFailed(taken(n), { at: AT, reason: "x" }));
		rewrite(s, (n) => setProperty(n, "audio-deleted", "2026-11-02"));
		assert.equal(stateOf(s).transcriber, "failed");
		const before = s.world.vault.texts.get(NOTE);
		const result = await s.actions.tryAgain(NOTE);
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});
});

describe("transcribe", () => {
	it("creates a request for an older recording that has none", async () => {
		const s = setup(null);
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "2026-10-19.md" });
		assert.equal(result.changed, true);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "transcribe"), "requested");
		assert.equal(readInteger(note, "attempt"), 1);
		assert.equal(readInteger(note, "audio-bytes"), 2_314_752);
		assert.equal(readString(note, "mode"), "daily-log");
		assert.equal(readString(note, "recorded"), "2026-10-19T09:12:00+02:00");
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriber, "waiting");
	});

	it("re-requests a cancelled recording", async () => {
		const s = setup();
		await s.actions.cancel(NOTE);
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(result.changed, true);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "transcribe"), "requested");
		assert.equal(readInteger(note, "attempt"), 2);
		assert.equal(stateOf(s).transcriber, "waiting");
	});

	it("leaves a recording that already has a request alone", async () => {
		const s = setup();
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		const before = s.world.vault.texts.get(NOTE);
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});

	it("refuses a file that is not a recording: an image or a PDF gets no request", async () => {
		const s = setup(null);
		for (const path of ["Pictures/photo.png", "scan.pdf"]) {
			s.world.vault.binaries.set(path, 1_000);
			const result = await s.actions.transcribe(path);
			assert.equal(result.changed, false, path);
			assert.match(result.message, /not a recording/);
		}
		assert.equal(s.world.vault.texts.size, 0);
	});

	it("makes no request when the mode has no transcriber", async () => {
		const s = setup(null);
		s.world.currentSettings.transcribers.dailyLog.kind = "none";
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.has(NOTE), false);
	});
});

describe("transcribe by hand takes the request the recording would have had at stop", () => {
	// A transcript note another recording in the same note already has: its
	// `mode` says what kind of note the recordings in it were made in.
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
	const older = (): Setup => {
		const s = setup(null);
		s.world.currentSettings.transcribers.meeting.kind = "hand-off";
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		return s;
	};
	const written = (s: Setup): TranscriptNote => parse(s.world.vault.texts.get(NOTE) ?? null);

	it("an embed in a meeting note gets the meeting transcriber, speaker splitting and the note's participants", async () => {
		const s = older();
		s.world.vault.seed("Recording 20261019080000.md", sibling("meeting", "Standup"));
		s.world.noteProperties.set("Meetings/Standup.md", "participants", ["Anna", "Bo"]);
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "Meetings/Standup.md" });
		assert.equal(result.changed, true);
		const note = written(s);
		assert.equal(readString(note, "mode"), "meeting");
		assert.equal(readString(note, "speaker-split"), "true");
		assert.deepEqual(readList(note, "participants"), ["Anna", "Bo"]);
		assert.equal(readString(note, "linked-from"), "[[Standup]]");
	});

	it("an embed in a daily log gets the daily-log request, with no notice about a guess", async () => {
		const s = older();
		s.world.vault.seed("Recording 20261019080000.md", sibling("daily-log", "2026-10-19"));
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "2026-10-19.md" });
		assert.equal(result.changed, true);
		const note = written(s);
		assert.equal(readString(note, "mode"), "daily-log");
		assert.equal(readString(note, "speaker-split"), "false");
		assert.equal(readList(note, "participants"), undefined);
		assert.doesNotMatch(result.message, /daily log/i);
	});

	it("a recording found in no note gets the daily-log request and a notice that says why", async () => {
		const s = older();
		const result = await s.actions.transcribe(AUDIO);
		assert.equal(result.changed, true);
		assert.equal(readString(written(s), "mode"), "daily-log");
		assert.match(result.message, /not .*in any note/);
		assert.match(result.message, /daily log/);
	});

	it("a note whose other recordings have several modes gets the daily-log request and a notice that says why", async () => {
		const s = older();
		s.world.vault.seed("Recording 20261019080000.md", sibling("meeting", "Mixed"));
		s.world.vault.seed("Recording 20261019081000.md", sibling("cursor", "Mixed"));
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "Mixed.md" });
		assert.equal(readString(written(s), "mode"), "daily-log");
		assert.match(result.message, /different modes/);
	});

	it("a note whose recordings are all in other notes counts as having none", async () => {
		const s = older();
		s.world.vault.seed("Recording 20261019080000.md", sibling("meeting", "Elsewhere"));
		const result = await s.actions.transcribe(AUDIO, { linkedFrom: "Mine.md" });
		assert.equal(readString(written(s), "mode"), "daily-log");
		assert.match(result.message, /no other recording/);
	});
});

describe("overdue", () => {
	// Recorded 09:12 +02:00; the overdue time is 24 hours by default.
	it("flips just after the set hours for a waiting recording, not before", async () => {
		const s = setup();
		s.world.clock.set("2026-10-20T09:12:00+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, false);
		s.world.clock.set("2026-10-20T09:12:01+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, true);
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriber, "waiting");
	});

	it("follows the overdueHours setting", async () => {
		const s = setup();
		s.world.currentSettings.overdueHours = 2;
		s.world.clock.set("2026-10-19T11:13:00+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, true);
	});

	it("flips for a taken recording that has not changed, counted from the take", async () => {
		const s = setup();
		rewrite(s, taken);
		s.world.clock.set("2026-10-20T09:14:20+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, false);
		s.world.clock.set("2026-10-20T09:14:21+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		const status = s.lifecycle.statusOf(NOTE)?.state;
		assert.equal(status?.transcriber, "being-transcribed");
		assert.equal(status?.transcriberOverdue, true);
	});

	it("stays in the queue and clears when the program writes", async () => {
		const s = setup();
		s.world.clock.set("2026-10-22T09:00:00+02:00");
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, true);
		rewrite(s, (n) => markTaken(n, { name: "program", at: "2026-10-22T09:00:00+02:00" }));
		await s.lifecycle.tick(s.world.clock.now());
		assert.ok(s.lifecycle.statusOf(NOTE), "still known to the queue");
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriberOverdue, false);
	});
});

/** Adapters whose hand-off transcriber's tick never returns, like a long model run. */
function heldAdapters(): Adapters {
	const base = defaultAdapters();
	return {
		...base,
		transcribers: {
			...base.transcribers,
			"hand-off": { ...base.transcribers["hand-off"]!, tick: () => new Promise<void>(() => {}) },
		},
	};
}

/** Resolves with the promise's value, or "held" if it has not settled after `ms`. */
async function settlesWithin<T>(promise: Promise<T>, ms = 200): Promise<T | "held"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const held = new Promise<"held">((resolve) => {
		timer = setTimeout(() => resolve("held"), ms);
	});
	try {
		return await Promise.race([promise, held]);
	} finally {
		clearTimeout(timer);
	}
}

describe("an action does not wait for a transcription", () => {
	it("try again answers and redraws while the transcriber's tick is held open", async () => {
		const s = setup(REQUEST, heldAdapters(), "look");
		rewrite(s, (n) => markFailed(taken(n), { at: AT, reason: "x" }));
		const result = await settlesWithin(s.actions.tryAgain(NOTE));
		assert.notEqual(result, "held", "the action answered before the transcription finished");
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriber, "waiting");
	});

	it("transcribe answers and shows the new note while the transcriber's tick is held open", async () => {
		const s = setup(null, heldAdapters(), "look");
		s.world.vault.binaries.set(AUDIO, 2_314_752);
		const result = await settlesWithin(s.actions.transcribe(AUDIO));
		assert.notEqual(result, "held", "the action answered before the transcription finished");
		assert.equal(s.lifecycle.statusOf(NOTE)?.state.transcriber, "waiting");
	});
});

describe("naming speakers", () => {
	const turnsText = [formatTurn(2, "Speaker 1", "Hello."), formatTurn(9, "Speaker 2", "Hi.")].join("\n\n");
	const named = (s: Setup): void => rewrite(s, (n) => markDone(n, { at: AT, seconds: 20, text: turnsText }));
	const labelsOnDisk = (s: Setup): string[] =>
		turnsIn(parse(s.world.vault.texts.get(NOTE) ?? null).body).map((t) => t.label);

	it("writes the chosen name over the label throughout the note on disk", async () => {
		const s = setup();
		named(s);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "[[Anna Svensson]]");
		assert.equal(result.changed, true);
		assert.deepEqual(labelsOnDisk(s), ["Speaker 1", "[[Anna Svensson]]"]);
	});

	it("says so when the label has gone, and writes nothing", async () => {
		const s = setup();
		named(s);
		const before = s.world.vault.texts.get(NOTE);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 7", "Bo");
		assert.equal(result.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});

	it("leaving the rest unnamed writes naming: finished and the count falls to nothing", async () => {
		const s = setup();
		named(s);
		await s.actions.leaveUnnamed(NOTE);
		const note = parse(s.world.vault.texts.get(NOTE) ?? null);
		assert.equal(readString(note, "naming"), "finished");
		assert.equal(unnamedCount(note), 0);
		assert.deepEqual(labelsOnDisk(s), ["Speaker 1", "Speaker 2"], "the text is left as it was");
	});

	it("has nothing to leave when no speaker is unnamed", async () => {
		const s = setup();
		const result = await s.actions.leaveUnnamed(NOTE);
		assert.equal(result.changed, false);
	});

	it("try again removes naming: finished and asks with the names-lost warning", async () => {
		const s = setup();
		named(s);
		await s.actions.leaveUnnamed(NOTE);
		await s.actions.tryAgain(NOTE);
		assert.equal(readString(parse(s.world.vault.texts.get(NOTE) ?? null), "naming"), undefined);
		assert.equal(s.asked.length, 1);
		assert.ok(s.asked[0].includes(TRY_AGAIN_NAMING_CLEARED));
		assert.ok(!s.asked[0].includes(TRY_AGAIN_NAMES_LOST), "no speaker was named, so no name is lost");
		assert.ok(s.asked[0].endsWith("Try again?"), "the question is still the last thing asked");
		assert.equal(readInteger(parse(s.world.vault.texts.get(NOTE) ?? null), "attempt"), 2);
	});

	it("try again keeps naming: finished when the user says no", async () => {
		const s = setup();
		named(s);
		await s.actions.leaveUnnamed(NOTE);
		s.answer.yes = false;
		await s.actions.tryAgain(NOTE);
		assert.equal(readString(parse(s.world.vault.texts.get(NOTE) ?? null), "naming"), "finished");
	});

	it("asks the plain question when no names were given", () => {
		const s = setup();
		named(s);
		assert.equal(tryAgainQuestion(parse(s.world.vault.texts.get(NOTE) ?? null)), TRY_AGAIN_QUESTION);
	});

	it("names the first unnamed speaker for the list to start with", async () => {
		const s = setup();
		named(s);
		assert.deepEqual(await s.actions.firstUnnamed(NOTE), { label: "Speaker 1" });
		await s.actions.nameSpeaker(NOTE, "Speaker 1", "Bo");
		assert.deepEqual(await s.actions.firstUnnamed(NOTE), { label: "Speaker 2" });
		await s.actions.nameSpeaker(NOTE, "Speaker 2", "Cy");
		assert.deepEqual(await s.actions.firstUnnamed(NOTE), { notice: "Every speaker in this note is named" });
	});
});

describe("naming waits for text that is about to be replaced or added", () => {
	const turnsText = [formatTurn(2, "Speaker 1", "Hello."), formatTurn(9, "Speaker 2", "Hi.")].join("\n\n");
	const named = (s: Setup): void => rewrite(s, (n) => markDone(n, { at: AT, seconds: 20, text: turnsText }));
	const onDisk = (s: Setup): string => s.world.vault.texts.get(NOTE) ?? "";

	it("refuses during try again, with a notice that says why, and writes nothing", async () => {
		const s = setup();
		named(s);
		await s.actions.tryAgain(NOTE);
		const before = onDisk(s);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
		assert.equal(result.changed, false);
		assert.match(result.message, /transcript/i);
		assert.match(result.message, /wait/i);
		assert.equal(onDisk(s), before);
	});

	it("refuses while the transcriber is working on the note", async () => {
		const s = setup();
		named(s);
		await s.actions.tryAgain(NOTE);
		rewrite(s, taken);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
		assert.equal(result.changed, false);
	});

	it("refuses while the agent is answering, asked or working, and writes nothing", async () => {
		for (const working of [false, true]) {
			const s = setup();
			named(s);
			rewrite(s, (n) => {
				const asked = markAgentRequested(n);
				return working ? markAgentWorking(asked, { name: "agent", at: AT }) : asked;
			});
			const before = onDisk(s);
			const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
			assert.equal(result.changed, false, working ? "working" : "asked");
			assert.match(result.message, /agent/i);
			assert.equal(onDisk(s), before);
		}
	});

	it("says the same before the list opens, so no name is picked in vain", async () => {
		const s = setup();
		named(s);
		await s.actions.tryAgain(NOTE);
		assert.match((await s.actions.whyNotNaming(NOTE)) ?? "", /transcript/i);
	});

	it("names again once the agent has answered", async () => {
		const s = setup();
		named(s);
		rewrite(s, (n) => markAgentDone(markAgentRequested(n), { at: AT, text: "Speaker 2 agreed." }));
		assert.equal(await s.actions.whyNotNaming(NOTE), null);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
		assert.equal(result.changed, true);
		assert.ok(onDisk(s).includes("Anna agreed."));
	});
});

describe("Name speakers on a note that cannot be read", () => {
	it("hands the reason to the caller instead of saying every speaker is named", async () => {
		const s = setup(null);
		const missing = await s.actions.firstUnnamed(NOTE);
		assert.ok("notice" in missing);
		assert.match(missing.notice, /no note at/);
		assert.doesNotMatch(missing.notice, /Every speaker/);

		s.world.vault.seed(NOTE, "not a transcript note\n");
		const notTranscript = await s.actions.firstUnnamed(NOTE);
		assert.ok("notice" in notTranscript);
		assert.match(notTranscript.notice, /not a transcript note/);
		assert.doesNotMatch(notTranscript.notice, /Every speaker/);
	});
});

describe("try again's warning is true whoever named the speakers", () => {
	const turnsText = [formatTurn(2, "Anna", "Hello."), formatTurn(9, "Bo", "Hi.")].join("\n\n");
	const noteTexts = (s: Setup): TranscriptNote => parse(s.world.vault.texts.get(NOTE) ?? null);

	it("warns about names a transcriber wrote without claiming the user gave them", () => {
		const s = setup();
		rewrite(s, (n) => markDone(n, { at: AT, seconds: 20, text: turnsText }));
		const question = tryAgainQuestion(noteTexts(s));
		assert.ok(question.includes(TRY_AGAIN_NAMES_LOST), "the warning is there");
		assert.match(question, /transcriber wrote/);
		assert.doesNotMatch(question, /leave the rest unnamed/i, "that was never said, so it is not cleared");
		assert.ok(question.endsWith("Try again?"));
	});

	it("mentions the cleared “leave the rest unnamed” only when it was said", () => {
		const s = setup();
		rewrite(s, (n) => setProperty(markDone(n, { at: AT, seconds: 20, text: turnsText }), "naming", "finished"));
		assert.match(tryAgainQuestion(noteTexts(s)), /leave the rest unnamed/i);
	});

	it("the plain question does not claim names were given", () => {
		assert.doesNotMatch(TRY_AGAIN_QUESTION, /you gave/);
	});

	it("does not say names will be lost after saying they will be redone", () => {
		const s = setup();
		rewrite(s, (n) => markDone(n, { at: AT, seconds: 20, text: turnsText }));
		assert.doesNotMatch(tryAgainQuestion(noteTexts(s)), /redone[^?]*lost/);
	});
});

void audioOfSize;
