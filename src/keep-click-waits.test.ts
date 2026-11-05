import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { withServiceAgent, type NoteReaderPort } from "./agent-service.js";
import type { KeyStore } from "./key-store.js";
import { KeepActions } from "./keep-time.js";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { findModel, type ModelEntry } from "./model-list.js";
import { FakeAudio, FakeModelRunner } from "./model-runner-fakes.js";
import { FakeModelDisk, FakeNetwork } from "./model-store-fakes.js";
import { ModelStore } from "./model-store.js";
import type { AgentEntry } from "./settings-data.js";
import { createOnDeviceTranscriber } from "./transcriber-on-device.js";
import type { NetworkPort, NetworkRequest, NetworkResponse } from "./transcriber-service.js";
import {
	buildRequestNote,
	formatTurn,
	markDone,
	parseTranscriptNote,
	readSection,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

// "Keep audio" and "Stop keeping audio" run under the note's guard. The
// lifecycle holds a note for the whole of an adapter's tick, which awaits the
// long work itself (a transcription on this device, a model request), so a
// click made then is accepted at once and applied when the note is free. The
// guard is the lifecycle's own; the long work is held by a promise the test
// releases.

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";
const MODEL = findModel("kb-whisper-tiny") as ModelEntry;
const TAKES_EFFECT = /takes effect when/;

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settled = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn++) await settle();
};
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turn = 0; turn < 100 && !condition(); turn++) await settle();
	assert.ok(condition(), `${what} never happened`);
}

/** A promise the test opens when it wants the long work to end. */
function gate(): { open(): void; opened: Promise<void> } {
	let open = (): void => {};
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
}

interface Keeping {
	keep: KeepActions;
	/** What the person was told after a click that waited was applied. */
	told: string[];
}

function keepingFor(world: FakeWorld, lifecycle: Lifecycle): Keeping {
	const told: string[] = [];
	const keep = new KeepActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		resolveFile: (target) => (world.vault.binaries.has(target) ? target : null),
		exclusively: (path, step) => lifecycle.exclusively(path, step),
		whenFree: (path, run) => lifecycle.whenFree(path, run),
		tell: (message) => told.push(message),
		confirm: async () => true,
		refresh: (path) => lifecycle.look(path, world.clock.now()),
		notesLinkingTo: () => [],
	});
	return { keep, told };
}

const noteOf = (world: FakeWorld): TranscriptNote => {
	const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
	assert.ok(note, "the transcript note exists");
	return note;
};
const kept = (world: FakeWorld): boolean => readString(noteOf(world), "keep-audio") !== undefined;

// --- A transcription held on this device ---------------------------------------------------

async function transcribingWorld(options: { alreadyKept?: boolean } = {}) {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, "Earlier thought.\n");
	const disk = new FakeModelDisk();
	const store = new ModelStore({
		modelFolder: () => world.currentSettings.modelFolder,
		folder: disk,
		trash: disk,
		download: new FakeNetwork(),
	});
	const runner = new FakeModelRunner();
	const audio = new FakeAudio();
	audio.recordings.set(FILENAME, audioOfSize(20_000));
	const lifecycle = new Lifecycle(world, {
		...defaultAdapters(),
		transcribers: {
			...defaultAdapters().transcribers,
			"on-device": createOnDeviceTranscriber(store, {
				vault: world.vault,
				clock: world.clock,
				device: world.device,
				audio,
				runner,
			}),
		},
	});
	world.currentSettings.transcribers.dailyLog = {
		kind: "on-device",
		modelId: MODEL.id,
		address: "",
		keyName: "",
		modelName: "",
	};
	disk.place(MODEL);
	await store.refreshOne(MODEL.id);
	await lifecycle.recordingStopped({
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	});
	if (options.alreadyKept) {
		world.vault.texts.set(NOTE, serializeTranscriptNote(setProperty(noteOf(world), "keep-audio", "true")));
	}
	// The transcription runs until the test lets it end.
	const transcription = gate();
	runner.script = async () => transcription.opened;
	const tick = lifecycle.tick(world.clock.now());
	await until(() => runner.inFlight === 1, "the transcription starting");
	return { world, lifecycle, transcription, tick, ...keepingFor(world, lifecycle) };
}

