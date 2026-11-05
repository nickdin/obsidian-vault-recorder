import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { makeFakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions } from "./lifecycle-actions.js";
import { withServiceAgent, type NoteReaderPort } from "./agent-service.js";
import type { KeyStore } from "./key-store.js";
import type { AgentEntry } from "./settings-data.js";
import type { NetworkPort, NetworkRequest, NetworkResponse } from "./transcriber-service.js";
import { agentOffers } from "./state-line.js";
import {
	buildRequestNote,
	deriveState,
	formatTurn,
	markAgentDone,
	markAgentWorking,
	markDone,
	parseTranscriptNote,
	readSection,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

const NOTE = "Recording 20261019093539.md";
const DONE_AT = "2026-10-19T09:48:44+02:00";
const LATER = "2026-10-19T10:30:00+02:00";

class SilentNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	async reach(): Promise<void> {}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return { status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", content: "A summary." } }] }) };
	}
}

/** A device that holds no key at all: the service agent can only wait here. */
class NoKeys implements KeyStore {
	get(): string | null {
		return null;
	}
}

class NoNotes implements NoteReaderPort {
	async read(): Promise<string | null> {
		return null;
	}
}

const TURNS = [
	formatTurn(0, "Speaker 1", "Welcome, everybody."),
	formatTurn(12, "Speaker 2", "Thanks. I agree with the budget."),
].join("\n\n");

function doneNote(): string {
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
	const done = markDone(setProperty(request, "transcriber", "home-pc"), { at: DONE_AT, seconds: 700, text: TURNS });
	return serializeTranscriptNote(done);
}

const agentEntry = (): AgentEntry => ({
	kind: "service",
	instruction: "Make bullet points of what was decided.",
	contextNotePath: "",
	address: "http://127.0.0.1:11434/v1",
	keyName: "work-key",
	modelName: "llama3.2",
	chosenAt: "",
});

/** A done meeting whose service agent names a key this device does not hold, after one tick. */
async function blockedAgent() {
	const world = makeFakeWorld();
	world.clock.set("2026-10-19T09:50:00+02:00");
	world.currentSettings.agents.meeting = agentEntry();
	const network = new SilentNetwork();
	const lifecycle = new Lifecycle(
		world,
		withServiceAgent(defaultAdapters(), {
			vault: world.vault,
			clock: world.clock,
			device: world.device,
			network,
			keys: new NoKeys(),
			notes: new NoNotes(),
			wait: async () => {},
		}),
	);
	world.vault.seed(NOTE, doneNote());
	const actions = new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: (path, step) => lifecycle.exclusively(path, step),
		confirm: async () => true,
		refresh: (path) => lifecycle.look(path, world.clock.now()),
	});
	await lifecycle.tick(world.clock.now());
	const noteOf = (): TranscriptNote => {
		const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
		assert.ok(note, "the transcript note exists");
		return note;
	};
	const stateOf = () => deriveState(noteOf(), world.clock.now(), 24);
	return { world, network, lifecycle, actions, noteOf, stateOf };
}

