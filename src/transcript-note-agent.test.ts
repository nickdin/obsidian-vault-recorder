import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	deriveState,
	markAgentDone,
	markAgentFailed,
	markAgentRequested,
	markAgentWorking,
	parseTranscriptNote,
	readInteger,
	readSection,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

/**
 * The hand-off agent's lines of the rule (`docs/hand-off-rule.md`, "The agent
 * lines"), tested against the five agent fixtures, 15 to 19: they parse and
 * serialize byte for byte, the producers a program or the plugin uses write
 * them byte for byte, and each state the plugin shows is derived from them.
 */

// `npm test` runs from the repository root.
const FIXTURES = path.join(process.cwd(), "docs", "hand-off-fixtures");
const fixtureText = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");
const fixture = (name: string): TranscriptNote => {
	const parsed = parseTranscriptNote(fixtureText(name));
	assert.ok(parsed !== null, `${name} parses`);
	return parsed;
};
const text = (note: TranscriptNote): string => serializeTranscriptNote(note);

const REQUESTED = "15-agent-requested.md";
const WORKING = "16-agent-working.md";
const DONE = "17-agent-done.md";
const FAILED = "18-agent-failed.md";
const OVERDUE = "19-agent-overdue.md";
const AGENT_FIXTURES = [REQUESTED, WORKING, DONE, FAILED, OVERDUE];

const PROGRAM = { name: "home-pc" };
const ANSWER =
	"The meeting agreed the schedule for the autumn.\n\nDecisions:\n- The schedule stands.\n\nActions:\n- Meet again on Friday (Speaker 1).";

const at = (iso: string): Date => new Date(iso);
const stateAt = (name: string, now: string, overdueHours = 24) =>
	deriveState(fixture(name), at(now), overdueHours);

describe("the agent fixtures", () => {
	for (const name of AGENT_FIXTURES) {
		it(`${name} parses and serializes byte for byte`, () => {
			assert.equal(text(fixture(name)), fixtureText(name));
		});
	}

	it("are produced byte for byte by the writes the plugin and a program make", () => {
		const done = fixture("04-done.md");
		const requested = markAgentRequested(done, { kind: "hand-off" });
		assert.equal(text(requested), fixtureText(REQUESTED));

		const working = markAgentWorking(requested, { ...PROGRAM, at: "2026-10-19T09:50:02+02:00" });
		assert.equal(text(working), fixtureText(WORKING));

		const answered = markAgentDone(working, { at: "2026-10-19T09:51:30+02:00", text: ANSWER });
		assert.equal(text(answered), fixtureText(DONE));

		const failed = markAgentFailed(
			markAgentWorking(requested, { ...PROGRAM, at: "2026-10-19T09:50:02+02:00" }),
			{ at: "2026-10-19T09:50:40+02:00", reason: "the model did not answer" },
		);
		assert.equal(text(failed), fixtureText(FAILED));
	});

	it("put the answer under ## Agent, above ## Transcript, and leave the transcript alone", () => {
		const note = fixture(DONE);
		assert.equal(readSection(note, "agent"), ANSWER);
		const body = text(note);
		assert.ok(body.indexOf("## Agent") < body.indexOf("## Transcript"));
		assert.equal(readSection(note, "transcript"), readSection(fixture(REQUESTED), "transcript"));
	});
});

