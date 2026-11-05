import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle } from "./lifecycle.js";
import { makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { mergeSavedSettings } from "./settings-migration.js";
import {
	buildRequestNote,
	formatTurn,
	markDone,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

// The settings upgrade stamps the moment of its first load into an agent entry that has an agent and no
// moment, so an agent chosen before #155 asks for the transcripts finished after the upgrade and
// for none finished before it.

const NOTE = "Recording 20261019093539.md";
const BEFORE_LOAD = "2026-10-19T09:48:44+02:00";
const LOAD = "2026-10-20T08:00:00+02:00";
const AFTER_LOAD = "2026-10-20T09:00:00+02:00";
const LATER_LOAD = "2026-11-02T08:00:00+01:00";
const THIRTY_HOURS_AFTER = "2026-10-21T15:00:00+02:00";

/** What an agent chosen before #155 left in `data.json`: an agent, and no `chosenAt`. */
const SAVED_ENTRY = {
	kind: "hand-off",
	instruction: "",
	contextNotePath: "",
	address: "",
	keyName: "",
	modelName: "",
};
const NO_AGENT = { ...SAVED_ENTRY, kind: "none" };
const savedFile = (meeting: Record<string, unknown>) => ({
	agents: { dailyLog: NO_AGENT, cursor: NO_AGENT, meeting },
});

/** A meeting whose transcript finished at `finishedAt`, with no agent line. */
function finishedNote(finishedAt: string): TranscriptNote {
	const request = buildRequestNote({
		audio: "Recording 20261019093539.m4a",
		audioBytes: 20_000,
		mode: "meeting",
		recorded: "2026-10-19T09:35:39+02:00",
		speakerSplit: true,
		attempt: 1,
	});
	return markDone(setProperty(request, "transcriber", "home-pc"), {
		at: finishedAt,
		seconds: 700,
		text: formatTurn(0, "Speaker 1", "Welcome, everybody."),
	});
}

/** A device that loaded `savedFile(SAVED_ENTRY)` at `LOAD`, then holds a transcript finished at `finishedAt` and ticks at `tickAt`. */
function deviceAfterLoad(finishedAt: string, tickAt: string) {
	const world: FakeWorld = makeFakeWorld();
	world.currentSettings.agents = mergeSavedSettings(savedFile(SAVED_ENTRY), LOAD).settings.agents;
	world.clock.set(tickAt);
	world.vault.seed(NOTE, serializeTranscriptNote(finishedNote(finishedAt)));
	return { world, lifecycle: new Lifecycle(world) };
}

const agentLine = (world: FakeWorld): string | undefined => {
	const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
	assert.ok(note, "the transcript note exists");
	return readString(note, "agent");
};

describe("the upgrade stamps the moment of its first load into a chosen agent", () => {
	it("asks for a transcript finished after the load, first seen 30 hours later", async () => {
		const d = deviceAfterLoad(AFTER_LOAD, THIRTY_HOURS_AFTER);
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d.world), "requested");
	});

	it("asks for nothing that finished before the load, however old", async () => {
		const d = deviceAfterLoad(BEFORE_LOAD, THIRTY_HOURS_AFTER);
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d.world), undefined);
		const old = deviceAfterLoad(BEFORE_LOAD, "2027-06-01T09:50:00+02:00");
		await old.lifecycle.tick(old.world.clock.now());
		assert.equal(agentLine(old.world), undefined, "months later it is still a transcript the load came after");
	});

	it("asks for nothing that finished an hour before the load, though a device sees it within 24 hours", async () => {
		const d = deviceAfterLoad("2026-10-20T07:00:00+02:00", "2026-10-20T09:00:00+02:00");
		await d.lifecycle.tick(d.world.clock.now());
		assert.equal(agentLine(d.world), undefined, "the 24-hour window alone would send this one");
	});

	it("stamps the load's moment into the entry and says the settings must be saved", () => {
		const merged = mergeSavedSettings(savedFile(SAVED_ENTRY), LOAD);
		assert.equal(merged.settings.agents.meeting.chosenAt, LOAD);
		assert.deepEqual(merged.stamped, ["meeting"]);
	});

	it("leaves a second load later with the moment the first one stamped", () => {
		const first = mergeSavedSettings(savedFile(SAVED_ENTRY), LOAD);
		const second = mergeSavedSettings(first.settings, LATER_LOAD);
		assert.equal(second.settings.agents.meeting.chosenAt, LOAD);
		assert.deepEqual(second.stamped, []);
	});

	it("keeps a moment already there, and text that is no time", () => {
		const time = mergeSavedSettings(savedFile({ ...SAVED_ENTRY, chosenAt: "2026-10-01T10:00:00+02:00" }), LOAD);
		assert.equal(time.settings.agents.meeting.chosenAt, "2026-10-01T10:00:00+02:00");
		assert.deepEqual(time.stamped, []);
		const text = mergeSavedSettings(savedFile({ ...SAVED_ENTRY, chosenAt: "last Tuesday" }), LOAD);
		assert.equal(text.settings.agents.meeting.chosenAt, "last Tuesday");
		assert.deepEqual(text.stamped, []);
	});

	it("stamps the empty moment the interim build saved into an entry with an agent", () => {
		const merged = mergeSavedSettings(savedFile({ ...SAVED_ENTRY, chosenAt: "" }), LOAD);
		assert.equal(merged.settings.agents.meeting.chosenAt, LOAD);
		assert.deepEqual(merged.stamped, ["meeting"]);
	});

	it("gives a mode with no agent chosen no moment", () => {
		const merged = mergeSavedSettings(savedFile(SAVED_ENTRY), LOAD);
		assert.equal(merged.settings.agents.dailyLog.chosenAt, "");
		assert.equal(merged.settings.agents.cursor.chosenAt, "");
		assert.deepEqual(mergeSavedSettings(savedFile({ ...NO_AGENT, chosenAt: "" }), LOAD).stamped, []);
	});
});
