import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type StoppedRecording } from "./lifecycle.js";
import { FakeDevice, audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import type { KeyStore } from "./key-store.js";
import {
	withServiceAdapter,
	type NetworkPort,
	type NetworkRequest,
	type NetworkResponse,
} from "./transcriber-service.js";
import {
	SERVING_GRACE_MS,
	graceStartedAt,
	holdsOwnClaim,
	inGracePeriod,
	isServedKind,
	letGoOfClaim,
} from "./serving-device.js";
import {
	parseTranscriptNote,
	readInteger,
	readString,
	deriveState,
	type TranscriptNote,
} from "./transcript-note.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";
const ADDRESS = "https://stt.example.test/v1";
const MINUTE = 60_000;

/** A service the test scripts: answers, or is unreachable, and counts what it was sent. */
class FakeNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	down = false;
	/** Milliseconds the address takes to answer the "does anybody answer" question. */
	reachDelayMs = 0;
	async reach(): Promise<void> {
		if (this.reachDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.reachDelayMs));
		if (this.down) throw new Error("unreachable");
	}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return { status: 200, text: JSON.stringify({ text: "Spoken words." }) };
	}
}

const noKeys: KeyStore = { get: () => null };

interface Device {
	lifecycle: Lifecycle;
	network: FakeNetwork;
	device: FakeDevice;
}

/**
 * One in-memory vault and one fake clock, shared; each device has its own
 * identity, network and lifecycle, as two machines sharing a synced vault do.
 */
function setUp(kind: "service" | "hand-off" = "service") {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, "Earlier thought.\n");
	world.currentSettings.transcribers.dailyLog = {
		kind,
		modelId: "",
		address: ADDRESS,
		keyName: "",
		modelName: "whisper-1",
	};
	const audio = {
		async read(link: string) {
			const size = world.vault.binaries.get(link);
			return size === undefined ? null : new Uint8Array(size).fill(0x41).buffer;
		},
	};
	function deviceNamed(name: string, role: "ordinary" | "serving"): Device {
		const device = new FakeDevice(name, role);
		const network = new FakeNetwork();
		const ports: FakeWorld = { ...world, device };
		const adapters = withServiceAdapter(defaultAdapters(), {
			vault: world.vault,
			clock: world.clock,
			device,
			network,
			keys: noKeys,
			audio,
			wait: async () => {}, // a serving device's two-minute wait, not waited out here
		});
		return { lifecycle: new Lifecycle(ports, adapters), network, device };
	}
	return { world, deviceNamed };
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
	const text = await world.vault.read(NOTE);
	assert.ok(text !== null, "the transcript note exists");
	const note = parseTranscriptNote(text);
	assert.ok(note !== null);
	return note;
}

describe("the serving device's grace period", () => {
	it("takes nothing before three minutes, and takes the recording at three", async () => {
		const { world, deviceNamed } = setUp();
		const recorder = deviceNamed("laptop", "ordinary");
		const serving = deviceNamed("server", "serving");
		await recorder.lifecycle.recordingStopped(dailyStop());
		recorder.network.down = true; // the laptop cannot reach the service

		world.clock.advance(SERVING_GRACE_MS - 1000);
		await serving.lifecycle.tick(world.clock.now());
		assert.equal(serving.network.requests.length, 0);
		assert.equal(readString(await noteOf(world), "transcriber"), undefined);

		world.clock.advance(1000);
		await serving.lifecycle.tick(world.clock.now());
		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber"), "server");
		assert.equal(readString(note, "transcriber-state"), "done");
		assert.equal(serving.network.requests.length, 1);
	});

	it("leaves the recording device with nothing to send once it is taken", async () => {
		const { world, deviceNamed } = setUp();
		const recorder = deviceNamed("laptop", "ordinary");
		const serving = deviceNamed("server", "serving");
		await recorder.lifecycle.recordingStopped(dailyStop());
		recorder.network.down = true;
		world.clock.advance(SERVING_GRACE_MS);
		await serving.lifecycle.tick(world.clock.now());

		recorder.network.down = false; // the laptop is back
		await recorder.lifecycle.tick(world.clock.now());
		assert.equal(recorder.network.requests.length, 0);
		assert.equal(readString(await noteOf(world), "transcriber"), "server");
	});

	it("does not hold a serving device back from a recording it made itself", async () => {
		const { world, deviceNamed } = setUp();
		const serving = deviceNamed("server", "serving");
		await serving.lifecycle.recordingStopped(dailyStop());
		await serving.lifecycle.tick(world.clock.now());
		assert.equal(serving.network.requests.length, 1);
		assert.equal(readString(await noteOf(world), "transcriber"), "server");
	});

	it("leaves the first writer working when a second device claims after seeing the note unclaimed", async () => {
		const { world, deviceNamed } = setUp();
		const recorder = deviceNamed("laptop", "ordinary");
		const first = deviceNamed("server", "serving");
		const second = deviceNamed("mini", "serving");
		await recorder.lifecycle.recordingStopped(dailyStop());
		recorder.network.down = true;
		world.clock.advance(SERVING_GRACE_MS);
		// Both read the note as waiting; the second one's address answers later.
		second.network.reachDelayMs = 20;
		const at = world.clock.now();
		await Promise.all([first.lifecycle.tick(at), second.lifecycle.tick(at)]);

		assert.equal(readString(await noteOf(world), "transcriber"), "server");
		assert.equal(first.network.requests.length, 1);
		assert.equal(second.network.requests.length, 0);
	});

	it("never takes a hand-off request, however long it waits", async () => {
		const { world, deviceNamed } = setUp("hand-off");
		const recorder = deviceNamed("laptop", "ordinary");
		const serving = deviceNamed("server", "serving");
		await recorder.lifecycle.recordingStopped(dailyStop());
		const before = await world.vault.read(NOTE);
		world.clock.advance(60 * MINUTE);
		await serving.lifecycle.tick(world.clock.now());
		assert.equal(await world.vault.read(NOTE), before);
		assert.equal(serving.network.requests.length, 0);
	});
});