describe("the agent's states are derived from the fixtures", () => {
	const NOW = "2026-10-19T12:00:00+02:00";

	it("requested and not yet taken is waiting", () => {
		assert.deepEqual(stateAt(REQUESTED, NOW), {
			transcriber: "done",
			transcriberOverdue: false,
			agent: "waiting",
			agentOverdue: false,
		});
	});

	it("taken is working", () => {
		const state = stateAt(WORKING, NOW);
		assert.equal(state.agent, "working");
		assert.equal(state.agentOverdue, false);
	});

	it("answered is done, and failed is failed with its reason on the note", () => {
		assert.equal(stateAt(DONE, NOW).agent, "done");
		assert.equal(stateAt(FAILED, NOW).agent, "failed");
		assert.equal(readString(fixture(FAILED), "agent-reason"), "the model did not answer");
	});

	it("a working agent whose last change is a day old is overdue", () => {
		const state = stateAt(OVERDUE, NOW);
		assert.equal(state.agent, "working");
		assert.equal(state.agentOverdue, true);
	});

	it("overdue is measured on the clock it is given, from agent-at, strictly after the overdue time", () => {
		// agent-at in fixture 16 is 2026-10-19T09:50:02+02:00.
		assert.equal(stateAt(WORKING, "2026-10-20T09:50:02+02:00").agentOverdue, false, "exactly 24 hours is not overdue");
		assert.equal(stateAt(WORKING, "2026-10-20T09:50:03+02:00").agentOverdue, true, "a second more is");
		assert.equal(stateAt(WORKING, "2026-10-19T12:00:00+02:00", 1).agentOverdue, true, "the overdue time is a setting");
		assert.equal(stateAt(WORKING, "2026-10-19T12:00:00+02:00", 3).agentOverdue, false);
	});

	it("a request nobody has taken is overdue from the later of the transcript and the request", () => {
		// transcriber-at in fixture 15 is 2026-10-19T09:48:44+02:00.
		assert.equal(stateAt(REQUESTED, "2026-10-20T09:48:44+02:00").agentOverdue, false);
		assert.equal(stateAt(REQUESTED, "2026-10-20T09:48:45+02:00").agentOverdue, true);
		assert.equal(stateAt(REQUESTED, "2026-10-20T09:48:45+02:00").agent, "waiting");
	});

	it("done and failed are never overdue, however old", () => {
		assert.equal(stateAt(DONE, "2027-01-01T00:00:00+01:00").agentOverdue, false);
		assert.equal(stateAt(FAILED, "2027-01-01T00:00:00+01:00").agentOverdue, false);
	});

	it("an answer to an earlier attempt is not an answer: a raised attempt is waiting again", () => {
		for (const name of [WORKING, DONE, FAILED]) {
			const again = markAgentRequested(fixture(name));
			assert.equal(readInteger(again, "agent-attempt"), 2, name);
			assert.equal(deriveState(again, at("2026-10-19T12:00:00+02:00"), 24).agent, "waiting", name);
		}
	});

	it("a cancelled agent is cancelled, and an answer that lands after the cancel is kept", () => {
		const cancelled = setProperty(fixture(REQUESTED), "agent", "cancelled");
		assert.equal(deriveState(cancelled, at("2026-10-19T12:00:00+02:00"), 24).agent, "cancelled");
		const late = markAgentDone(markAgentWorking(cancelled, { ...PROGRAM, at: "2026-10-19T09:51:00+02:00" }), {
			at: "2026-10-19T09:51:30+02:00",
			text: ANSWER,
		});
		assert.equal(readString(late, "agent"), "cancelled", "the plugin's line is not rewritten by the program");
		assert.equal(deriveState(late, at("2026-10-19T12:00:00+02:00"), 24).agent, "done");
	});

	it("a note with no agent line has no agent state at all", () => {
		const state = deriveState(fixture("04-done.md"), at("2026-10-19T12:00:00+02:00"), 24);
		assert.equal(state.agent, "none");
		assert.equal(state.agentOverdue, false);
	});
});

describe("a run-again counts its waiting time from when it was raised", () => {
	// Fixture 19: the agent took the job on 2026-10-18 at 08:13 and went quiet.
	const RAISED = "2026-10-19T12:00:00+02:00";
	const raisedAgain = (stamp: string | null): TranscriptNote => {
		const again = markAgentRequested(fixture(OVERDUE));
		return stamp === null ? again : setProperty(again, "agent-requested-at", stamp);
	};

	it("records the old behaviour without the stamp (the #169 bug): a run-again note carrying no such line is overdue at once", () => {
		const state = deriveState(raisedAgain(null), at(RAISED), 24);
		assert.equal(state.agent, "waiting");
		assert.equal(state.agentOverdue, true);
	});

	it("with the line, it is waiting and not overdue until the overdue time has passed again", () => {
		const note = raisedAgain(RAISED);
		const waiting = deriveState(note, at(RAISED), 24);
		assert.equal(waiting.agent, "waiting");
		assert.equal(waiting.agentOverdue, false);
		assert.equal(deriveState(note, at("2026-10-20T12:00:00+02:00"), 24).agentOverdue, false, "exactly 24 hours is not overdue");
		assert.equal(deriveState(note, at("2026-10-20T12:00:01+02:00"), 24).agentOverdue, true, "a second more is");
		assert.equal(deriveState(note, at("2026-10-19T13:00:01+02:00"), 1).agentOverdue, true, "the overdue time is a setting");
	});

	it("counts from the latest of the lines: an older stamp never pulls the clock back", () => {
		// Fixture 15's transcriber-at is 2026-10-19T09:48:44+02:00, later than this stamp.
		const note = setProperty(fixture(REQUESTED), "agent-requested-at", "2026-10-10T08:00:00+02:00");
		assert.equal(deriveState(note, at("2026-10-20T09:48:44+02:00"), 24).agentOverdue, false);
		assert.equal(deriveState(note, at("2026-10-20T09:48:45+02:00"), 24).agentOverdue, true);
	});

	it("a stamp that cannot be read is ignored, as every unreadable timestamp is", () => {
		const note = raisedAgain("yesterday-ish");
		assert.equal(deriveState(note, at(RAISED), 24).agentOverdue, true, "counted from agent-at, the latest it can read");
		assert.equal(deriveState(note, at("2026-10-19T08:13:00+02:00"), 24).agentOverdue, false);
	});

	it("a first request has no such line and is counted exactly as before", () => {
		assert.equal(readString(fixture(REQUESTED), "agent-requested-at"), undefined);
		assert.equal(readString(markAgentRequested(fixture("04-done.md")), "agent-requested-at"), undefined);
		assert.equal(stateAt(REQUESTED, "2026-10-20T09:48:44+02:00").agentOverdue, false);
		assert.equal(stateAt(REQUESTED, "2026-10-20T09:48:45+02:00").agentOverdue, true);
	});
});
