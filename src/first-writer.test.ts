import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type StoppedRecording } from "./lifecycle.js";
import { FakeVault, audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { findModel, type ModelEntry } from "./model-list.js";
import { FakeAudio, FakeModelRunner } from "./model-runner-fakes.js";
import { FakeModelDisk, FakeNetwork as FakeModelNetwork } from "./model-store-fakes.js";
import { ModelStore } from "./model-store.js";
import { SERVING_GRACE_MS } from "./serving-device.js";
import { HeldNetwork, IdentifiedDevice, settle } from "./serving-device-fakes.js";
import { createOnDeviceTranscriber } from "./transcriber-on-device.js";
import {
	withServiceAdapter,
	type NetworkPort,
	type NetworkRequest,
	type NetworkResponse,
} from "./transcriber-service.js";
import {
	deriveState,
	parseTranscriptNote,
	readString,
	type TranscriptNote,
} from "./transcript-note.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";
const MODEL = findModel("kb-whisper-tiny") as ModelEntry;

/**
 * One device's copy of a synced vault. Its writes reach the other copies only
 * when the test says Sync has run, and where two copies were written the
 * later write wins on all, as Sync settles a clash.
 */
class SyncedCopy extends FakeVault {
	constructor(private readonly bus: SyncBus) {
		super();
	}

	override async write(path: string, text: string): Promise<void> {
		await super.write(path, text);
		this.bus.record(path, text);
	}

	override async create(path: string, text: string): Promise<void> {
		await super.create(path, text);
		this.bus.record(path, text);
	}
}

class SyncBus {
	readonly copies: SyncedCopy[] = [];
	private readonly latest = new Map<string, string>();

	copy(): SyncedCopy {
		const copy = new SyncedCopy(this);
		this.copies.push(copy);
		return copy;
	}

	record(path: string, text: string): void {
		this.latest.delete(path); // re-inserted last, so the order of the map is the order of the writes
		this.latest.set(path, text);
	}

	/** Sync runs: every copy ends up with the latest write of every file. */
	deliver(): void {
		for (const [path, text] of this.latest) {
			for (const copy of this.copies) copy.texts.set(path, text);
		}
	}
}

/** A service that answers at once and counts what it was sent. */
class AnsweringNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	async reach(): Promise<void> {}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return { status: 200, text: JSON.stringify({ text: "Spoken words." }) };
	}
}

const audioOf = {
	async read() {
		return new Uint8Array(20_000).fill(0x41).buffer;
	},
};

function dailyStop(): StoppedRecording {
	return {
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	};
}

function entryOf(kind: "service" | "on-device") {
	return {
		kind,
		modelId: kind === "on-device" ? MODEL.id : "",
		address: kind === "service" ? "https://stt.example.test/v1" : "",
		keyName: "",
		modelName: kind === "service" ? "whisper-1" : "",
	};
}

