import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	GROUPS,
	ProgressMemory,
	buildQueue,
	timeLeftMs,
	timeLeftWords,
	type QueueGroup,
	type QueueNote,
} from "./queue-model.js";
import { formatTurn, parseTranscriptNote, setProperty } from "./transcript-note.js";
import type { DrawClock } from "./state-line.js";
import { DEFAULT_SETTINGS, type VaultRecorderSettings } from "./settings-data.js";

const OVERDUE_HOURS = 24;
const clockAt = (now: string): DrawClock => ({ now: new Date(now), utcOffsetMinutes: () => 120 });
const NOW = "2026-10-19T14:00:00+02:00";

/** A transcript note of rule 1 with the given extra property lines. */
function noteAt(path: string, lines: string[], waitingReason: string | null = null): QueueNote {
	const text = [
		"---",
		"rule-version: 1",
		`audio: "[[${path.replace(/\.md$/, ".m4a")}]]"`,
		"mode: daily-log",
		"attempt: 1",
		...(lines.some((line) => line.startsWith("transcribe:")) ? [] : ["transcribe: requested"]),
		...lines,
		"---",
		"",
	].join("\n");
	const note = parseTranscriptNote(text);
	assert.ok(note, `${path} parses`);
	return { path, note, waitingReason };
}

const waiting = (name: string, recorded: string): QueueNote =>
	noteAt(`${name}.md`, [`recorded: ${recorded}`]);
const taken = (name: string, takenAt: string, percent?: number): QueueNote =>
	noteAt(`${name}.md`, [
		`recorded: ${takenAt}`,
		"transcriber: home-pc",
		"transcriber-state: taken",
		`transcriber-at: ${takenAt}`,
		"transcriber-attempt: 1",
		...(percent === undefined ? [] : [`transcriber-progress: ${percent}`]),
	]);
const answered = (name: string, state: string, at: string, extra: string[] = []): QueueNote =>
	noteAt(`${name}.md`, [
		"recorded: 2026-10-19T06:00:00+02:00",
		"transcriber: home-pc",
		`transcriber-state: ${state}`,
		`transcriber-at: ${at}`,
		"transcriber-attempt: 1",
		...extra,
	]);

function queue(
	notes: QueueNote[],
	memory = new ProgressMemory(),
	now = NOW,
	settings: VaultRecorderSettings = DEFAULT_SETTINGS,
): QueueGroup[] {
	return buildQueue({ notes, clock: clockAt(now), overdueHours: OVERDUE_HOURS, progress: memory, settings });
}
const idsOf = (groups: QueueGroup[]): string[] => groups.map((g) => g.id);
const pathsIn = (groups: QueueGroup[], id: string): string[] =>
	groups.find((g) => g.id === id)?.rows.map((r) => r.path) ?? [];

