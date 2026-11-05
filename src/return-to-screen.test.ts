import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type StoppedRecording } from "./lifecycle.js";
import { FakeVault, audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { releaseLostSends, type ScreenPort } from "./screen-return.js";
import { HeldNetwork, IdentifiedDevice, settle } from "./serving-device-fakes.js";
import { withServiceAdapter } from "./transcriber-service.js";
import { parseTranscriptNote, readInteger, readString, type TranscriptNote } from "./transcript-note.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";

/** A vault whose next read can be held back by the test, to open the gap a slow disk opens. */
class GatedReadVault extends FakeVault {
	private gate: Promise<void> | null = null;

	/** The next read waits for the returned function to be called, and then returns the note as it is by then. */
	holdNextRead(): () => void {
		let open = () => {};
		this.gate = new Promise<void>((resolve) => (open = resolve));
		return open;
	}

	override async read(path: string): Promise<string | null> {
		const gate = this.gate;
		this.gate = null;
		if (gate !== null) await gate;
		return super.read(path);
	}
}

function setUp() {
	const world = makeFakeWorld();
	const vault = new GatedReadVault();
	vault.seed(DAILY_LOG, "Earlier thought.\n");
	world.currentSettings.transcribers.dailyLog = {
		kind: "service",
		modelId: "",
		address: "https://stt.example.test/v1",
		keyName: "",
		modelName: "whisper-1",
	};
	const audio = {
		async read() {
			return new Uint8Array(20_000).fill(0x41).buffer;
		},
	};
	/** One run of Obsidian on a device: a lifecycle of its own over the shared vault. */
	function run(device: IdentifiedDevice) {
		const network = new HeldNetwork();
		const ports: FakeWorld = { ...world, vault, device };
		const adapters = withServiceAdapter(defaultAdapters(), {
			vault,
			clock: world.clock,
			device,
			network,
			keys: { get: () => null },
			audio,
			wait: async () => {},
		});
		return { lifecycle: new Lifecycle(ports, adapters), network };
	}
	return { world, vault, run };
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

async function noteOf(vault: FakeVault): Promise<TranscriptNote> {
	const note = parseTranscriptNote((await vault.read(NOTE)) ?? "");
	assert.ok(note !== null, "the transcript note exists");
	return note;
}

/** The screen, by hand: a test hides and shows Obsidian, and says when the layout is ready. */
class FakeScreen implements ScreenPort {
	hidden = false;
	private readonly changes: Array<() => void> = [];
	private readonly ready: Array<() => void> = [];
	isHidden(): boolean {
		return this.hidden;
	}
	onVisibilityChange(callback: () => void): void {
		this.changes.push(callback);
	}
	whenReady(callback: () => void): void {
		this.ready.push(callback);
	}
	layoutReady(): void {
		for (const callback of this.ready) callback();
	}
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		for (const callback of this.changes) callback();
	}
}

describe("returning to the screen while a tick claims the same note", () => {
	it("does not let go of a claim a tick has just written, so the recording is sent once", async () => {
		const { world, vault, run } = setUp();
		const { lifecycle, network } = run(new IdentifiedDevice("desktop", "ordinary", "id-desktop"));
		await lifecycle.recordingStopped(dailyStop());
		const now = world.clock.now();

		const openRead = vault.holdNextRead();
		const returning = lifecycle.returnedToScreen(now); // its read of the note is held back
		await settle();
		const ticking = lifecycle.tick(now); // meanwhile a tick runs: it may claim the note and send
		await settle();
		openRead();
		await returning;
		network.answerAll();
		await ticking;

		assert.equal(readInteger(await noteOf(vault), "attempt"), 1, "the attempt was not raised");
		const again = lifecycle.tick(now);
		await settle();
		network.answerAll();
		await again;
		assert.equal(network.requests.length, 1, "the recording was sent once");
		assert.equal(readString(await noteOf(vault), "transcriber-state"), "done");
	});
});

describe("letting go of a send lost while Obsidian was away", () => {
	/** A send that was started, and never answered, by an earlier run of Obsidian on this device. */
	async function strandedByEarlierRun() {
		const ctx = setUp();
		const device = new IdentifiedDevice("phone", "ordinary", "id-phone");
		const earlier = ctx.run(device);
		await earlier.lifecycle.recordingStopped(dailyStop());
		void earlier.lifecycle.tick(ctx.world.clock.now());
		await settle();
		assert.equal(readString(await noteOf(ctx.vault), "transcriber-state"), "taken");
		return { ...ctx, device, earlier };
	}

	it("is done once when Obsidian starts afresh, with nothing returning to the screen", async () => {
		const { world, vault, run, device } = await strandedByEarlierRun();
		world.clock.advance(10 * 60_000);
		const screen = new FakeScreen();
		const afresh = run(device); // Obsidian was killed and started again: nothing is sending
		releaseLostSends(afresh.lifecycle, screen, () => world.clock.now());

		screen.layoutReady();
		await settle();

		const note = await noteOf(vault);
		assert.equal(readString(note, "transcriber"), undefined);
		assert.equal(readInteger(note, "attempt"), 2);
	});

	it("is done when Obsidian comes back on the screen, and not while it is hidden", async () => {
		const { world, vault, run, device } = await strandedByEarlierRun();
		world.clock.advance(10 * 60_000);
		const screen = new FakeScreen();
		const resumed = run(device); // a phone that resumed: the earlier run's send is gone
		releaseLostSends(resumed.lifecycle, screen, () => world.clock.now());

		screen.setHidden(true);
		await settle();
		assert.equal(readInteger(await noteOf(vault), "attempt"), 1, "nothing is let go of while hidden");

		screen.setHidden(false);
		await settle();
		const note = await noteOf(vault);
		assert.equal(readString(note, "transcriber"), undefined);
		assert.equal(readInteger(note, "attempt"), 2);
	});

	it("leaves a send still under way in this run alone", async () => {
		const { world, vault, earlier } = await strandedByEarlierRun();
		const screen = new FakeScreen();
		releaseLostSends(earlier.lifecycle, screen, () => world.clock.now());

		screen.layoutReady();
		screen.setHidden(true);
		screen.setHidden(false);
		await settle();

		const note = await noteOf(vault);
		assert.equal(readString(note, "transcriber"), "phone", "the send under way keeps its claim");
		assert.equal(readInteger(note, "attempt"), 1);
	});
});

describe("a send that never came back while Obsidian was off the screen", () => {
	/** A send started in this run and never answered: its promise stays pending. */
	async function pendingSend(phone: boolean) {
		const ctx = setUp();
		const device = new IdentifiedDevice("phone", "ordinary", "id-phone");
		device.phone = phone;
		const current = ctx.run(device);
		await current.lifecycle.recordingStopped(dailyStop());
		void current.lifecycle.tick(ctx.world.clock.now());
		await settle();
		const screen = new FakeScreen();
		releaseLostSends(current.lifecycle, screen, () => ctx.world.clock.now());
		return { ...ctx, current, screen };
	}

	it("is let go of on a phone even while its promise is pending, and the recording is sent again", async () => {
		const { world, vault, current, screen } = await pendingSend(true);

		screen.setHidden(true);
		world.clock.advance(10 * 60_000);
		screen.setHidden(false);
		await settle();

		const note = await noteOf(vault);
		assert.equal(readString(note, "transcriber"), undefined);
		assert.equal(readInteger(note, "attempt"), 2);
		void current.lifecycle.tick(world.clock.now());
		await settle();
		assert.equal(current.network.requests.length, 2, "the lost send was replaced by a new one");
	});

	it("is left alone on a desktop, which does not suspend Obsidian", async () => {
		const { world, vault, screen } = await pendingSend(false);

		screen.setHidden(true);
		world.clock.advance(10 * 60_000);
		screen.setHidden(false);
		await settle();

		const note = await noteOf(vault);
		assert.equal(readString(note, "transcriber"), "phone");
		assert.equal(readInteger(note, "attempt"), 1);
	});
});