describe("a keep click made while the note is being transcribed on this device", () => {
	it("Keep audio is accepted at once, says when it takes effect, and ends with the flag and the transcript both on the note", async () => {
		const w = await transcribingWorld();
		const click = await w.keep.setKeepAudio(NOTE, true);
		assert.equal(click.changed, true, click.message);
		assert.match(click.message, TAKES_EFFECT);
		assert.equal(kept(w.world), false, "nothing is written while the note is held");

		w.transcription.open();
		await w.tick;
		await settled();

		assert.equal(kept(w.world), true, "the flag is on the note once the transcription is done");
		assert.match(readSection(noteOf(w.world), "transcript") ?? "", /This is a spoken note\./, "the transcript is still there");
		assert.equal(readString(noteOf(w.world), "transcriber-state"), "done");
		assert.deepEqual(w.told, ["This recording's audio is kept"]);
	});

	it("Stop keeping audio is accepted at once and ends with the flag off and the transcript on the note", async () => {
		const w = await transcribingWorld({ alreadyKept: true });
		const click = await w.keep.setKeepAudio(NOTE, false);
		assert.equal(click.changed, true, click.message);
		assert.match(click.message, TAKES_EFFECT);
		assert.equal(kept(w.world), true, "nothing is written while the note is held");

		w.transcription.open();
		await w.tick;
		await settled();

		assert.equal(kept(w.world), false);
		assert.match(readSection(noteOf(w.world), "transcript") ?? "", /This is a spoken note\./);
	});

	for (const [clicks, ends] of [
		[[true, false], false],
		[[false, true], true],
	] as const) {
		it(`two clicks while it is held end with the last one's value (${clicks.map((c) => (c ? "keep" : "stop")).join(", then ")})`, async () => {
			// The note starts as the first click asks for, so only the last click changes it.
			const w = await transcribingWorld({ alreadyKept: clicks[0] });
			for (const click of clicks) assert.equal((await w.keep.setKeepAudio(NOTE, click)).changed, true);

			w.transcription.open();
			await w.tick;
			await settled();

			assert.equal(kept(w.world), ends);
			assert.match(readSection(noteOf(w.world), "transcript") ?? "", /This is a spoken note\./);
		});
	}
});

// --- A model request held on a service agent ---------------------------------------------

const TURNS = [formatTurn(0, "Speaker 1", "Welcome, everybody."), formatTurn(12, "Speaker 2", "Thanks.")].join("\n\n");

/** A service that answers when the test lets it. */
class HeldNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	readonly answer = gate();
	async reach(): Promise<void> {}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		await this.answer.opened;
		return { status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", content: "A summary." } }] }) };
	}
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

async function askingWorld() {
	const world = makeFakeWorld();
	world.clock.set("2026-10-19T09:50:00+02:00");
	world.currentSettings.agents.meeting = agentEntry();
	const network = new HeldNetwork();
	const keys: KeyStore = { get: () => "secret" };
	const notes: NoteReaderPort = { read: async () => null };
	const lifecycle = new Lifecycle(
		world,
		withServiceAgent(defaultAdapters(), {
			vault: world.vault,
			clock: world.clock,
			device: world.device,
			network,
			keys,
			notes,
			wait: async () => {},
		}),
	);
	const request = buildRequestNote({
		audio: FILENAME,
		audioBytes: 20_000,
		mode: "meeting",
		recorded: "2026-10-19T09:35:39+02:00",
		linkedFrom: "2026-10-19 Planning",
		speakerSplit: true,
		participants: [],
		owner: "[[Robin Example]]",
		attempt: 1,
	});
	world.vault.binaries.set(FILENAME, 20_000);
	world.vault.seed(
		NOTE,
		serializeTranscriptNote(
			markDone(setProperty(request, "transcriber", "home-pc"), { at: "2026-10-19T09:48:44+02:00", seconds: 700, text: TURNS }),
		),
	);
	const tick = lifecycle.tick(world.clock.now());
	await until(() => network.requests.length === 1, "the agent's request going out");
	return { world, lifecycle, network, tick, ...keepingFor(world, lifecycle) };
}