describe("the queue's groups", () => {
	it("puts a waiting, a taken and a failed note each in its own group", () => {
		const groups = queue([
			waiting("a", "2026-10-19T13:00:00+02:00"),
			taken("b", "2026-10-19T13:30:00+02:00", 40),
			answered("c", "failed", "2026-10-19T13:40:00+02:00", ['transcriber-reason: "no speech"']),
		]);
		assert.deepEqual(idsOf(groups), ["waiting", "being-transcribed", "failed"]);
		assert.deepEqual(pathsIn(groups, "waiting"), ["a.md"]);
		assert.deepEqual(pathsIn(groups, "being-transcribed"), ["b.md"]);
		assert.deepEqual(pathsIn(groups, "failed"), ["c.md"]);
	});

	it("shows the groups in the spec's order and leaves empty ones out", () => {
		const groups = queue([
			answered("done-old", "done", "2026-10-19T13:00:00+02:00"),
			noteAt("cancelled.md", ["recorded: 2026-10-19T12:00:00+02:00", "transcribe: cancelled"]),
			answered("nosplit", "done-without-speaker-split", "2026-10-19T12:30:00+02:00"),
			waiting("overdue", "2026-10-17T08:00:00+02:00"),
			answered("failed", "failed", "2026-10-19T12:45:00+02:00"),
			taken("taken", "2026-10-19T13:00:00+02:00", 10),
			waiting("waits", "2026-10-19T13:00:00+02:00"),
		]);
		assert.deepEqual(idsOf(groups), [
			"waiting",
			"being-transcribed",
			"overdue",
			"failed",
			"done-without-speaker-split",
			"cancelled",
			"finished-last-day",
		]);
		assert.deepEqual(idsOf(queue([])), []);
	});

	it("shows a row in one group only: overdue waiting is overdue, not waiting", () => {
		const groups = queue([
			waiting("late", "2026-10-17T08:00:00+02:00"),
			waiting("fresh", "2026-10-19T13:00:00+02:00"),
		]);
		assert.deepEqual(pathsIn(groups, "overdue"), ["late.md"]);
		assert.deepEqual(pathsIn(groups, "waiting"), ["fresh.md"]);
	});

	it("keeps an overdue note being transcribed in overdue", () => {
		const groups = queue([taken("stuck", "2026-10-17T08:00:00+02:00", 30)]);
		assert.deepEqual(idsOf(groups), ["overdue"]);
	});

	it("lists a done note only for 24 hours after it finished", () => {
		const groups = queue([
			answered("recent", "done", "2026-10-18T14:30:00+02:00"),
			answered("old", "done", "2026-10-18T13:30:00+02:00"),
		]);
		assert.deepEqual(pathsIn(groups, "finished-last-day"), ["recent.md"]);
	});

	it("leaves out a note whose rule version this plugin does not know", () => {
		const unknown = noteAt("v9.md", ["recorded: 2026-10-19T12:00:00+02:00"]);
		unknown.note = parseTranscriptNote(
			"---\nrule-version: 9\naudio: \"[[v9.m4a]]\"\n---\n",
		)!;
		assert.deepEqual(queue([unknown]), []);
	});

	it("is one table a later ticket can add a row to: every group has an id, a title and a rule", () => {
		for (const group of GROUPS) {
			assert.ok(group.id && group.title && typeof group.claims === "function");
		}
		assert.equal(new Set(GROUPS.map((g) => g.id)).size, GROUPS.length);
	});
});

describe("the order and the place in line", () => {
	it("orders waiting oldest first and numbers the place in line from 1", () => {
		const groups = queue([
			waiting("third", "2026-10-19T13:30:00+02:00"),
			waiting("first", "2026-10-19T11:00:00+02:00"),
			waiting("second", "2026-10-19T12:00:00+02:00"),
		]);
		const rows = groups.find((g) => g.id === "waiting")!.rows;
		assert.deepEqual(
			rows.map((r) => [r.path, r.placeInLine]),
			[
				["first.md", 1],
				["second.md", 2],
				["third.md", 3],
			],
		);
	});

	it("counts an overdue waiting note ahead of newer ones in the place in line", () => {
		const groups = queue([
			waiting("fresh", "2026-10-19T13:00:00+02:00"),
			waiting("late", "2026-10-17T08:00:00+02:00"),
		]);
		assert.equal(groups.find((g) => g.id === "overdue")!.rows[0].placeInLine, 1);
		assert.equal(groups.find((g) => g.id === "waiting")!.rows[0].placeInLine, 2);
	});

	it("gives a note that is not waiting no place in line", () => {
		const rows = queue([taken("b", "2026-10-19T13:30:00+02:00", 40)])[0].rows;
		assert.equal(rows[0].placeInLine, null);
	});

	it("orders finished and failed newest first", () => {
		const groups = queue([
			answered("older", "failed", "2026-10-19T10:00:00+02:00"),
			answered("newer", "failed", "2026-10-19T12:00:00+02:00"),
		]);
		assert.deepEqual(pathsIn(groups, "failed"), ["newer.md", "older.md"]);
	});
});