describe("cancelling the agent by hand", () => {
	it("starts blocked: the agent waits for a key this device lacks, and naming is refused", async () => {
		const s = await blockedAgent();
		assert.equal(readString(s.noteOf(), "agent"), "requested");
		assert.equal(s.stateOf().agent, "waiting");
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
		assert.equal(result.changed, false);
		assert.match(result.message, /cancel it first/);
	});

	it("offers the cancel while the agent waits, and writes agent: cancelled", async () => {
		const s = await blockedAgent();
		assert.deepEqual(agentOffers(s.stateOf()).map((o) => o.action), ["cancel-agent"]);
		const result = await s.actions.cancelAgent(NOTE);
		assert.equal(result.changed, true);
		assert.equal(readString(s.noteOf(), "agent"), "cancelled");
		assert.equal(s.stateOf().agent, "cancelled");
	});

	it("lets naming through after the cancel", async () => {
		const s = await blockedAgent();
		await s.actions.cancelAgent(NOTE);
		assert.equal(await s.actions.whyNotNaming(NOTE), null);
		const result = await s.actions.nameSpeaker(NOTE, "Speaker 2", "Anna");
		assert.equal(result.changed, true);
		assert.ok((s.world.vault.texts.get(NOTE) ?? "").includes("Anna"));
	});

	it("refuses to cancel an agent that is not waiting or working, and writes nothing", async () => {
		const s = await blockedAgent();
		await s.actions.cancelAgent(NOTE);
		const before = s.world.vault.texts.get(NOTE);
		const again = await s.actions.cancelAgent(NOTE);
		assert.equal(again.changed, false);
		assert.equal(s.world.vault.texts.get(NOTE), before);
	});

	it("is not asked again by a tick, on this device or after a late clock", async () => {
		const s = await blockedAgent();
		await s.actions.cancelAgent(NOTE);
		const before = s.world.vault.texts.get(NOTE);
		await s.lifecycle.tick(s.world.clock.now());
		s.world.clock.set(LATER);
		await s.lifecycle.tick(s.world.clock.now());
		assert.equal(s.world.vault.texts.get(NOTE), before);
		assert.equal(s.network.requests.length, 0);
	});

	it("lets Run agent again ask afresh after the cancel", async () => {
		const s = await blockedAgent();
		await s.actions.cancelAgent(NOTE);
		assert.deepEqual(agentOffers(s.stateOf()).map((o) => o.action), ["run-agent"]);
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, true);
		assert.equal(readString(s.noteOf(), "agent"), "requested");
		assert.equal(s.stateOf().agent, "waiting");
	});

	it("keeps and shows a hand-off program's late answer after the cancel", async () => {
		// The hand-off road (docs/hand-off-rule.md, "The agent lines"): another program takes the
		// request, the user cancels while it works, and its answer then lands and is kept.
		const world = makeFakeWorld();
		world.clock.set("2026-10-19T09:50:00+02:00");
		world.currentSettings.agents.meeting = { ...agentEntry(), kind: "hand-off" };
		const lifecycle = new Lifecycle(world, defaultAdapters());
		world.vault.seed(NOTE, doneNote());
		const actions = new RecordingActions({
			vault: world.vault,
			clock: world.clock,
			settings: world.settings,
			exclusively: (path, step) => lifecycle.exclusively(path, step),
			confirm: async () => true,
			refresh: (path) => lifecycle.look(path, world.clock.now()),
		});
		const noteOf = (): TranscriptNote => {
			const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(note, "the transcript note exists");
			return note;
		};
		const stateOf = () => deriveState(noteOf(), world.clock.now(), 24);
		await lifecycle.tick(world.clock.now());
		assert.equal(readString(noteOf(), "agent"), "requested");
		world.vault.texts.set(
			NOTE,
			serializeTranscriptNote(markAgentWorking(noteOf(), { name: "summary-program", at: world.clock.now().toISOString() })),
		);
		await lifecycle.tick(world.clock.now());
		assert.equal(stateOf().agent, "working");
		assert.deepEqual(agentOffers(stateOf()).map((o) => o.action), ["cancel-agent"]);

		const cancelled = await actions.cancelAgent(NOTE);
		assert.equal(cancelled.changed, true);
		assert.equal(stateOf().agent, "cancelled");

		world.vault.texts.set(NOTE, serializeTranscriptNote(markAgentDone(noteOf(), { at: LATER, text: "Speaker 2 agreed." })));
		await lifecycle.tick(world.clock.now());
		assert.equal(stateOf().agent, "done");
		assert.equal(readSection(noteOf(), "agent"), "Speaker 2 agreed.");
		assert.deepEqual(agentOffers(stateOf()).map((o) => o.action), ["run-agent"]);
	});

	it("drops a service request's answer when the cancel lands while it is in flight (a guard on stillMine)", async () => {
		// Records what `stillMine` in agent-service.ts does: a service agent writes only while the
		// note still shows its own claim, so an answer arriving after a cancel is not written.
		const world = makeFakeWorld();
		world.clock.set("2026-10-19T09:50:00+02:00");
		world.currentSettings.agents.meeting = agentEntry();
		let actions: RecordingActions | undefined;
		class CancelDuringSend extends SilentNetwork {
			override async send(request: NetworkRequest): Promise<NetworkResponse> {
				await actions?.cancelAgent(NOTE);
				return super.send(request);
			}
		}
		const network = new CancelDuringSend();
		class WorkKey implements KeyStore {
			get(): string | null {
				return "secret";
			}
		}
		const lifecycle = new Lifecycle(
			world,
			withServiceAgent(defaultAdapters(), {
				vault: world.vault,
				clock: world.clock,
				device: world.device,
				network,
				keys: new WorkKey(),
				notes: new NoNotes(),
				wait: async () => {},
			}),
		);
		world.vault.seed(NOTE, doneNote());
		actions = new RecordingActions({
			vault: world.vault,
			clock: world.clock,
			settings: world.settings,
			exclusively: (path, step) => lifecycle.exclusively(path, step),
			confirm: async () => true,
			refresh: (path) => lifecycle.look(path, world.clock.now()),
		});
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 1, "the request went out");
		const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
		assert.ok(note);
		assert.equal(readString(note, "agent"), "cancelled");
		assert.equal(readSection(note, "agent"), undefined);
	});
});