describe("first writer wins, for the service transcriber", () => {
	it("lets only one of two serving devices send when their claims cross in Sync", async () => {
		const bus = new SyncBus();
		const world = makeFakeWorld();
		world.currentSettings.transcribers.dailyLog = entryOf("service");
		const sync = async () => {
			await settle(); // both claims are written before Sync runs
			bus.deliver();
		};
		function serving(name: string) {
			const vault = bus.copy();
			vault.seed(DAILY_LOG, "Earlier thought.\n");
			const device = new IdentifiedDevice(name, "serving", `id-of-${name}`);
			const network = new AnsweringNetwork();
			const adapters = withServiceAdapter(defaultAdapters(), {
				vault,
				clock: world.clock,
				device,
				network,
				keys: { get: () => null },
				audio: audioOf,
				wait: sync,
			});
			const ports: FakeWorld = { ...world, vault, device };
			return { vault, network, lifecycle: new Lifecycle(ports, adapters) };
		}
		const recorderVault = bus.copy();
		recorderVault.seed(DAILY_LOG, "Earlier thought.\n");
		// The laptop makes the request note; it never ticks, so it sends nothing.
		const laptop = new IdentifiedDevice("laptop", "ordinary", "id-laptop");
		const recorder = new Lifecycle(
			{ ...world, vault: recorderVault, device: laptop },
			withServiceAdapter(defaultAdapters(), {
				vault: recorderVault,
				clock: world.clock,
				device: laptop,
				network: new AnsweringNetwork(),
				keys: { get: () => null },
				audio: audioOf,
				wait: sync,
			}),
		);
		await recorder.recordingStopped(dailyStop());
		const first = serving("server");
		const second = serving("mini");
		bus.deliver();

		world.clock.advance(SERVING_GRACE_MS);
		await Promise.all([first.lifecycle.tick(world.clock.now()), second.lifecycle.tick(world.clock.now())]);
		bus.deliver();

		assert.equal(first.network.requests.length + second.network.requests.length, 1, "one send in all");
		const note = parseTranscriptNote((await first.vault.read(NOTE)) ?? "");
		assert.ok(note !== null);
		assert.equal(readString(note, "transcriber-state"), "done");
		const winner = readString(note, "transcriber");
		const sender = winner === "server" ? first : second;
		assert.equal(sender.network.requests.length, 1, "the device named in the note is the one that sent");
	});

	it("does not write an answer over a claim another device has taken since", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		world.currentSettings.transcribers.dailyLog = entryOf("service");
		const device = new IdentifiedDevice("desktop", "ordinary", "id-first");
		const network = new HeldNetwork();
		const adapters = withServiceAdapter(defaultAdapters(), {
			vault: world.vault,
			clock: world.clock,
			device,
			network,
			keys: { get: () => null },
			audio: audioOf,
			wait: async () => {},
		});
		const lifecycle = new Lifecycle({ ...world, device }, adapters);
		await lifecycle.recordingStopped(dailyStop());
		const sending = lifecycle.tick(world.clock.now());
		await settle();

		// The other device's claim reaches this one while its send is out.
		const taken = (await world.vault.read(NOTE))!
			.replace("transcriber: desktop", "transcriber: other")
			.replace("transcriber-device: id-first", "transcriber-device: id-other");
		await world.vault.write(NOTE, taken);
		network.answerAll();
		await sending;

		const note = parseTranscriptNote((await world.vault.read(NOTE)) ?? "");
		assert.ok(note !== null);
		assert.equal(readString(note, "transcriber"), "other");
		assert.equal(readString(note, "transcriber-state"), "taken", "this device's answer was dropped");
	});
});

describe("first writer wins, for the on-device transcriber", () => {
	it("refuses a note another device has already claimed for this attempt", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		world.currentSettings.transcribers.dailyLog = entryOf("on-device");
		const disk = new FakeModelDisk();
		disk.place(MODEL);
		const store = new ModelStore({
			modelFolder: () => world.currentSettings.modelFolder,
			folder: disk,
			trash: disk,
			download: new FakeModelNetwork(),
		});
		await store.refreshOne(MODEL.id);
		const audio = new FakeAudio();
		audio.recordings.set(FILENAME, audioOfSize(20_000));
		function onDevice(name: string, role: "ordinary" | "serving") {
			const device = new IdentifiedDevice(name, role, `id-of-${name}`);
			const runner = new FakeModelRunner();
			const adapter = createOnDeviceTranscriber(store, {
				vault: world.vault,
				clock: world.clock,
				device,
				audio,
				runner,
				wait: async () => {},
			});
			const adapters = {
				...defaultAdapters(),
				transcribers: { ...defaultAdapters().transcribers, "on-device": adapter },
			};
			return { adapter, runner, lifecycle: new Lifecycle({ ...world, device }, adapters) };
		}
		const first = onDevice("first", "ordinary");
		const second = onDevice("second", "serving");
		await first.lifecycle.recordingStopped(dailyStop());
		// The second device read the note as waiting before the first's claim reached it.
		const stale = parseTranscriptNote((await world.vault.read(NOTE))!) as TranscriptNote;
		let release = () => {};
		first.runner.script = () => new Promise<void>((resolve) => (release = resolve));
		const running = first.lifecycle.tick(world.clock.now()); // the first claims; its run is held
		await settle();
		assert.equal(readString(parseTranscriptNote((await world.vault.read(NOTE))!)!, "transcriber"), "first");

		await second.adapter.tick!({
			path: NOTE,
			note: stale,
			state: deriveState(stale, world.clock.now(), 24),
			mode: "dailyLog",
			entry: entryOf("on-device"),
			now: world.clock.now(),
		});

		const note = parseTranscriptNote((await world.vault.read(NOTE))!)!;
		assert.equal(readString(note, "transcriber"), "first", "the first writer keeps the claim");
		assert.equal(second.runner.jobs.length, 0, "the second device ran nothing");
		release();
		await running;
		assert.equal(readString(parseTranscriptNote((await world.vault.read(NOTE))!)!, "transcriber-state"), "done");
	});
});
