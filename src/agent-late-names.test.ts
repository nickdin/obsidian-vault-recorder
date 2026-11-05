import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { makeFakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions } from "./lifecycle-actions.js";
import type { AgentEntry } from "./settings-data.js";
import {
	buildRequestNote,
	deriveState,
	formatTurn,
	markAgentDone,
	markAgentWorking,
	markDone,
	parseTranscriptNote,
	readSection,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

const NOTE = "Recording 20261019093539.md";
const DONE_AT = "2026-10-19T09:48:44+02:00";
const LATER = "2026-10-19T10:30:00+02:00";

const TURNS = [
	formatTurn(0, "Speaker 1", "Welcome, everybody."),
	formatTurn(12, "Speaker 2", "Thanks. I agree with the budget."),
].join("\n\n");

function doneNote(turns: string = TURNS): string {
	const request = buildRequestNote({
		audio: "Recording 20261019093539.m4a",
		audioBytes: 20_000,
		mode: "meeting",
		recorded: "2026-10-19T09:35:39+02:00",
		linkedFrom: "2026-10-19 Planning",
		speakerSplit: true,
		participants: [],
		owner: "[[Robin Example]]",
		attempt: 1,
	});
	const done = markDone(setProperty(request, "transcriber", "home-pc"), { at: DONE_AT, seconds: 700, text: turns });
	return serializeTranscriptNote(done);
}

const handOffEntry = (): AgentEntry => ({
	kind: "hand-off",
	instruction: "Make bullet points of what was decided.",
	contextNotePath: "",
	address: "",
	keyName: "",
	modelName: "",
	chosenAt: "",
});

/** One place that builds the actions, so a port added to `RecordingActions` is one line here. */
function buildActions(world: ReturnType<typeof makeFakeWorld>, lifecycle: Lifecycle): RecordingActions {
	return new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		confirm: async () => true,
		refresh: (path) => lifecycle.look(path, world.clock.now()),
		exclusively: (path, step) => lifecycle.exclusively(path, step),
	});
}

describe("a hand-off agent's late answer after a cancel and a naming", () => {
	async function cancelledAndNamed(turns: string = TURNS, names: [string, string][] = [["Speaker 2", "Anna"]]) {
		const world = makeFakeWorld();
		world.clock.set("2026-10-19T09:50:00+02:00");
		world.currentSettings.agents.meeting = handOffEntry();
		const lifecycle = new Lifecycle(world, defaultAdapters());
		world.vault.seed(NOTE, doneNote(turns));
		const actions = buildActions(world, lifecycle);
		const noteOf = (): TranscriptNote => {
			const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(note, "the transcript note exists");
			return note;
		};
		await lifecycle.tick(world.clock.now());
		world.vault.texts.set(
			NOTE,
			serializeTranscriptNote(markAgentWorking(noteOf(), { name: "summary-program", at: world.clock.now().toISOString() })),
		);
		await lifecycle.tick(world.clock.now());
		assert.equal((await actions.cancelAgent(NOTE)).changed, true);
		for (const [label, name] of names) assert.equal((await actions.nameSpeaker(NOTE, label, name)).changed, true);
		return { world, lifecycle, noteOf };
	}

	it("reads the person's name in the agent section, not the label the program saw", async () => {
		const { world, lifecycle, noteOf } = await cancelledAndNamed();
		// The program read the note before the naming, so its answer says Speaker 2.
		world.vault.texts.set(
			NOTE,
			serializeTranscriptNote(markAgentDone(noteOf(), { at: LATER, text: "Speaker 2 agreed. Speaker 1 chaired." })),
		);
		await lifecycle.tick(world.clock.now());
		assert.equal(deriveState(noteOf(), world.clock.now(), 24).agent, "done");
		const agent = readSection(noteOf(), "agent") ?? "";
		assert.match(agent, /Anna agreed/);
		assert.doesNotMatch(agent, /Speaker 2/);
		// A label the person has not named stays as the program wrote it.
		assert.match(agent, /Speaker 1 chaired/);
		assert.match(noteOf().body, /\*\*Anna:\*\*/);
	});

	const answerAfter = async (turns: string) => {
		const { world, lifecycle, noteOf } = await cancelledAndNamed(turns, [
			["Speaker 1", "Anna"],
			["Speaker 2", "Bo"],
		]);
		world.vault.texts.set(
			NOTE,
			serializeTranscriptNote(markAgentDone(noteOf(), { at: LATER, text: "Speaker 1 chaired. Speaker 2 agreed." })),
		);
		await lifecycle.tick(world.clock.now());
		return readSection(noteOf(), "agent") ?? "";
	};

	it("gives each speaker their own name when two turns start in the same second", async () => {
		const agent = await answerAfter(
			[formatTurn(12, "Speaker 1", "Yes."), formatTurn(12, "Speaker 2", "No."), formatTurn(20, "Speaker 2", "More.")].join("\n\n"),
		);
		assert.match(agent, /Anna chaired/);
		assert.match(agent, /Bo agreed/);
	});

	it("names a speaker whose only turn shares a second with a speaker who also spoke at 00:00:00", async () => {
		const agent = await answerAfter(
			[
				formatTurn(0, "Speaker 1", "Hello."),
				formatTurn(12, "Speaker 1", "Yes."),
				formatTurn(12, "Speaker 2", "No."),
			].join("\n\n"),
		);
		assert.match(agent, /Anna chaired/);
		assert.match(agent, /Bo agreed/);
	});
});