describe("the time left", () => {
	const at = (minutes: number): number => Date.UTC(2026, 9, 19, 12, minutes);

	it("works out the time left from two progress readings", () => {
		// 20 % in 10 minutes: the remaining 60 % takes 30 minutes.
		assert.equal(
			timeLeftMs({ percent: 20, atMs: at(0) }, { percent: 40, atMs: at(10) }),
			30 * 60_000,
		);
		// 40 % in 20 minutes: the remaining 50 % takes 25 minutes.
		assert.equal(
			timeLeftMs({ percent: 10, atMs: at(0) }, { percent: 50, atMs: at(20) }),
			25 * 60_000,
		);
	});

	it("says nothing when the readings cannot tell", () => {
		assert.equal(timeLeftMs({ percent: 40, atMs: at(0) }, { percent: 40, atMs: at(10) }), null);
		assert.equal(timeLeftMs({ percent: 20, atMs: at(0) }, { percent: 10, atMs: at(10) }), null);
		assert.equal(timeLeftMs({ percent: 20, atMs: at(5) }, { percent: 40, atMs: at(5) }), null);
		assert.equal(timeLeftMs({ percent: 20, atMs: at(0) }, { percent: 100, atMs: at(10) }), null);
	});

	it("writes the estimate in words", () => {
		assert.equal(timeLeftWords(20_000), "less than a minute left");
		assert.equal(timeLeftWords(12 * 60_000), "about 12 min left");
		assert.equal(timeLeftWords(12.6 * 60_000), "about 13 min left");
		assert.equal(timeLeftWords(120 * 60_000), "about 2 h left");
		assert.equal(timeLeftWords(125 * 60_000), "about 2 h 5 min left");
	});

	it("gets the estimate for a note being transcribed from the moment it was taken and the percentage now", () => {
		// Taken at 13:00, 40 % at 14:00: 40 % per hour, 60 % left is 90 minutes.
		const rows = queue([taken("b", "2026-10-19T13:00:00+02:00", 40)])[0].rows;
		assert.equal(rows[0].percent, 40);
		assert.equal(rows[0].timeLeftMs, 90 * 60_000);
	});

	it("uses the second reading the panel took once the percentage moved", () => {
		const memory = new ProgressMemory();
		const first = queue([taken("b", "2026-10-19T13:00:00+02:00", 20)], memory, NOW)[0].rows[0];
		assert.equal(first.timeLeftMs, 4 * 60 * 60_000); // 20 % in an hour
		// Half an hour later it reads 60 %: from 0 % at 13:00 that is 60 % in 90 minutes.
		const later = queue(
			[taken("b", "2026-10-19T13:00:00+02:00", 60)],
			memory,
			"2026-10-19T14:30:00+02:00",
		)[0].rows[0];
		assert.equal(later.timeLeftMs, 60 * 60_000);
	});

	it("does not move the estimate while the percentage stands still", () => {
		const memory = new ProgressMemory();
		queue([taken("b", "2026-10-19T13:00:00+02:00", 40)], memory, NOW);
		const again = queue(
			[taken("b", "2026-10-19T13:00:00+02:00", 40)],
			memory,
			"2026-10-19T14:20:00+02:00",
		)[0].rows[0];
		assert.equal(again.timeLeftMs, 90 * 60_000);
	});

	it("starts over for a note taken again", () => {
		const memory = new ProgressMemory();
		queue([taken("b", "2026-10-19T13:00:00+02:00", 20)], memory, NOW);
		// Taken again at 13:50 and 30 % at 14:00: 30 % in 10 minutes, so 70 % is 23⅓ minutes.
		// (A memory that kept the first take would divide 30 % by the hour since 13:00.)
		const retaken = queue(
			[taken("b", "2026-10-19T13:50:00+02:00", 30)],
			memory,
			"2026-10-19T14:00:00+02:00",
		)[0].rows[0];
		assert.equal(retaken.timeLeftMs, Math.round((70 * 10 * 60_000) / 30));
	});

	it("shows a note taken with no progress yet at 0 % and no estimate", () => {
		const row = queue([taken("b", "2026-10-19T13:00:00+02:00")])[0].rows[0];
		assert.equal(row.percent, 0);
		assert.equal(row.timeLeftMs, null);
	});
});

