import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	Lifecycle,
	defaultAdapters,
	type Adapters,
	type AgentAdapter,
	type StoppedRecording,
	type TranscriberAdapter,
} from "./lifecycle.js";
import { FakeDevice, audioOfSize, makeFakeWorld } from "./lifecycle-fakes.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";
const HOUR = 60 * 60_000;

function dailyStop(): StoppedRecording {
	return {
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	};
}

/**
 * A hand-off adapter that has a `tick`, which today's hand-off adapter does
 * not: when a later ticket gives the hand-off agent one, nothing but the
 * lifecycle stands between the serving device and a request that is not its to
 * take.
 */
function adaptersWithHandOffTicks() {
	const calls: string[] = [];
	const transcriber: TranscriberAdapter = {
		kind: "hand-off",
		requestsTranscriptNote: true,
		waitingReason: () => null,
		tick: async () => void calls.push("transcriber"),
	};
	const agent: AgentAdapter = {
		kind: "hand-off",
		waitingReason: () => null,
		tick: async () => void calls.push("agent"),
	};
	const adapters: Adapters = {
		transcribers: { ...defaultAdapters().transcribers, "hand-off": transcriber },
		agents: { ...defaultAdapters().agents, "hand-off": agent },
	};
	return { adapters, calls };
}

describe("a hand-off request is never taken", () => {
	it("is not given to a hand-off transcriber's tick on a serving device, however long it waits", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		world.currentSettings.transcribers.dailyLog.kind = "hand-off";
		const { adapters, calls } = adaptersWithHandOffTicks();
		const recorder = new Lifecycle({ ...world, device: new FakeDevice("laptop", "ordinary") }, adapters);
		const serving = new Lifecycle({ ...world, device: new FakeDevice("server", "serving") }, adapters);
		await recorder.recordingStopped(dailyStop());

		world.clock.advance(24 * HOUR);
		await serving.tick(world.clock.now());

		assert.deepEqual(calls, [], "the serving device handed nothing to the hand-off adapter");
	});

	it("is not given to a hand-off agent's tick on a serving device, however long it waits", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		world.currentSettings.agents.dailyLog.kind = "hand-off";
		const { adapters, calls } = adaptersWithHandOffTicks();
		const serving = new Lifecycle({ ...world, device: new FakeDevice("server", "serving") }, adapters);
		world.vault.seed(
			NOTE,
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
				"transcriber-at: 2026-10-19T09:36:00+02:00",
				"transcriber-attempt: 1",
				"agent: requested",
				"agent-attempt: 1",
				"---",
				"",
			].join("\n"),
		);

		world.clock.advance(HOUR);
		await serving.tick(world.clock.now());

		assert.deepEqual(calls, [], "the serving device handed nothing to the hand-off adapter");
	});

	it("is still given to the tick of a device that is not serving", async () => {
		const world = makeFakeWorld();
		world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		world.currentSettings.transcribers.dailyLog.kind = "hand-off";
		const { adapters, calls } = adaptersWithHandOffTicks();
		const recorder = new Lifecycle({ ...world, device: new FakeDevice("laptop", "ordinary") }, adapters);
		await recorder.recordingStopped(dailyStop());

		await recorder.tick(world.clock.now());

		assert.deepEqual(calls, ["transcriber"], "only a serving device is kept from a hand-off request");
	});
});
