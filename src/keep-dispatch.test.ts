import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KeepActions } from "./keep-time.js";
import { FakeVault, makeFakeWorld } from "./lifecycle-fakes.js";
import {
	buildRequestNote,
	markDone,
	markTaken,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
} from "./transcript-note.js";

// "Keep audio" and "Stop keeping audio" reach the vault through
// `KeepActions.setKeepAudio`, the one entry the command and the note's button
// both go through. These tests hold it to the note's guard: the write must
// happen inside `exclusively` for that note.

const AUDIO = "Recording 20261001090000.m4a";
const NOTE = "Recording 20261001090000.md";

/** Records, for every note write, which note's guard was held at the time. */
class GuardedVault extends FakeVault {
	inside: string | null = null;
	readonly writes: { path: string; insideFor: string | null }[] = [];
	override async write(path: string, text: string): Promise<void> {
		this.writes.push({ path, insideFor: this.inside });
		await super.write(path, text);
	}
}

function recordingWorld(keeping: boolean) {
	const world = makeFakeWorld();
	const vault = new GuardedVault();
	world.vault = vault;
	vault.binaries.set(AUDIO, 5000);
	let note = markDone(
		markTaken(
			buildRequestNote({
				audio: AUDIO,
				audioBytes: 5000,
				mode: "daily-log",
				recorded: "2026-10-01T09:00:00+02:00",
				speakerSplit: false,
				attempt: 1,
			}),
			{ name: "pc", at: "2026-10-01T09:01:00+02:00" },
		),
		{ at: "2026-10-01T09:02:00+02:00", seconds: 60, text: "Plain words." },
	);
	if (keeping) note = setProperty(note, "keep-audio", "true");
	vault.seed(NOTE, serializeTranscriptNote(note));
	const guarded: string[] = [];
	const actions = new KeepActions({
		vault,
		clock: world.clock,
		settings: world.settings,
		resolveFile: (target) => (vault.binaries.has(target) ? target : null),
		exclusively: async <T>(path: string, run: () => Promise<T>) => {
			guarded.push(path);
			vault.inside = path;
			try {
				return { ran: true as const, value: await run() };
			} finally {
				vault.inside = null;
			}
		},
		whenFree: (_path, run) => run(),
		tell: () => {},
		confirm: async () => true,
		refresh: async () => {},
		notesLinkingTo: () => [],
	});
	return { actions, vault, guarded };
}

describe("the by-hand keep actions", () => {
	for (const [keep, label] of [
		[true, "Keep audio"],
		[false, "Stop keeping audio"],
	] as const) {
		it(`${label} writes inside the note's guard`, async () => {
			const world = recordingWorld(!keep);
			const result = await world.actions.setKeepAudio(NOTE, keep);
			assert.equal(result.changed, true);
			assert.deepEqual(world.guarded, [NOTE]);
			assert.deepEqual(world.vault.writes, [{ path: NOTE, insideFor: NOTE }]);
			const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(note);
			assert.equal(readString(note, "keep-audio") !== undefined, keep);
		});
	}
});