describe("the actions on a row", () => {
	it("offers cancel on a waiting row, try again on a failed one, transcribe on a cancelled one", () => {
		const groups = queue([
			waiting("w", "2026-10-19T13:00:00+02:00"),
			answered("f", "failed", "2026-10-19T13:00:00+02:00"),
			noteAt("c.md", ["recorded: 2026-10-19T12:00:00+02:00", "transcribe: cancelled"]),
		]);
		const offered = (id: string): string[] =>
			groups.find((g) => g.id === id)!.rows[0].offers.map((o) => o.action);
		// #84: "Keep audio" and "delete audio" exist as actions in the panel on every row whose audio is there.
		assert.deepEqual(offered("waiting"), ["cancel", "keep-audio", "delete-audio"]);
		assert.deepEqual(offered("failed"), ["try-again", "keep-audio", "delete-audio"]);
		assert.deepEqual(offered("cancelled"), ["transcribe", "keep-audio", "delete-audio"]);
	});

	it("says why try again is missing once the audio is deleted", () => {
		const row = queue([
			answered("gone", "failed", "2026-10-19T13:00:00+02:00", ["audio-deleted: 2026-10-19"]),
		])[0].rows[0];
		assert.deepEqual(row.offers, []);
		assert.match(row.notOffered ?? "", /audio was deleted 2026-10-19/);
	});

	it("carries the state line the note shows, with the waiting reason", () => {
		const row = queue([
			noteAt("w.md", ["recorded: 2026-10-19T13:00:00+02:00"], "no key on this device"),
		])[0].rows[0];
		assert.equal(row.line, "waiting since 13:00 — no key on this device");
		assert.equal(row.title, "w");
	});
});

describe("the group \"speakers unnamed\"", () => {
	const turns = (...speakers: string[]): QueueNote["note"]["body"] =>
		"\n## Transcript\n\n" + speakers.map((s, i) => formatTurn(i * 10, s, "Words.")).join("\n\n") + "\n";
	const doneWith = (name: string, speakers: string[], extra: string[] = []): QueueNote => {
		const made = answered(name, "done", "2026-10-19T13:00:00+02:00", extra);
		return { ...made, note: { ...made.note, body: turns(...speakers) } };
	};

	it("is a row of the table, before the finished group so a transcript with unnamed speakers is not shown twice", () => {
		const ids = GROUPS.map((g) => g.id);
		assert.ok(ids.includes("speakers-unnamed"));
		assert.ok(ids.indexOf("speakers-unnamed") < ids.indexOf("finished-last-day"));
	});

	it("lists a finished transcript that still has a Speaker N, and not under finished", () => {
		const groups = queue([doneWith("m", ["Speaker 1", "Speaker 2"])]);
		assert.deepEqual(idsOf(groups), ["speakers-unnamed"]);
		const row = groups[0].rows[0];
		assert.equal(row.unnamed, 2);
		assert.deepEqual(row.offers.map((o) => o.action), [
			"try-again",
			"name-speakers",
			"leave-unnamed",
			"keep-audio",
			"delete-audio",
		]);
	});

	it("moves to the finished group once every speaker is named", () => {
		const groups = queue([doneWith("m", ["Bo Berg", "[[Anna Svensson]]"])]);
		assert.deepEqual(idsOf(groups), ["finished-last-day"]);
	});

	it("leaves the group when the user says to leave the rest unnamed", () => {
		const groups = queue([doneWith("m", ["Speaker 1"], ["naming: finished"])]);
		assert.deepEqual(idsOf(groups), ["finished-last-day"]);
		assert.equal(groups[0].rows[0].unnamed, 0);
	});

	// #142. The spec's § 6 lists both groups and does not say which owns a note that is both.
	// Chosen: "speakers unnamed", because it holds the to-do the user can act on; the row's
	// own state line still says the speaker split failed.
	it("owns a note done without speaker split that still has a Speaker N", () => {
		const made = answered("ns", "done-without-speaker-split", "2026-10-19T13:00:00+02:00");
		const groups = queue([{ ...made, note: { ...made.note, body: turns("Speaker 1") } }]);
		assert.deepEqual(idsOf(groups), ["speakers-unnamed"]);
		const row = groups[0].rows[0];
		assert.equal(row.unnamed, 1);
		assert.match(row.line, /without speaker split/);
	});

	it("keeps a note done without speaker split in its own group when no Speaker N is left", () => {
		const made = answered("ns", "done-without-speaker-split", "2026-10-19T13:00:00+02:00");
		const groups = queue([{ ...made, note: { ...made.note, body: turns("Bo Berg") } }]);
		assert.deepEqual(idsOf(groups), ["done-without-speaker-split"]);
	});

	it("does not list a recording that is being redone, whatever its old text holds", () => {
		const made = doneWith("m", ["Speaker 1"]);
		const again = { ...made, note: { ...made.note, properties: made.note.properties.map((p) => (p.key === "attempt" ? { ...p, lines: ["attempt: 2"] } : p)) } };
		const groups = queue([again]);
		assert.deepEqual(idsOf(groups), ["waiting"]);
		assert.equal(groups[0].rows[0].unnamed, 0, "its speakers are not asked about either");
	});
});

