import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KeepActions, KeepTime } from "./keep-time.js";
import { Lifecycle, defaultAdapters, type AgentAdapter, type VaultPort } from "./lifecycle.js";
import { makeFakeWorld, type FakeVault, type FakeWorld } from "./lifecycle-fakes.js";
import {
	buildRequestNote,
	formatTimestamp,
	markAgentDone,
	markAgentRequested,
	markDone,
	markTaken,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note.js";

// The keep time's deletion and the lifecycle's writers (the agent's claim and
// answer, the request for the agent) each read a whole note and write it back.
// These tests hold one writer's read open while the other works, which is the
// interleaving a slow network call on the lifecycle's tick makes possible.

const AUDIO = "Recording 20261001090000.m4a";
const NOTE = "Recording 20261001090000.md";
const NOW = new Date("2026-11-10T12:00:00+02:00");
const stamp = (daysAgo: number): string => formatTimestamp(new Date(NOW.getTime() - daysAgo * 86_400_000), 120);

/** A done transcript from 31 days ago, 30 days being the keep time; optionally with the agent already asked for. */
function doneNote(agentRequested: boolean): string {
	let note: TranscriptNote = buildRequestNote({
		audio: AUDIO,
		audioBytes: 5000,
		mode: "daily-log",
		recorded: stamp(31.01),
		speakerSplit: false,
		attempt: 1,
	});
	note = markDone(markTaken(note, { name: "pc", at: stamp(31) }), { at: stamp(31), seconds: 60, text: "Plain words." });
	if (agentRequested) note = markAgentRequested(note);
	return serializeTranscriptNote(note);
}

/**
 * One reader's view of the vault: its `read` takes the file's text at the
 * moment of the call but answers only when the test lets it, so the test
 * decides which writer sees what.
 */
class GatedView implements VaultPort {
	readonly pending: (() => void)[] = [];

	constructor(private readonly vault: FakeVault) {}

	read(path: string): Promise<string | null> {
		const snapshot = this.vault.texts.get(path) ?? null;
		return new Promise((resolve) => this.pending.push(() => resolve(snapshot)));
	}

	write = (path: string, text: string): Promise<void> => this.vault.write(path, text);
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Rig {
	world: FakeWorld;
	lifecycle: Lifecycle;
	keepTime: KeepTime;
	keepView: GatedView;
	agentView: GatedView;
	note(): TranscriptNote;
	/** Let every pending read through, `order` naming whose goes first, until all the promises are done. */
	run(order: ("keep" | "agent")[], ...promises: Promise<unknown>[]): Promise<void>;
}

function rig(text: string): Rig {
	const world = makeFakeWorld();
	world.clock.set(NOW.toISOString());
	// An ordinary desktop: a serving device leaves a hand-off agent alone.
	world.device.deviceRole = "ordinary";
	world.currentSettings.keepTimeDays = 30;
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	world.currentSettings.agents.dailyLog.kind = "hand-off";
	world.vault.binaries.set(AUDIO, 5000);
	world.vault.seed(NOTE, text);
	const keepView = new GatedView(world.vault);
	const agentView = new GatedView(world.vault);
	// An agent that does what the service agent does: read the note, then
	// write its answer over what it read.
	const agent: AgentAdapter = {
		...defaultAdapters().agents["hand-off"]!,
		async tick({ path }) {
			const read = await agentView.read(path);
			const note = parseTranscriptNote(read ?? "");
			assert.ok(note);
			await agentView.write(path, serializeTranscriptNote(markAgentDone(note, { at: stamp(0), text: "The answer." })));
		},
	};
	const base = defaultAdapters();
	const lifecycle = new Lifecycle(world, { ...base, agents: { ...base.agents, "hand-off": agent } });
	const keepTime = new KeepTime({
		vault: keepView,
		clock: world.clock,
		device: world.device,
		settings: world.settings,
		resolveFile: (target) => (world.vault.binaries.has(target) ? target : null),
		exclusively: (path, fn) => lifecycle.exclusively(path, fn),
	});
	return {
		world,
		lifecycle,
		keepTime,
		keepView,
		agentView,
		note: () => {
			const note = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(note);
			return note;
		},
		async run(order, ...promises) {
			let done = 0;
			const all = Promise.all(promises).then(() => {
				done = 1;
			});
			for (let turn = 0; turn < 50 && done === 0; turn++) {
				await settle();
				for (const who of order) {
					const view = who === "keep" ? keepView : agentView;
					view.pending.shift()?.();
					await settle();
				}
			}
			await all;
		},
	};
}

describe("the keep time and the agent's answer on one note", () => {
	it("an answer that lands while the deletion has the note open is not overwritten, and the line survives too", async () => {
		const r = rig(doneNote(true));
		const lifecycleTick = r.lifecycle.tick(NOW); // the agent reads the note
		await settle();
		await settle();
		const keepTick = r.keepTime.tick(NOW); // the deletion reads it too, if it is let to
		await settle();
		// The agent finishes first, then the deletion's older copy would go back.
		await r.run(["agent", "keep"], lifecycleTick, keepTick);
		// The deletion that was kept out of the way happens on the next tick.
		await r.run(["agent", "keep"], r.keepTime.tick(NOW));
		assert.equal(readString(r.note(), "agent-state"), "done");
		assert.equal(readString(r.note(), "audio-deleted") !== undefined, true);
		assert.deepEqual(r.world.vault.trashed, [AUDIO]);
	});

	it("an answer written from a copy read before the deletion does not take the line away", async () => {
		const r = rig(doneNote(true));
		const keepTick = r.keepTime.tick(NOW); // the deletion reads the note first
		await settle();
		const lifecycleTick = r.lifecycle.tick(NOW); // the agent reads it next, if it is let to
		await settle();
		await settle();
		await r.run(["keep", "agent"], keepTick, lifecycleTick);
		// What the guard kept out of the way runs on the next tick.
		await r.run(["keep", "agent"], r.lifecycle.tick(NOW));
		assert.equal(readString(r.note(), "audio-deleted") !== undefined, true);
		assert.deepEqual(r.world.vault.trashed, [AUDIO]);
		assert.equal(readString(r.note(), "agent-state"), "done");
	});

	it("the request for the agent is not lost to a deletion that read the note first", async () => {
		const r = rig(doneNote(false));
		// The agent is asked for only a transcript newer than the overdue time.
		r.world.currentSettings.overdueHours = 24 * 60;
		const keepTick = r.keepTime.tick(NOW);
		await settle();
		const lifecycleTick = r.lifecycle.tick(NOW);
		await r.run(["keep", "agent"], keepTick, lifecycleTick);
		await r.run(["keep", "agent"], r.lifecycle.tick(NOW));
		assert.equal(readString(r.note(), "audio-deleted") !== undefined, true);
		assert.equal(readString(r.note(), "agent"), "requested");
		assert.deepEqual(r.world.vault.trashed, [AUDIO]);
	});
});

describe("keeping the audio by hand and the agent's answer on one note", () => {
	/** "Keep audio" as the plugin wires it: `KeepActions` given the lifecycle's guard, reading through the gated view. */
	function keepByHand(r: Rig, keep: boolean) {
		const actions = new KeepActions({
			vault: r.keepView,
			clock: r.world.clock,
			settings: r.world.settings,
			resolveFile: (target) => (r.world.vault.binaries.has(target) ? target : null),
			exclusively: (path, step) => r.lifecycle.exclusively(path, step),
			whenFree: (path, run) => r.lifecycle.whenFree(path, run),
			tell: () => {},
			confirm: async () => true,
			refresh: async () => {},
			notesLinkingTo: () => [],
		});
		return actions.setKeepAudio(NOTE, keep);
	}

	it("an answer being written is not overwritten by the keep flag, and the flag is set once the answer is written", async () => {
		const r = rig(doneNote(true));
		const lifecycleTick = r.lifecycle.tick(NOW); // the agent reads the note
		await settle();
		await settle();
		const first = keepByHand(r, true); // the click, while the agent has the note open
		await settle();
		await r.run(["agent", "keep"], lifecycleTick, first);
		// The click is accepted while the note is busy and applied by itself when the note is free:
		// let its read through, a bounded number of turns.
		for (let turn = 0; turn < 20; turn++) {
			await settle();
			r.keepView.pending.shift()?.();
		}
		assert.equal((await first).changed, true, "the click is accepted, not turned away");
		assert.equal(readString(r.note(), "agent-state"), "done");
		assert.notEqual(readString(r.note(), "keep-audio"), undefined);
	});

	it("an answer is not written over a copy read before the keep flag, and lands on the next tick", async () => {
		const r = rig(doneNote(true));
		const click = keepByHand(r, true); // the click reads the note first
		await settle();
		const lifecycleTick = r.lifecycle.tick(NOW); // the agent would read it next, if it is let to
		await settle();
		await settle();
		await r.run(["keep", "agent"], click, lifecycleTick);
		// What the guard kept out of the way runs on the next tick.
		await r.run(["keep", "agent"], r.lifecycle.tick(NOW));
		assert.notEqual(readString(r.note(), "keep-audio"), undefined);
		assert.equal(readString(r.note(), "agent-state"), "done");
	});

	it("stopping the keeping is guarded the same way", async () => {
		const r = rig(doneNote(true));
		await r.run(["keep"], keepByHand(r, true));
		const click = keepByHand(r, false);
		await settle();
		const lifecycleTick = r.lifecycle.tick(NOW);
		await settle();
		await settle();
		await r.run(["keep", "agent"], click, lifecycleTick);
		await r.run(["keep", "agent"], r.lifecycle.tick(NOW));
		assert.equal(readString(r.note(), "keep-audio"), undefined);
		assert.equal(readString(r.note(), "agent-state"), "done");
	});
});
