import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle } from "./lifecycle.js";
import { makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { shouldRequestAgent } from "./agent-service.js";
import * as settingsData from "./settings-data.js";
import type { AgentEntry } from "./settings-data.js";
import {
	buildRequestNote,
	deriveState,
	formatTurn,
	markAgentRequested,
	markDone,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

// The service agent's request window: a transcript with no agent line is asked at any age when it
// finished after the mode's agent was chosen (`chosenAt`), never when it finished before, and with no
// recorded moment the 24-hour window of #82 stands.

const NOTE = "Recording 20261019093539.md";
const FINISHED = "2026-10-19T09:48:44+02:00";
const CHOSEN_BEFORE = "2026-10-18T12:00:00+02:00";
const CHOSEN_AFTER = "2026-10-19T12:00:00+02:00";
const THREE_DAYS_LATER = "2026-10-22T09:50:00+02:00";

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

function agentEntry(chosenAt: string): AgentEntry {
	return {
		kind: "hand-off",
		instruction: "",
		contextNotePath: "",
		address: "",
		keyName: "",
		modelName: "",
		chosenAt,
	};
}

/** One device: its own world and lifecycle, holding the note and an agent entry carrying `chosenAt`. */
function device(chosenAt: string, now: string, change: (note: TranscriptNote) => TranscriptNote = (n) => n) {
	const world: FakeWorld = makeFakeWorld();
	world.clock.set(now);
	world.currentSettings.agents.meeting = agentEntry(chosenAt);
	world.vault.seed(NOTE, serializeTranscriptNote(change(finishedNote())));
	return { world, lifecycle: new Lifecycle(world) };
}

const agentLine = (d: { world: FakeWorld }): string | undefined => {
	const note = parseTranscriptNote(d.world.vault.texts.get(NOTE) ?? "");
	assert.ok(note, "the transcript note exists");
	return readString(note, "agent");
};

describe("the agent's request window", () => {
	it("asks for a transcript finished after the agent was chosen, though a device first ticks days later", async () => {
		const d = device(CHOSEN_BEFORE, THREE_DAYS_LATER);
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d), "requested");
		// Ticket #185: an ask raised now reads waiting, not overdue, until the overdue time has passed since it.
		const note = parseTranscriptNote(d.world.vault.texts.get(NOTE) ?? "");
		assert.ok(note);
		const tick = d.world.clock.now();
		assert.equal(deriveState(note, tick, 24).agentOverdue, false, "not overdue straight after the ask");
		const later = new Date(tick.getTime() + 25 * 3600_000);
		assert.equal(deriveState(note, later, 24).agentOverdue, true, "overdue once 24 hours have passed after the ask");
	});

	it("writes no agent-requested-at for an automatic ask inside the overdue time", async () => {
		const d = device("", "2026-10-20T09:00:00+02:00");
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d), "requested");
		const note = parseTranscriptNote(d.world.vault.texts.get(NOTE) ?? "");
		assert.ok(note);
		assert.equal(readString(note, "agent-requested-at"), undefined);
	});

	it("asks for nothing that finished before the agent was chosen, however old", async () => {
		const d = device(CHOSEN_AFTER, THREE_DAYS_LATER);
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d), undefined);
		const old = device("2026-12-01T00:00:00+01:00", "2027-06-01T09:50:00+02:00");
		await old.lifecycle.tick(old.world.clock.now());
		assert.equal(agentLine(old), undefined, "months later it is still a transcript the choice came after");
	});

	it("asks a transcript finished at the very moment of the choice", () => {
		const note = finishedNote();
		const now = new Date("2026-10-22T09:50:00+02:00");
		const state = deriveState(note, now, 24);
		assert.equal(shouldRequestAgent(note, state, now, 24, FINISHED), true);
	});

	it("lets a second device that never saw the choice made send the request, from the saved moment alone", async () => {
		const first = device(CHOSEN_BEFORE, THREE_DAYS_LATER);
		const second = device(CHOSEN_BEFORE, THREE_DAYS_LATER);
		await first.lifecycle.tick(first.world.clock.now());
		await second.lifecycle.tick(second.world.clock.now());
		assert.equal(agentLine(first), "requested");
		assert.equal(agentLine(second), "requested");
	});

	it("keeps the 24-hour window when the moment is unknown", async () => {
		const within = device("", "2026-10-20T09:00:00+02:00");
		await within.lifecycle.tick(within.world.clock.now());
		assert.equal(agentLine(within), "requested", "23 hours after the transcript");
		const beyond = device("", THREE_DAYS_LATER);
		await beyond.lifecycle.tick(beyond.world.clock.now());
		assert.equal(agentLine(beyond), undefined, "three days after the transcript");
	});

	it("keeps refusing an agent that was cancelled, at any age and whatever the moment", async () => {
		const d = device(CHOSEN_BEFORE, THREE_DAYS_LATER, (n) => setProperty(markAgentRequested(n), "agent", "cancelled"));
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d), "cancelled");
		const note = parseTranscriptNote(d.world.vault.texts.get(NOTE) ?? "");
		assert.ok(note);
		const now = d.world.clock.now();
		assert.equal(shouldRequestAgent(note, deriveState(note, now, 24), now, 24, CHOSEN_BEFORE), false);
	});

	it("reads a moment that is not a moment as unknown, so the 24-hour window stands", () => {
		const note = finishedNote();
		const now = new Date(THREE_DAYS_LATER);
		const state = deriveState(note, now, 24);
		assert.equal(shouldRequestAgent(note, state, now, 24, "last Tuesday"), false);
	});
});

describe("choosing an agent kind stamps the moment", () => {
	const STAMP = "2026-10-29T08:00:00+01:00";
	const choose = (entry: AgentEntry, kind: AgentEntry["kind"], stamp = STAMP): void =>
		(settingsData as unknown as { chooseAgentKind(e: AgentEntry, k: AgentEntry["kind"], at: string): void }).chooseAgentKind(
			entry,
			kind,
			stamp,
		);

	it("stamps a change from none to an agent", () => {
		const entry = { ...agentEntry(""), kind: "none" as const };
		choose(entry, "service");
		assert.equal(entry.kind, "service");
		assert.equal(entry.chosenAt, STAMP);
	});

	it("stamps a change from one agent to another", () => {
		const entry = { ...agentEntry("2026-01-01T00:00:00+01:00"), kind: "service" as const };
		choose(entry, "hand-off");
		assert.equal(entry.chosenAt, STAMP);
	});

	it("leaves the moment alone when the kind did not change", () => {
		const entry = { ...agentEntry("2026-01-01T00:00:00+01:00"), kind: "service" as const };
		choose(entry, "service");
		assert.equal(entry.chosenAt, "2026-01-01T00:00:00+01:00");
	});

	it("clears the moment when the agent is switched off", () => {
		const entry = { ...agentEntry(CHOSEN_BEFORE), kind: "service" as const };
		choose(entry, "none");
		assert.equal(entry.kind, "none");
		assert.equal(entry.chosenAt, "");
	});
});