describe("a keep click made while a service agent's request is out", () => {
	it("Keep audio is accepted at once and ends with the flag and the agent's answer both on the note", async () => {
		const w = await askingWorld();
		const click = await w.keep.setKeepAudio(NOTE, true);
		assert.equal(click.changed, true, click.message);
		assert.match(click.message, TAKES_EFFECT);

		w.network.answer.open();
		await w.tick;
		await settled();

		assert.equal(kept(w.world), true);
		assert.match(readSection(noteOf(w.world), "agent") ?? "", /A summary\./, "the agent's answer is still there");
		assert.equal(readString(noteOf(w.world), "agent-state"), "done");
	});

	it("Stop keeping audio ends with the flag off and the answer on the note", async () => {
		const w = await askingWorld();
		w.world.vault.texts.set(NOTE, serializeTranscriptNote(setProperty(noteOf(w.world), "keep-audio", "true")));
		const click = await w.keep.setKeepAudio(NOTE, false);
		assert.equal(click.changed, true, click.message);
		assert.match(click.message, TAKES_EFFECT);

		w.network.answer.open();
		await w.tick;
		await settled();

		assert.equal(kept(w.world), false);
		assert.match(readSection(noteOf(w.world), "agent") ?? "", /A summary\./);
	});
});

// --- The click that waits is never dropped -------------------------------------------------

describe("a keep click that waited", () => {
	function plainWorld() {
		const world = makeFakeWorld();
		world.clock.set("2026-10-19T09:50:00+02:00");
		world.vault.binaries.set(FILENAME, 20_000);
		const request = buildRequestNote({
			audio: FILENAME,
			audioBytes: 20_000,
			mode: "daily-log",
			recorded: "2026-10-19T09:35:39+02:00",
			speakerSplit: false,
			attempt: 1,
		});
		world.vault.seed(
			NOTE,
			serializeTranscriptNote(
				markDone(setProperty(request, "transcriber", "home-pc"), { at: "2026-10-19T09:48:44+02:00", seconds: 60, text: "Plain." }),
			),
		);
		const lifecycle = new Lifecycle(world);
		return { world, lifecycle, ...keepingFor(world, lifecycle) };
	}

	it("on a note nobody holds is applied at once, with the ordinary notice", async () => {
		const w = plainWorld();
		const click = await w.keep.setKeepAudio(NOTE, true);
		assert.equal(click.changed, true);
		assert.equal(click.message, "This recording's audio is kept");
		assert.equal(kept(w.world), true);
		assert.deepEqual(w.told, [], "nothing waited, so nothing is told afterwards");
	});

	it("is not dropped when something else takes the note the moment it is freed", async () => {
		const w = plainWorld();
		const first = gate();
		const second = gate();
		const heldFirst = w.lifecycle.exclusively(NOTE, () => first.opened);
		// Another writer is also waiting for the note, and was there before the click.
		let heldSecond: Promise<unknown> = Promise.resolve();
		w.lifecycle.whenFree(NOTE, () => {
			heldSecond = w.lifecycle.exclusively(NOTE, () => second.opened);
		});
		const click = await w.keep.setKeepAudio(NOTE, true);
		assert.equal(click.changed, true);
		assert.match(click.message, TAKES_EFFECT);

		first.open();
		await heldFirst;
		await settled();
		assert.equal(kept(w.world), false, "the second holder still has the note");

		second.open();
		await heldSecond;
		await settled();
		assert.equal(kept(w.world), true, "the click was applied once the note was free again");
	});

	it("tells the person what became of it when the audio was deleted meanwhile", async () => {
		const w = plainWorld();
		const hold = gate();
		const held = w.lifecycle.exclusively(NOTE, () => hold.opened);
		await w.keep.setKeepAudio(NOTE, true);
		w.world.vault.texts.set(NOTE, serializeTranscriptNote(setProperty(noteOf(w.world), "audio-deleted", "2026-10-19")));

		hold.open();
		await held;
		await settled();

		assert.equal(kept(w.world), false, "a deleted recording gets no keep flag");
		assert.equal(w.told.length, 1);
		assert.match(w.told[0], /already deleted/);
	});
});
