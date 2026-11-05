import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type TranscriberAdapter } from "./lifecycle.js";
import { makeFakeWorld } from "./lifecycle-fakes.js";

const REQUEST_NOTE = [
	"---",
	"rule-version: 1",
	'audio: "[[Recording 20261019093539.m4a]]"',
	"audio-bytes: 20000",
	"mode: daily-log",
	"recorded: 2026-10-19T09:35:39+02:00",
	"speaker-split: false",
	"attempt: 1",
	"transcribe: requested",
	"---",
	"",
].join("\n");

/** A hand-off adapter whose `tick` stays open until the test lets it finish. */
function slowAdapter(): {
	adapter: TranscriberAdapter;
	calls: () => number;
	finish: () => void;
} {
	let calls = 0;
	let release: () => void = () => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter: TranscriberAdapter = {
		...defaultAdapters().transcribers["hand-off"]!,
		async tick() {
			calls++;
			await open;
		},
	};
	return { adapter, calls: () => calls, finish: release };
}

function lifecycleWith(adapter: TranscriberAdapter) {
	const world = makeFakeWorld();
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	world.vault.seed("Recording 20261019093539.md", REQUEST_NOTE);
	const base = defaultAdapters();
	const lifecycle = new Lifecycle(world, {
		...base,
		transcribers: { ...base.transcribers, "hand-off": adapter },
	});
	return { world, lifecycle };
}

describe("a tick that starts while the previous one is running", () => {
	it("does nothing: the adapter is handed the note once", async () => {
		const slow = slowAdapter();
		const { world, lifecycle } = lifecycleWith(slow.adapter);
		const first = lifecycle.tick(world.clock.now());
		const second = lifecycle.tick(world.clock.now());
		// Returns at once, while the first is still open. Without the guard it
		// waits on the open adapter too, so the wait is cut off to fail, not hang.
		const outcome = await Promise.race([
			second.then(() => "returned"),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
		]);
		assert.equal(outcome, "returned");
		await new Promise((resolve) => setImmediate(resolve)); // let the first reach the adapter
		assert.equal(slow.calls(), 1);
		slow.finish();
		await first;
		assert.equal(slow.calls(), 1);
	});

	it("is followed by a tick that runs, once the first has finished", async () => {
		const slow = slowAdapter();
		const { world, lifecycle } = lifecycleWith(slow.adapter);
		slow.finish();
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(slow.calls(), 2);
	});

	it("is not blocked for good by a tick whose listing threw", async () => {
		const slow = slowAdapter();
		const { world, lifecycle } = lifecycleWith(slow.adapter);
		slow.finish();
		const list = world.vault.listTranscriptNotes.bind(world.vault);
		let failOnce = true;
		world.vault.listTranscriptNotes = async () => {
			if (failOnce) {
				failOnce = false;
				throw new Error("vault not ready");
			}
			return list();
		};
		await assert.rejects(lifecycle.tick(world.clock.now()), /vault not ready/);
		await lifecycle.tick(world.clock.now());
		assert.equal(slow.calls(), 1);
	});
});
