import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { shouldRequestAgent } from "./agent-service.js";
import {
	buildRequestNote,
	deriveState,
	formatTurn,
	markAgentCancelled,
	markAgentFor,
	markAgentRequested,
	markDone,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

// Where #150's cancel meets #155's request window: a transcript that finished after the agent was
// chosen is asked at any age, but not once the agent has been cancelled on it.

const FINISHED = "2026-10-19T09:48:44+02:00";
const CHOSEN_BEFORE = "2026-10-18T12:00:00+02:00";
const THREE_DAYS_LATER = new Date("2026-10-22T09:50:00+02:00");

/** A meeting whose transcript finished at `FINISHED`, with no agent line. */
function finishedNote(): TranscriptNote {
	const request = buildRequestNote({
		audio: "Recording 20261019093539.m4a",
		audioBytes: 20_000,
		mode: "meeting",
		recorded: "2026-10-19T09:35:39+02:00",
		speakerSplit: true,
		attempt: 1,
	});
	return markDone(setProperty(request, "transcriber", "home-pc"), {
		at: FINISHED,
		seconds: 700,
		text: formatTurn(0, "Speaker 1", "Welcome, everybody."),
	});
}

describe("a cancelled agent inside the request window (#150 with #155)", () => {
	it("asks for a transcript finished after the choice, three days on, while nothing is cancelled", () => {
		const note = finishedNote();
		const state = deriveState(note, THREE_DAYS_LATER, 24);
		assert.equal(shouldRequestAgent(note, state, THREE_DAYS_LATER, 24, CHOSEN_BEFORE), true);
	});

	it("asks for nothing once the agent is cancelled on that transcript", () => {
		// A cancelled request: asked first, as the lifecycle does, then cancelled by hand.
		const note = markAgentCancelled(markAgentFor(markAgentRequested(finishedNote())));
		const state = deriveState(note, THREE_DAYS_LATER, 24);
		assert.equal(shouldRequestAgent(note, state, THREE_DAYS_LATER, 24, CHOSEN_BEFORE), false);
	});
});