describe("letting go of a claim", () => {
	/** A phone's send was started and never answered: the note says taken, in the phone's name. */
	async function phoneStuck() {
		const ctx = setUp();
		const phone = ctx.deviceNamed("phone", "ordinary");
		const serving = ctx.deviceNamed("server", "serving");
		await phone.lifecycle.recordingStopped(dailyStop());
		const text = (await ctx.world.vault.read(NOTE))!
			.replace("---\n", "---\n")
			.replace(/\n---\n/, "\ntranscriber: phone\ntranscriber-state: taken\ntranscriber-at: 2026-10-19T09:36:00+02:00\ntranscriber-attempt: 1\n---\n");
		await ctx.world.vault.write(NOTE, text);
		return { ...ctx, phone, serving };
	}

	it("is done by the phone alone: its lines come off and the attempt goes up by one", async () => {
		const { world, phone, serving } = await phoneStuck();
		world.clock.advance(10 * MINUTE);

		await serving.lifecycle.returnedToScreen(world.clock.now());
		const untouched = await noteOf(world);
		assert.equal(readString(untouched, "transcriber"), "phone", "no device releases another's claim");
		assert.equal(readInteger(untouched, "attempt"), 1);

		await phone.lifecycle.returnedToScreen(world.clock.now());
		const released = await noteOf(world);
		assert.equal(readString(released, "transcriber"), undefined);
		assert.equal(readString(released, "transcriber-state"), undefined);
		assert.equal(readInteger(released, "attempt"), 2);
		assert.equal(deriveState(released, world.clock.now(), 24).transcriber, "waiting");
	});

	it("lets the serving device take the released recording", async () => {
		const { world, phone, serving } = await phoneStuck();
		world.clock.advance(10 * MINUTE);
		await phone.lifecycle.returnedToScreen(world.clock.now());
		await serving.lifecycle.tick(world.clock.now());
		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber"), "server");
		assert.equal(readInteger(note, "transcriber-attempt"), 2);
		assert.equal(readString(note, "transcriber-state"), "done");
	});
});

describe("the rules", () => {
	const note = parseTranscriptNote(
		[
			"---",
			"rule-version: 1",
			'audio: "[[Recording 20261019093539.m4a]]"',
			"mode: daily-log",
			"recorded: 2026-10-19T09:35:39+02:00",
			"attempt: 1",
			"transcribe: requested",
			"transcriber: laptop",
			"transcriber-state: done",
			"transcriber-at: 2026-10-19T10:00:00+02:00",
			"transcriber-attempt: 1",
			"agent: requested",
			"agent-attempt: 1",
			"---",
			"",
		].join("\n"),
	)!;

	it("serves service and on-device for the transcriber, service for the agent, and never hand-off", () => {
		assert.equal(isServedKind("transcriber", "service"), true);
		assert.equal(isServedKind("transcriber", "on-device"), true);
		assert.equal(isServedKind("transcriber", "hand-off"), false);
		assert.equal(isServedKind("agent", "service"), true);
		assert.equal(isServedKind("agent", "hand-off"), false);
	});

	it("counts the transcriber's grace from recorded and the agent's from the transcript's done time", () => {
		assert.equal(graceStartedAt(note, "transcriber"), new Date("2026-10-19T09:35:39+02:00").getTime());
		assert.equal(graceStartedAt(note, "agent"), new Date("2026-10-19T10:00:00+02:00").getTime());
	});

	it("holds back the agent step inside its own grace period, counted from the done time", () => {
		const state = deriveState(note, new Date("2026-10-19T10:01:00+02:00"), 24);
		const ask = (at: string) =>
			inGracePeriod({
				step: "agent",
				kind: "service",
				state,
				note,
				now: new Date(at),
				serving: true,
				madeHere: false,
			});
		assert.equal(ask("2026-10-19T10:02:59+02:00"), true);
		assert.equal(ask("2026-10-19T10:03:00+02:00"), false);
	});

	it("recognises only its own unanswered claim", () => {
		const taken = parseTranscriptNote(
			"---\nrule-version: 1\nattempt: 2\ntranscriber: phone\ntranscriber-state: taken\ntranscriber-attempt: 2\n---\n",
		)!;
		assert.equal(holdsOwnClaim(taken, { id: "phone", name: "phone" }), true);
		assert.equal(holdsOwnClaim(taken, { id: "server", name: "server" }), false);
		assert.equal(readInteger(letGoOfClaim(taken), "attempt"), 3);
	});
});
