import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { pluginAdapters } from "./adapter-table.js";
import type { KeyStore } from "./key-store.js";
import { Lifecycle } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { findModel, type ModelEntry } from "./model-list.js";
import { FakeModelRunner } from "./model-runner-fakes.js";
import { FakeModelDisk, FakeNetwork as FakeModelNetwork } from "./model-store-fakes.js";
import { ModelStore } from "./model-store.js";
import { stateLine } from "./state-line.js";
import { parseTranscriptNote } from "./transcript-note.js";
import type { NetworkRequest, NetworkResponse } from "./transcriber-service.js";

const DAILY_LOG = "Journal/2026-10-19.md";
const MODEL = findModel("kb-whisper-tiny") as ModelEntry;

class CountingNetwork {
	readonly requests: NetworkRequest[] = [];
	async reach(): Promise<void> {}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return { status: 200, text: JSON.stringify({ text: "Hello." }) };
	}
}

const NO_KEYS: KeyStore = { get: () => null };

/** The table the plugin registers, over fakes; the cursor mode is on-device, the daily log a service whose key is missing. */
function world(): {
	world: FakeWorld;
	lifecycle: Lifecycle;
	network: CountingNetwork;
	runner: FakeModelRunner;
	models: ModelStore;
	disk: FakeModelDisk;
} {
	const w = makeFakeWorld();
	w.vault.seed(DAILY_LOG, "Earlier thought.\n");
	const network = new CountingNetwork();
	const disk = new FakeModelDisk();
	const models = new ModelStore({
		modelFolder: () => w.currentSettings.modelFolder,
		folder: disk,
		trash: disk,
		download: new FakeModelNetwork(),
	});
	const runner = new FakeModelRunner();
	const lifecycle = new Lifecycle(
		w,
		pluginAdapters(
			{ vault: w.vault, clock: w.clock, device: w.device, network, keys: NO_KEYS, audio: { read: async () => audioOfSize(20_000) } },
			models,
			runner,
			{ read: async () => null },
		),
	);
	return { world: w, lifecycle, network, runner, models, disk };
}

async function stop(lifecycle: Lifecycle, filename: string): Promise<void> {
	await lifecycle.recordingStopped({
		mode: "dailyLog",
		filename,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	});
}

/** The line #74's drawing shows for the note at `path`, as the lifecycle last saw it. */
async function drawn(w: FakeWorld, lifecycle: Lifecycle, path: string): Promise<string> {
	const status = lifecycle.statusOf(path);
	assert.ok(status, `the lifecycle knows ${path}`);
	const note = parseTranscriptNote((await w.vault.read(path)) ?? "");
	assert.ok(note);
	return stateLine(note, status, { now: w.clock.now(), utcOffsetMinutes: (at) => w.clock.utcOffsetMinutes(at) });
}

describe("the plugin's adapter table, seen through the drawn state line", () => {
	it("draws the service's missing-key reason after the waiting time, and sends nothing", async () => {
		const { world: w, lifecycle, network } = world();
		w.currentSettings.transcribers.dailyLog = {
			kind: "service",
			modelId: "",
			address: "http://127.0.0.1:9/v1",
			keyName: "stt-key",
			modelName: "whisper-1",
		};
		await stop(lifecycle, "Recording 20261019093539.m4a");
		await lifecycle.tick(w.clock.now());

		const line = await drawn(w, lifecycle, "Recording 20261019093539.md");
		assert.match(line, /^waiting since \d\d:\d\d — no key for 127\.0\.0\.1:9 on this device/);
		assert.equal(network.requests.length, 0);
	});

	it("draws the on-device model-absent reason after the waiting time", async () => {
		const { world: w, lifecycle } = world();
		w.currentSettings.transcribers.dailyLog = {
			kind: "on-device",
			modelId: MODEL.id,
			address: "",
			keyName: "",
			modelName: "",
		};
		await stop(lifecycle, "Recording 20261019093540.m4a");
		await lifecycle.tick(w.clock.now());

		const line = await drawn(w, lifecycle, "Recording 20261019093540.md");
		assert.match(line, /^waiting since \d\d:\d\d — model not on this device/);
	});

	it("hands the model runner it was given to the on-device adapter", async () => {
		const { world: w, lifecycle, runner, models, disk } = world();
		w.currentSettings.transcribers.dailyLog = {
			kind: "on-device",
			modelId: MODEL.id,
			address: "",
			keyName: "",
			modelName: "",
		};
		disk.place(MODEL);
		await models.refreshOne(MODEL.id);
		runner.text = "Hello from the model.";
		await stop(lifecycle, "Recording 20261019093541.m4a");
		await lifecycle.tick(w.clock.now());

		assert.equal(runner.jobs.length, 1);
		assert.equal(runner.jobs[0].model.id, MODEL.id);
		assert.match((await w.vault.read("Recording 20261019093541.md")) ?? "", /\nHello from the model\.\n/);
	});
});

describe("the plugin's adapter table and the service agent", () => {
	it("registers a service agent and both transcribers that need ports", () => {
		const w = makeFakeWorld();
		const disk = new FakeModelDisk();
		const models = new ModelStore({
			modelFolder: () => w.currentSettings.modelFolder,
			folder: disk,
			trash: disk,
			download: new FakeModelNetwork(),
		});
		const table = pluginAdapters(
			{ vault: w.vault, clock: w.clock, device: w.device, network: new CountingNetwork(), keys: NO_KEYS, audio: { read: async () => audioOfSize(20_000) } },
			models,
			new FakeModelRunner(),
			{ read: async () => null },
		);
		assert.equal(table.agents.service?.kind, "service");
		assert.equal(table.transcribers.service?.kind, "service");
		assert.equal(table.transcribers["on-device"]?.kind, "on-device");
	});
});
