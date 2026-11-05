import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KeepActions } from "./keep-time.js";
import { RecordingActions } from "./lifecycle-actions.js";
import { Lifecycle, type VaultPort } from "./lifecycle.js";
import { makeFakeWorld, type FakeVault } from "./lifecycle-fakes.js";
import {
	buildRequestNote,
	formatTimestamp,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
} from "./transcript-note.js";

// Cancel may write without the note's guard only while the holder is the work it
// cancels. Any other holder has a write of its own pending, and a cancel
// that read the note before that write and saves after it drops the write. Each
// test stops the holder's write, starts the cancel, lets the holder's write
// land, and only then lets the cancel go on, so a cancel working from a copy it
// read earlier would overwrite what the holder wrote.

const AUDIO = "Recording 20261001090000.m4a";
const NOTE = "Recording 20261001090000.md";
const NOW = new Date("2026-10-10T12:00:00+02:00");

const settled = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
};

interface Gate {
	reached: Promise<void>;
	release(): void;
}

/** A view of the vault whose next read or write on the note can be stopped by the test. */
class GatedView implements VaultPort {
	private gate: { on: "read" | "write"; arrive: () => void; open: Promise<void> } | null = null;

	constructor(private readonly vault: FakeVault) {}

	holdNext(on: "read" | "write"): Gate {
		let arrive = (): void => {};
		let release = (): void => {};
		const reached = new Promise<void>((resolve) => (arrive = resolve));
		const open = new Promise<void>((resolve) => (release = resolve));
		this.gate = { on, arrive, open };
		return { reached, release };
	}

	private async pass(on: "read" | "write"): Promise<void> {
		const gate = this.gate;
		if (gate === null || gate.on !== on) return;
		this.gate = null;
		gate.arrive();
		await gate.open;
	}

	async read(path: string): Promise<string | null> {
		const snapshot = this.vault.texts.get(path) ?? null;
		await this.pass("read");
		return snapshot;
	}

	async write(path: string, text: string): Promise<void> {
		await this.pass("write");
		await this.vault.write(path, text);
	}

	create = (path: string, text: string): Promise<void> => this.vault.create(path, text);
	createBinary = (path: string, data: ArrayBuffer): Promise<void> => this.vault.createBinary(path, data);
	createFolder = (path: string): Promise<void> => this.vault.createFolder(path);
	trash = (path: string): Promise<void> => this.vault.trash(path);
	fileSize = (path: string): Promise<number | null> => this.vault.fileSize(path);
	listTranscriptNotes = (): Promise<string[]> => this.vault.listTranscriptNotes();
	linkText = (path: string, from: string): string => this.vault.linkText(path, from);
	availablePathForAttachment = (name: string, source: string): Promise<string> =>
		this.vault.availablePathForAttachment(name, source);
}

/** A recording still waiting for its transcript: something Cancel has work to cancel. */
function rig() {
	const world = makeFakeWorld();
	world.clock.set(NOW.toISOString());
	world.device.deviceRole = "ordinary";
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	world.vault.binaries.set(AUDIO, 5000);
	world.vault.seed(
		NOTE,
		serializeTranscriptNote(
			buildRequestNote({
				audio: AUDIO,
				audioBytes: 5000,
				mode: "daily-log",
				recorded: formatTimestamp(NOW, 120),
				speakerSplit: false,
				attempt: 1,
			}),
		),
	);
	const lifecycle = new Lifecycle(world);
	const view = new GatedView(world.vault);
	const exclusively = <T>(path: string, step: () => Promise<T>) => lifecycle.exclusively(path, step);
	const refresh = async (): Promise<void> => {};
	const actions = new RecordingActions({
		vault: view,
		clock: world.clock,
		settings: world.settings,
		exclusively,
		confirm: async () => true,
		refresh,
	});
	const keep = new KeepActions({
		vault: view,
		clock: world.clock,
		settings: world.settings,
		resolveFile: (target) => (world.vault.binaries.has(target) ? target : null),
		exclusively,
		whenFree: (path, run) => lifecycle.whenFree(path, run),
		tell: () => {},
		confirm: async () => true,
		refresh,
		notesLinkingTo: () => [],
	});
	const note = () => {
		const parsed = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
		assert.ok(parsed, "the transcript note exists");
		return parsed;
	};
	return { lifecycle, view, actions, keep, note };
}

describe("Cancel while a holder other than the work it cancels has the note", () => {
	it("a keep click applied when the note frees is not overwritten by a cancel that read the note before it", async () => {
		const r = rig();
		// The transcription holds the note; the click arrives meanwhile and waits for it.
		let finishWork = (): void => {};
		const work = r.lifecycle.exclusively(NOTE, () => new Promise<void>((resolve) => (finishWork = resolve)));
		const click = await r.keep.setKeepAudio(NOTE, true);
		assert.equal(click.changed, true, "the click is accepted");
		const keepWrite = r.view.holdNext("write");
		finishWork();
		await work;
		await keepWrite.reached; // the click holds the note, its write stopped

		const cancelRead = r.view.holdNext("read");
		const cancelled = r.actions.cancel(NOTE);
		await settled();
		keepWrite.release(); // the click's write lands
		await settled();
		assert.equal(readString(r.note(), "keep-audio"), "true", "the click's write landed");
		cancelRead.release(); // the cancel goes on, from whatever it read
		await cancelled;
		await settled();

		assert.equal(readString(r.note(), "keep-audio"), "true", "the cancel dropped the kept audio");
	});

	it("another by-hand write is not overwritten by a cancel that read the note before it", async () => {
		const r = rig();
		// Stands in for any other writer under the guard (an agent request, a naming, a removal).
		const holderWrite = r.view.holdNext("write");
		const holder = r.lifecycle.exclusively(NOTE, async () => {
			const text = await r.view.read(NOTE);
			const parsed = parseTranscriptNote(text ?? "");
			assert.ok(parsed);
			await r.view.write(NOTE, serializeTranscriptNote(setProperty(parsed, "keep-audio", "true")));
		});
		await holderWrite.reached;

		const cancelRead = r.view.holdNext("read");
		const cancelled = r.actions.cancel(NOTE);
		await settled();
		holderWrite.release();
		await holder;
		assert.equal(readString(r.note(), "keep-audio"), "true", "the holder's write landed");
		cancelRead.release();
		await cancelled;
		await settled();

		assert.equal(readString(r.note(), "keep-audio"), "true", "the cancel dropped the holder's write");
	});
});
