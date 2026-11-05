import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	actionsFor,
	clockWords,
	namingOffers,
	speakersToName,
	stateLine,
	textToDraw,
	unnamedLine,
	type DrawClock,
} from "./state-line.js";
import { leaveRestUnnamed } from "./naming.js";
import { formatTurn, markDone, markTaken } from "./transcript-note.js";
import { deriveState, parseTranscriptNote, type TranscriptNote } from "./transcript-note.js";

// `npm test` runs from the repository root.
const FIXTURES = path.join(process.cwd(), "docs", "hand-off-fixtures");
const fixture = (name: string): TranscriptNote => {
	const note = parseTranscriptNote(readFileSync(path.join(FIXTURES, name), "utf8"));
	assert.ok(note, `${name} is a transcript note`);
	return note;
};

const OVERDUE_HOURS = 24;
const clockAt = (now: string, offsetMinutes: number): DrawClock => ({
	now: new Date(now),
	utcOffsetMinutes: () => offsetMinutes,
});
/** Fixture 01's own day, a few hours after it was recorded, in a +02:00 zone. */
const SAME_DAY = clockAt("2026-10-19T14:00:00+02:00", 120);

function lineOf(
	name: string,
	clock: DrawClock = SAME_DAY,
	waitingReason: string | null = null,
): string {
	const note = fixture(name);
	return stateLine(note, { state: deriveState(note, clock.now, OVERDUE_HOURS), waitingReason }, clock);
}

describe("the state line, one test per state", () => {
	it("says when a waiting recording started waiting", () => {
		assert.equal(lineOf("01-requested-daily-log.md"), "waiting since 09:12");
	});

	it("writes the time in the clock's own zone", () => {
		assert.equal(
			lineOf("01-requested-daily-log.md", clockAt("2026-10-19T14:00:00+02:00", 0)),
			"waiting since 07:12",
		);
	});

	it("adds the date when the recording did not start waiting today", () => {
		assert.equal(
			lineOf("11-overdue-waiting.md", clockAt("2026-10-19T14:00:00+02:00", 120)),
			"waiting since 2026-10-17 08:00 (overdue)",
		);
	});

	it("counts a try-again from the later of recorded and the old answer, as overdue does", () => {
		assert.equal(lineOf("10-try-again.md"), "waiting since 09:37");
	});

	it("draws the lifecycle's waiting reason exactly as given, after the time", () => {
		const reason = "no key for OpenAI on this device";
		assert.equal(
			lineOf("01-requested-daily-log.md", SAME_DAY, reason),
			`waiting since 09:12 — ${reason}`,
		);
	});

	it("gives the percentage while being transcribed", () => {
		assert.equal(lineOf("03-taken.md", clockAt("2026-10-19T09:40:00+02:00", 120)), "being transcribed, 42 %");
	});

	it("marks a transcription that has stood still too long", () => {
		assert.equal(
			lineOf("12-overdue-taken.md", clockAt("2026-10-19T14:00:00+02:00", 120)),
			"being transcribed, 10 % (overdue)",
		);
	});

	it("says done", () => {
		assert.equal(lineOf("04-done.md"), "done");
	});

	it("says done without speaker split", () => {
		assert.equal(lineOf("05-done-without-speaker-split.md"), "done without speaker split");
	});

	it("gives the reason a transcription failed", () => {
		assert.equal(lineOf("07-failed.md"), "failed: the audio could not be decoded");
	});

	it("says cancelled", () => {
		assert.equal(lineOf("08-cancelled.md"), "cancelled");
	});

	it("says so when the rule version is not one this plugin knows", () => {
		assert.equal(
			lineOf("13-unknown-rule-version.md"),
			"this note's rule version is not one this plugin knows",
		);
	});
});

describe("clockWords", () => {
	it("gives only the time for today and the date with it for any other day", () => {
		const clock = clockAt("2026-10-19T00:30:00+02:00", 120);
		assert.equal(clockWords(Date.parse("2026-10-19T00:10:00+02:00"), clock), "00:10");
		assert.equal(clockWords(Date.parse("2026-10-18T23:50:00+02:00"), clock), "2026-10-18 23:50");
	});
});

