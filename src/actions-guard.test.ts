import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KeepActions } from "./keep-time.js";
import { RecordingActions } from "./lifecycle-actions.js";
import { defaultAdapters, Lifecycle, type Adapters, type VaultPort } from "./lifecycle.js";
import { makeFakeWorld, type FakeVault, type FakeWorld } from "./lifecycle-fakes.js";
import { Removal, type RemovalAction } from "./removal.js";
import {
	buildRequestNote,
	formatTimestamp,
	formatTurn,
	markAgentDone,
	markAgentRequested,
	markCancelled,
	markDone,
	markTaken,
	parseTranscriptNote,
	readInteger,
	readSection,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note.js";

// Every by-hand action reads a note and writes a changed copy back. These tests
// hold one action open at the read or at the write, and let the keep click or
// an agent's answer try the note meanwhile. The guard is the lifecycle's own
// (`Lifecycle.exclusively`), never a stand-in, so a note the action holds is
// really held.

const AUDIO = "Recording 20261001090000.m4a";
const NOTE = "Recording 20261001090000.md";
const NOW = new Date("2026-10-10T12:00:00+02:00");
const stamp = (daysAgo: number): string => formatTimestamp(new Date(NOW.getTime() - daysAgo * 86_400_000), 120);
const BUSY = /worked on right now/;

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settled = async (): Promise<void> => {
	for (let turn = 0; turn < 6; turn++) await settle();
};

/** A call the test has stopped, with the means to see that it got there and to let it go on. */
interface Held {
	reached: Promise<void>;
	release(): void;
}

/**
 * One reader's view of the vault. `holdNext` stops the next matching read or
 * write on the note: a read takes the file's text at the moment of the call
 * and answers only when the test lets it, which is how a copy goes stale.
 */
class GatedView implements VaultPort {
	private gate: { on: "read" | "write"; skip: number; arrive: () => void; open: Promise<void> } | null = null;

	constructor(private readonly vault: FakeVault) {}

	/** Stop the matching call after `skip` earlier calls of the same kind have gone through. */
	holdNext(on: "read" | "write", skip = 0): Held {
		let arrive = (): void => {};
		let release = (): void => {};
		const reached = new Promise<void>((resolve) => (arrive = resolve));
		const open = new Promise<void>((resolve) => (release = resolve));
		this.gate = { on, skip, arrive, open };
		return { reached, release };
	}

	private async passGate(on: "read" | "write"): Promise<void> {
		const gate = this.gate;
		if (gate === null || gate.on !== on) return;
		if (gate.skip > 0) {
			gate.skip--;
			return;
		}
		this.gate = null;
		gate.arrive();
		await gate.open;
	}

	async read(path: string): Promise<string | null> {
		const snapshot = this.vault.texts.get(path) ?? null;
		await this.passGate("read");
		return snapshot;
	}

	async write(path: string, text: string): Promise<void> {
		await this.passGate("write");
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

interface NoteShape {
	/** Days ago the recording was made and transcribed. */
	daysAgo?: number;
	/** Two speakers known only by number. */
	turns?: boolean;
	/** The state of the agent's step. */
	agent?: "requested" | "answered";
	cancelled?: boolean;
	/** Not yet transcribed: only the request. */
	waiting?: boolean;
}

function noteText(shape: NoteShape = {}): string {
	const daysAgo = shape.daysAgo ?? 0;
	let note: TranscriptNote = buildRequestNote({
		audio: AUDIO,
		audioBytes: 5000,
		mode: "daily-log",
		recorded: stamp(daysAgo + 0.01),
		speakerSplit: false,
		attempt: 1,
	});
	if (shape.waiting !== true) {
		const text = shape.turns
			? [formatTurn(2, "Speaker 1", "Hello."), formatTurn(9, "Speaker 2", "Hi.")].join("\n\n")
			: "Plain words.";
		note = markDone(markTaken(note, { name: "pc", at: stamp(daysAgo) }), { at: stamp(daysAgo), seconds: 60, text });
	}
	if (shape.agent !== undefined) note = markAgentRequested(note);
	if (shape.agent === "answered") note = markAgentDone(note, { at: stamp(daysAgo), text: "An old answer." });
	if (shape.cancelled) note = markCancelled(note);
	return serializeTranscriptNote(note);
}

interface Rig {
	world: FakeWorld;
	lifecycle: Lifecycle;
	view: GatedView;
	actions: RecordingActions;
	keep: KeepActions;
	asked: string[];
	/** For each redraw an action asked for, whether the note was free at that moment. */
	redrawnWhileFree: boolean[];
	note(): TranscriptNote;
	text(): string;
	/** Stop the next tick's adapter work on the note until released. */
	workGate: { open: Promise<void> };
	/** Whether the lifecycle would give the note to a writer right now. */
	free(): Promise<boolean>;
}

function rig(text: string): Rig {
	const world = makeFakeWorld();
	world.clock.set(NOW.toISOString());
	world.device.deviceRole = "ordinary";
	world.currentSettings.transcribers.dailyLog.kind = "hand-off";
	world.currentSettings.agents.dailyLog.kind = "hand-off";
	world.vault.binaries.set(AUDIO, 5000);
	world.vault.seed(NOTE, text);
	// The hand-off adapters' tick waits for the test: a tick that is under way holds the note
	// as the adapters' work does while it transcribes or waits for the agent (`workGate`).
	const workGate = { open: Promise.resolve() };
	const base = defaultAdapters();
	const adapters: Adapters = {
		transcribers: { ...base.transcribers, "hand-off": { ...base.transcribers["hand-off"]!, tick: () => workGate.open } },
		agents: { ...base.agents, "hand-off": { ...base.agents["hand-off"]!, tick: () => workGate.open } },
	};
	const lifecycle = new Lifecycle(world, adapters);
	const view = new GatedView(world.vault);
	const exclusively = <T>(path: string, step: () => Promise<T>) => lifecycle.exclusively(path, step);
	const asked: string[] = [];
	// The redraw hands the note to the lifecycle's tick, which passes a held note by:
	// note, for each redraw, whether the note was free then.
	const redrawnWhileFree: boolean[] = [];
	const refresh = async (): Promise<void> => {
		redrawnWhileFree.push((await lifecycle.exclusively(NOTE, async () => true)).ran);
	};
	const actions = new RecordingActions({
		vault: view,
		clock: world.clock,
		settings: world.settings,
		exclusively,
		confirm: async (question) => {
			asked.push(question);
			return true;
		},
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
	return {
		world,
		lifecycle,
		view,
		actions,
		keep,
		asked,
		redrawnWhileFree,
		workGate,
		note: () => {
			const parsed = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(parsed);
			return parsed;
		},
		text: () => world.vault.texts.get(NOTE) ?? "",
		free: async () => (await lifecycle.exclusively(NOTE, async () => true)).ran,
	};
}

/** Hold the note under the guard as any writer but the adapters' work does: until `release` is called. */
function holdOther(r: Rig): { release(): void; done: Promise<unknown> } {
	let release = (): void => {};
	const open = new Promise<void>((resolve) => (release = resolve));
	const done = r.lifecycle.exclusively(NOTE, () => open);
	return { release, done };
}

/** Hold the note as the lifecycle's own tick does while it transcribes: until `release` is called. */
async function holdNote(r: Rig): Promise<{ release(): void; done: Promise<unknown> }> {
	let release = (): void => {};
	r.workGate.open = new Promise<void>((resolve) => (release = resolve));
	const done = r.lifecycle.tick(NOW);
	await settled();
	assert.equal(await r.free(), false, "the tick holds the note");
	return { release, done };
}

interface ActionCase {
	name: string;
	note: NoteShape;
	call(r: Rig): Promise<{ changed: boolean; message: string }>;
	/** Whether the note shows what the action did. */
	did(note: TranscriptNote): boolean;
}

const CASES: ActionCase[] = [
	{
		name: "Cancel",
		note: { waiting: true },
		call: (r) => r.actions.cancel(NOTE),
		did: (n) => readString(n, "transcribe") === "cancelled",
	},
	{
		name: "Cancel agent",
		note: { agent: "requested" },
		call: (r) => r.actions.cancelAgent(NOTE),
		did: (n) => readString(n, "agent") === "cancelled",
	},
	{
		name: "Try again",
		note: {},
		call: (r) => r.actions.tryAgain(NOTE),
		did: (n) => readInteger(n, "attempt") === 2,
	},
	{
		name: "Leave the rest unnamed",
		note: { turns: true },
		call: (r) => r.actions.leaveUnnamed(NOTE),
		did: (n) => readString(n, "naming") === "finished",
	},
	{
		name: "Request again",
		note: { waiting: true, cancelled: true },
		call: (r) => r.actions.requestAgain(NOTE),
		did: (n) => readString(n, "transcribe") === "requested",
	},
	{
		name: "Run agent again",
		note: { agent: "answered" },
		call: (r) => r.actions.runAgentAgain(NOTE),
		did: (n) => readInteger(n, "agent-attempt") === 2,
	},
	{
		name: "naming a speaker",
		note: { turns: true },
		call: (r) => r.actions.nameSpeaker(NOTE, "Speaker 2", "Anna"),
		did: (n) => n.body.includes("Anna"),
	},
	{
		name: "Keep audio",
		note: {},
		call: (r) => r.keep.setKeepAudio(NOTE, true),
		did: (n) => readString(n, "keep-audio") !== undefined,
	},
];

describe("every by-hand action writes inside the note's guard", () => {
	for (const c of CASES) {
		it(`${c.name} holds the note while its write is pending`, async () => {
			const r = rig(noteText(c.note));
			const held = r.view.holdNext("write");
			const call = c.call(r);
			await held.reached;
			assert.equal(await r.free(), false, `${c.name} wrote while the note was free to anyone`);
			held.release();
			const result = await call;
			assert.equal(result.changed, true, result.message);
			assert.equal(c.did(r.note()), true, `${c.name} left no mark on the note`);
			assert.equal(await r.free(), true, `${c.name} did not let the note go`);
			assert.deepEqual(r.redrawnWhileFree, [true], `${c.name} redrew the note while it still held the guard`);
		});

		// A keep click on a held note is not refused: it waits and is applied when the note is
		// free (keep-click-waits.test.ts, #177).
		if (c.name === "Keep audio") continue;
		// The two cancels write unguarded when the guard is held (see the describe below).
		if (c.name === "Cancel" || c.name === "Cancel agent") continue;
		it(`${c.name} answers busy and writes nothing when the lifecycle holds the note`, async () => {
			const r = rig(noteText(c.note));
			const before = r.text();
			const hold = holdOther(r);
			const refused = await c.call(r);
			assert.equal(refused.changed, false, `${c.name} went ahead on a note someone else holds`);
			assert.match(refused.message, BUSY);
			assert.equal(r.text(), before, `${c.name} wrote while the note was held`);
			hold.release();
			await hold.done;
			assert.equal((await c.call(r)).changed, true, `${c.name} did not work once the note was free`);
		});
	}
});

describe("Cancel and Cancel agent when the guard is held", () => {
	// An adapter's tick holds the note for the whole transcription or agent request, which is
	// what these two cancel: the holder reads the cancel and drops its late answer, so refusing
	// the cancel would refuse it exactly while it is offered. Held, they write unguarded; free,
	// they take the guard like every other action. The in-flight service request case is also
	// agent-cancel.test.ts "drops a service request's answer when the cancel lands while it is
	// in flight (a guard on stillMine)".
	for (const c of CASES.filter((x) => x.name === "Cancel" || x.name === "Cancel agent")) {
		it(`${c.name} lands while the lifecycle holds the note, and does not let the holder go`, async () => {
			const r = rig(noteText(c.note));
			const hold = await holdNote(r);
			const result = await c.call(r);
			assert.equal(result.changed, true, result.message);
			assert.equal(c.did(r.note()), true, `${c.name} left no mark on the held note`);
			assert.equal(await r.free(), false, "the holder still has the note");
			hold.release();
			await hold.done;
			assert.equal(await r.free(), true);
		});

		it(`${c.name} goes through the guard when the note is free`, async () => {
			const r = rig(noteText(c.note));
			const held = r.view.holdNext("write");
			const call = c.call(r);
			await held.reached;
			assert.equal(await r.free(), false, `${c.name} wrote while the note was free to anyone`);
			held.release();
			assert.equal((await call).changed, true);
			assert.equal(c.did(r.note()), true);
		});
	}
});

describe("a question asked by hand does not hold the note while it is open", () => {
	for (const c of CASES.filter((x) => x.name === "Try again" || x.name === "Run agent again")) {
		it(`${c.name} lets the lifecycle in while the dialog is open`, async () => {
			const r = rig(noteText(c.note));
			let free: boolean | null = null;
			let answer: () => void = () => {};
			const answered = new Promise<void>((resolve) => (answer = resolve));
			const asked: string[] = [];
			const withDialog = new RecordingActions({
				vault: r.view,
				clock: r.world.clock,
				settings: r.world.settings,
				exclusively: (path, step) => r.lifecycle.exclusively(path, step),
				confirm: async (question) => {
					asked.push(question);
					free = await r.free();
					await answered;
					return true;
				},
				refresh: async () => {},
			});
			const call = c.name === "Try again" ? withDialog.tryAgain(NOTE) : withDialog.runAgentAgain(NOTE);
			await settled();
			assert.equal(asked.length, 1, "the question was asked");
			assert.equal(free, true, `${c.name} kept the note held while its question was open`);
			answer();
			assert.equal((await call).changed, true);
		});
	}
});

describe("Run agent again and the keep click on one note (#160 through another door)", () => {
	it("a keep click made while Run agent again has the note open is never reported as kept and then lost", async () => {
		const r = rig(noteText());
		// The action's second read is the one it writes from: stop it there.
		const held = r.view.holdNext("read", 1);
		const again = r.actions.runAgentAgain(NOTE);
		await held.reached;

		const click = await r.keep.setKeepAudio(NOTE, true);

		held.release();
		assert.equal((await again).changed, true);
		await settled();

		assert.equal(readInteger(r.note(), "agent-attempt"), 1, "the agent was asked for");
		const kept = readString(r.note(), "keep-audio") !== undefined;
		assert.equal(
			kept,
			click.changed,
			`the click answered "${click.message}" (changed: ${click.changed}) but the note's keep-audio is ${kept ? "set" : "gone"}`,
		);
		// A click made again, or the one that waited, ends with both on the note.
		if (!kept) assert.equal((await r.keep.setKeepAudio(NOTE, true)).changed, true);
		assert.notEqual(readString(r.note(), "keep-audio"), undefined);
		assert.equal(readInteger(r.note(), "agent-attempt"), 1);
	});
});

describe("an agent's answer and a by-hand action on one note", () => {
	/** The answer a hand-off program writes, through the lifecycle's guard, over the note as it is. */
	const answerUnderGuard = (r: Rig) =>
		r.lifecycle.exclusively(NOTE, async () => {
			const note = parseTranscriptNote(r.text());
			assert.ok(note);
			await r.world.vault.write(NOTE, serializeTranscriptNote(markAgentDone(note, { at: stamp(0), text: "The answer." })));
		});

	for (const c of [CASES.find((x) => x.name === "Leave the rest unnamed")!, CASES.find((x) => x.name === "Cancel agent")!]) {
		it(`${c.name}: the ## Agent section written under the guard meanwhile survives`, async () => {
			// An agent that asked long ago and has not answered: its answer can still land.
			const r = rig(noteText({ ...c.note, turns: true, agent: "requested", daysAgo: 3 }));
			const held = r.view.holdNext("read");
			const action = c.call(r);
			await held.reached;

			let answered = await answerUnderGuard(r);

			held.release();
			await action;
			// What the guard kept out of the way is tried again at the lifecycle's next tick.
			if (!answered.ran) answered = await answerUnderGuard(r);
			assert.equal(answered.ran, true);

			assert.equal(readSection(r.note(), "agent"), "The answer.", `${c.name} wrote a copy without the answer`);
			assert.equal(readString(r.note(), "agent-state"), "done");
		});
	}

	it("Run agent again: the answer of the earlier request, landing meanwhile, survives", async () => {
		const r = rig(noteText({ agent: "requested", daysAgo: 3 }));
		const held = r.view.holdNext("read", 1);
		const again = r.actions.runAgentAgain(NOTE);
		await held.reached;

		let answered = await answerUnderGuard(r);

		held.release();
		await again;
		if (!answered.ran) answered = await answerUnderGuard(r);
		assert.equal(answered.ran, true);

		assert.equal(readSection(r.note(), "agent"), "The answer.", "Run agent again wrote a copy without the answer");
		assert.equal(readInteger(r.note(), "agent-attempt"), 2, "the agent was asked for again");
	});
});

describe("removing a recording holds the note's guard once, with the real guard", () => {
	// `Removal` holds the guard for the whole removal and calls the cancel and
	// the audio deletion inside it. The guard cannot be taken twice, so a cancel
	// that takes it again would answer busy and the removal would do nothing.
	// The wiring below is main.ts's: Removal's cancel is the variant for a
	// caller that already holds the guard.
	function removalRig(text: string) {
		const r = rig(text);
		const { world } = r;
		const exclusively = <T>(path: string, step: () => Promise<T>) => r.lifecycle.exclusively(path, step);
		const resolveFile = (target: string): string | null => (world.vault.binaries.has(target) ? target : null);
		// What Removal's cancel answered: the audio deletion cancels a queued recording itself,
		// so a removal that went on after a busy cancel would still look right in the note.
		const cancels: { changed: boolean; message: string }[] = [];
		const withoutQuestion = new KeepActions({
			vault: world.vault,
			clock: world.clock,
			settings: world.settings,
			resolveFile,
			exclusively,
			whenFree: (path, run) => r.lifecycle.whenFree(path, run),
			tell: () => {},
			confirm: async () => true,
			refresh: async () => {},
			notesLinkingTo: () => [],
		});
		const removal = new Removal({
			vault: world.vault,
			clock: world.clock,
			settings: world.settings,
			resolveFile,
			confirm: async () => true,
			notesLinking: () => [],
			editNote: async () => false,
			openInEditor: () => false,
			cancel: async (notePath) => {
				const result = await r.actions.cancelHoldingGuard(notePath);
				cancels.push(result);
				return result;
			},
			deleteAudioKeepNote: (notePath) => withoutQuestion.deleteAudio(notePath),
			exclusively,
			refresh: async () => {},
		});
		return { r, cancels, run: (action: RemovalAction) => removal.run(action, NOTE, AUDIO, null) };
	}

	it("Delete audio on a recording still waiting cancels it and deletes the audio", async () => {
		const { r, cancels, run } = removalRig(noteText({ waiting: true }));
		const result = await run("delete-audio");
		assert.equal(result.changed, true, result.message);
		assert.deepEqual(cancels.map((c) => c.changed), [true], `Removal's cancel answered: ${cancels[0]?.message}`);
		assert.match(result.message, /recording cancelled/);
		assert.equal(readString(r.note(), "transcribe"), "cancelled");
		assert.notEqual(readString(r.note(), "audio-deleted"), undefined);
		assert.deepEqual(r.world.vault.trashed, [AUDIO]);
	});

	it("Delete audio on a transcribed recording keeps the transcript note and marks the audio deleted", async () => {
		const { r, run } = removalRig(noteText());
		const result = await run("delete-audio");
		assert.equal(result.changed, true, result.message);
		assert.notEqual(readString(r.note(), "audio-deleted"), undefined);
		assert.deepEqual(r.world.vault.trashed, [AUDIO]);
	});

	it("Remove everything on a recording still waiting cancels it, then trashes the audio and the note", async () => {
		const { r, cancels, run } = removalRig(noteText({ waiting: true }));
		const result = await run("remove-everything");
		assert.equal(result.changed, true, result.message);
		assert.deepEqual(cancels.map((c) => c.changed), [true], `Removal's cancel answered: ${cancels[0]?.message}`);
		assert.deepEqual([...r.world.vault.trashed].sort(), [AUDIO, NOTE].sort());
	});

	it("Remove everything on a transcribed recording trashes the audio and the note", async () => {
		const { r, run } = removalRig(noteText());
		const result = await run("remove-everything");
		assert.equal(result.changed, true, result.message);
		assert.deepEqual([...r.world.vault.trashed].sort(), [AUDIO, NOTE].sort());
	});

	it("Delete audio on a recording whose agent is working cancels the agent too and keeps the note", async () => {
		const { r, run } = removalRig(noteText({ agent: "requested" }));
		const result = await run("delete-audio");
		assert.equal(result.changed, true, result.message);
		assert.equal(readString(r.note(), "agent"), "cancelled");
		assert.notEqual(readString(r.note(), "audio-deleted"), undefined);
	});

	it("the guard is let go when the removal is done", async () => {
		const { r, run } = removalRig(noteText({ waiting: true }));
		await run("delete-audio");
		assert.equal(await r.free(), true);
	});
});