// Wave 7: #84's lines in #82's queue model, applied at merge.
describe("the audio the keep time holds", () => {
	const keeping: VaultRecorderSettings = { ...DEFAULT_SETTINGS, keepTimeDays: 30 };
	const offersOf = (groups: QueueGroup[], path: string): string[] =>
		groups.flatMap((g) => g.rows).find((r) => r.path === path)?.offers.map((o) => o.action) ?? [];

	it("puts a finished recording whose audio is kept under 'Audio held', with the reason and the switch", () => {
		const groups = queue(
			[answered("kept", "done", "2026-10-17T10:00:00+02:00", ["keep-audio: true"])],
			new ProgressMemory(),
			NOW,
			keeping,
		);
		assert.deepEqual(pathsIn(groups, "audio-held"), ["kept.md"]);
		const row = groups.find((g) => g.id === "audio-held")!.rows[0]!;
		assert.equal(row.audioHeld, "keep audio is set");
		assert.deepEqual(offersOf(groups, "kept.md"), ["try-again", "release-audio", "delete-audio"]);
	});

	it("leaves a recording out of 'Audio held' when the keep time is empty or only the transcript holds it", () => {
		const kept = answered("kept", "done", "2026-10-17T10:00:00+02:00", ["keep-audio: true"]);
		assert.deepEqual(pathsIn(queue([kept]), "audio-held"), []);
		// The state line already says the transcript is waiting; the row carries no hold of its own.
		const waitingNote = waiting("w", "2026-10-19T13:00:00+02:00");
		const rows = queue([waitingNote], new ProgressMemory(), NOW, keeping).flatMap((g) => g.rows);
		assert.equal(rows.find((r) => r.path === "w.md")?.audioHeld, null);
	});

	it("offers neither keep nor delete, nor transcribe, once the audio is deleted", () => {
		const gone = noteAt("gone.md", [
			"recorded: 2026-10-19T06:00:00+02:00",
			"transcribe: cancelled",
			"audio-deleted: 2026-10-19",
		]);
		assert.deepEqual(offersOf(queue([gone], new ProgressMemory(), NOW, keeping), "gone.md"), []);
		const there = noteAt("there.md", ["recorded: 2026-10-19T06:00:00+02:00", "transcribe: cancelled"]);
		assert.deepEqual(offersOf(queue([there], new ProgressMemory(), NOW, keeping), "there.md"), [
			"transcribe",
			"keep-audio",
			"delete-audio",
		]);
	});
});

describe("a re-transcription that was cancelled after the agent ran", () => {
	// A done transcript whose agent answered, then "Try again" (attempt 2, a new
	// request nothing has answered) and "Cancel".
	const cancelledRetry = (name: string, agentLines: string[]): QueueNote => {
		const made = answered(name, "done", "2026-10-19T13:00:00+02:00", [
			"agent: requested",
			"agent-attempt: 1",
			...agentLines,
		]);
		const note = setProperty(setProperty(made.note, "attempt", "2"), "transcribe", "cancelled");
		return { ...made, note };
	};

	it("shows an agent that failed under 'Cancelled', not 'Agent failed'", () => {
		const groups = queue([
			cancelledRetry("f", [
				"agent-state: failed",
				"agent-attempt-answered: 1",
				"agent-at: 2026-10-19T13:05:00+02:00",
			]),
		]);
		assert.deepEqual(idsOf(groups), ["cancelled"]);
	});

	it("shows an agent that is overdue under 'Cancelled', not 'Agent overdue'", () => {
		const groups = queue([cancelledRetry("o", [])], new ProgressMemory(), "2026-10-21T14:00:00+02:00");
		assert.deepEqual(idsOf(groups), ["cancelled"]);
	});

	it("shows an agent that is working under 'Cancelled', not 'Agent working'", () => {
		const groups = queue([
			cancelledRetry("w", [
				"agent-state: working",
				"agent-attempt-answered: 1",
				"agent-at: 2026-10-19T13:05:00+02:00",
			]),
		]);
		assert.deepEqual(idsOf(groups), ["cancelled"]);
	});
});