describe("the text drawn with the state line", () => {
	const status = (note: TranscriptNote) => ({
		state: deriveState(note, SAME_DAY.now, OVERDUE_HOURS),
		waitingReason: null,
	});

	it("has no transcript while the recording is waiting", () => {
		const note = fixture("01-requested-daily-log.md");
		assert.deepEqual(textToDraw(note, status(note), SAME_DAY), {
			stateLine: "waiting since 09:12",
			agent: null,
			transcript: null,
		});
	});

	it("gives the transcript text, without its heading, once it exists", () => {
		const note = fixture("06-done-daily-log.md");
		const drawn = textToDraw(note, status(note), SAME_DAY);
		assert.equal(drawn.stateLine, "done");
		assert.equal(
			drawn.transcript,
			"Remember to ask Anna about the budget before Friday.\n\nAlso order the new cable for the projector.",
		);
		assert.equal(drawn.agent, null);
	});

	it("gives the agent's section as well when an agent has answered", () => {
		const note = fixture("17-agent-done.md");
		const drawn = textToDraw(note, status(note), SAME_DAY);
		assert.ok(drawn.agent?.includes("The schedule stands."));
		assert.ok(drawn.transcript?.includes("[00:00:03] **Speaker 1:**"));
	});
});

describe("the actions the state line offers", () => {
	const offered = (name: string, clock: DrawClock = SAME_DAY) => {
		const note = fixture(name);
		const { offers, notOffered } = actionsFor(note, deriveState(note, clock.now, OVERDUE_HOURS));
		return { actions: offers.map((o) => o.action), notOffered };
	};

	it("offers cancel on a waiting recording and on one being transcribed", () => {
		assert.deepEqual(offered("01-requested-daily-log.md").actions, ["cancel"]);
		assert.deepEqual(offered("03-taken.md").actions, ["cancel"]);
	});

	it("offers try again on a failed or finished recording", () => {
		assert.deepEqual(offered("07-failed.md").actions, ["try-again"]);
		assert.deepEqual(offered("04-done.md").actions, ["try-again"]);
		assert.deepEqual(offered("05-done-without-speaker-split.md").actions, ["try-again"]);
	});

	it("offers cancel and try again on an overdue recording", () => {
		assert.deepEqual(offered("11-overdue-waiting.md").actions, ["cancel", "try-again"]);
		assert.deepEqual(offered("12-overdue-taken.md").actions, ["cancel", "try-again"]);
	});

	it("offers transcribe on a cancelled recording, and nothing on a rule version it does not know", () => {
		assert.deepEqual(offered("08-cancelled.md").actions, ["transcribe"]);
		assert.deepEqual(offered("13-unknown-rule-version.md").actions, []);
	});

	it("does not offer try again once the audio is gone, and says why", () => {
		const { actions, notOffered } = offered("14-audio-deleted.md");
		assert.equal(actions.includes("try-again"), false);
		assert.match(notOffered ?? "", /audio was deleted/);
	});
});

describe("the unnamed-speakers line", () => {
	const withTurns = (): TranscriptNote =>
		markDone(fixture("01-requested-daily-log.md"), {
			at: "2026-10-19T10:00:00+02:00",
			seconds: 60,
			text: [formatTurn(1, "Speaker 1", "Hi."), formatTurn(5, "Speaker 2", "Hello.")].join("\n\n"),
		});
	const stateOf = (note: TranscriptNote) => deriveState(note, new Date("2026-10-19T14:00:00+02:00"), OVERDUE_HOURS);

	it("says how many speakers are unnamed and invites naming them, in the spec's words", () => {
		assert.equal(unnamedLine(2), "2 speakers unnamed — name them");
		assert.equal(unnamedLine(1), "1 speaker unnamed — name them");
	});

	it("says nothing when no speaker is unnamed", () => {
		assert.equal(unnamedLine(0), null);
	});

	it("counts the labels of a transcript that has arrived", () => {
		const note = withTurns();
		assert.equal(speakersToName(note, stateOf(note)), 2);
	});

	it("stops once naming is finished", () => {
		const note = leaveRestUnnamed(withTurns());
		assert.equal(speakersToName(note, stateOf(note)), 0);
		assert.deepEqual(namingOffers(note, stateOf(note)), []);
	});

	it("does not ask about the speakers of a transcript being redone, whose old text is about to go", () => {
		const note = markTaken(withTurns(), { name: "program", at: "2026-10-19T13:00:00+02:00" });
		const retrying = { ...note, properties: note.properties.map((p) => (p.key === "attempt" ? { ...p, lines: ["attempt: 2"] } : p)) };
		assert.equal(stateOf(retrying).transcriber, "waiting");
		assert.equal(speakersToName(retrying, stateOf(retrying)), 0);
	});

	it("offers naming and leaving the rest unnamed, beside the offers a state already has", () => {
		const note = withTurns();
		assert.deepEqual(
			namingOffers(note, stateOf(note)).map((o) => o.action),
			["name-speakers", "leave-unnamed"],
		);
		assert.deepEqual(actionsFor(note, stateOf(note)).offers.map((o) => o.action), ["try-again"]);
	});
});
