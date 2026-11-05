import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type StoppedRecording } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { IdentifiedDevice, HeldNetwork, settle } from "./serving-device-fakes.js";
import { withServiceAdapter } from "./transcriber-service.js";
import {
	parseTranscriptNote,
	readInteger,
	readString,
	type TranscriptNote,
} from "./transcript-note.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";

function setUp() {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, "Earlier thought.\n");
	world.currentSettings.transcribers.dailyLog = {
		kind: "service",
		modelId: "",
		address: "https://stt.example.test/v1",
		keyName: "",
		modelName: "whisper-1",
	};
	const audio = {
		async read(link: string) {
			const size = world.vault.binaries.get(link);
			return size === undefined ? null : new Uint8Array(size).fill(0x41).buffer;
		},
	};
	/** One run of Obsidian on a device: a lifecycle of its own, over the shared vault. */
	function run(device: IdentifiedDevice, network = new HeldNetwork()) {
		const ports: FakeWorld = { ...world, device };
		const adapters = withServiceAdapter(defaultAdapters(), {
			vault: world.vault,
			clock: world.clock,
			device,
			network,
			keys: { get: () => null },
			audio,
			wait: async () => {},
		});
		return { lifecycle: new Lifecycle(ports, adapters), network };
	}
	return { world, run };
}

function dailyStop(): StoppedRecording {
	return {
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	};
}

async function noteOf(world: FakeWorld): Promise<TranscriptNote> {
	const note = parseTranscriptNote((await world.vault.read(NOTE)) ?? "");
	assert.ok(note !== null, "the transcript note exists");
	return note;
}

describe("a claim names its device, not only the device's name", () => {
	it("is not let go of by another device that has the same default name", async () => {
		const { world, run } = setUp();
		const sender = run(new IdentifiedDevice("desktop", "ordinary", "id-of-the-first"));
		const other = run(new IdentifiedDevice("desktop", "ordinary", "id-of-the-second"));
		await sender.lifecycle.recordingStopped(dailyStop());
		const sending = sender.lifecycle.tick(world.clock.now());
		await settle();
		assert.equal(readString(await noteOf(world), "transcriber-state"), "taken");

		await other.lifecycle.returnedToScreen(world.clock.now());

		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber"), "desktop", "the claim is still there");
		assert.equal(readInteger(note, "attempt"), 1, "the attempt was not raised");
		sender.network.answerAll();
		await sending;
		assert.equal(readString(await noteOf(world), "transcriber-state"), "done");
		assert.equal(sender.network.requests.length, 1);
	});

	it("can still be let go of by its own device after the device was renamed", async () => {
		const { world, run } = setUp();
		const device = new IdentifiedDevice("laptop", "ordinary", "id-of-the-laptop");
		const before = run(device);
		await before.lifecycle.recordingStopped(dailyStop());
		void before.lifecycle.tick(world.clock.now());
		await settle();
		assert.equal(readString(await noteOf(world), "transcriber"), "laptop");

		device.deviceName = "work laptop"; // renamed while the claim was pending
		const after = run(device); // Obsidian started afresh: nothing is sending
		await after.lifecycle.returnedToScreen(world.clock.now());

		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber"), undefined);
		assert.equal(readInteger(note, "attempt"), 2);
	});
});
