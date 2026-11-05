import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { FakeVault, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { KeepActions } from "./keep-time.js";
import { RecordingActions } from "./lifecycle-actions.js";
import { Removal, removalEntries, removalQuestion, type RemovalAction, type RemovalTarget } from "./removal.js";
import {
	buildRequestNote,
	markAgentRequested,
	markDone,
	markTaken,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	setProperty,
} from "./transcript-note.js";

const AUDIO = "Audio/Recording 20261001090000.m4a";
const NOTE = "Transcripts/Recording 20261001090000.md";
const DAILY = "Journal/2026-10-01.md";
const NOW = "2026-10-01T12:00:00+02:00";
const EMBED_NOTE = "# Notes\nMine.\n\n![[Recording 20261001090000.m4a]]\n\n## Overdue\n";

/** Records the order things happened in, and whether each trash ran under the note's guard. */
class LoggingVault extends FakeVault {
	readonly log: string[] = [];
	/** Every trash and every note write, in order, with the `agent` line each write carried. */
	readonly events: string[] = [];
	guarded = false;
	readonly trashedOutsideGuard: string[] = [];
	override async trash(path: string): Promise<void> {
		this.log.push(`trash ${path}`);
		this.events.push(`trash ${path}`);
		if (!this.guarded) this.trashedOutsideGuard.push(path);
		await super.trash(path);
	}
	override async write(path: string, text: string): Promise<void> {
		const note = parseTranscriptNote(text);
		this.events.push(`write ${path}${note === null ? "" : ` agent=${readString(note, "agent") ?? "-"}`}`);
		await super.write(path, text);
	}
}

type TranscriptState = "done" | "waiting" | "audio-deleted" | "agent-waiting" | "agent-working" | "agent-done";

function transcriptText(state: TranscriptState): string {
	let note = buildRequestNote({
		audio: "Recording 20261001090000.m4a",
		audioBytes: 5000,
		mode: "daily-log",
		recorded: "2026-10-01T11:00:00+02:00",
		speakerSplit: false,
		attempt: 1,
	});
	if (state !== "waiting") {
		note = markDone(markTaken(note, { name: "pc", at: "2026-10-01T11:01:00+02:00" }), {
			at: "2026-10-01T11:02:00+02:00",
			seconds: 60,
			text: "Plain words.",
		});
	}
	if (state === "audio-deleted") note = setProperty(note, "audio-deleted", "2026-09-30");
	if (state.startsWith("agent-")) {
		note = markAgentRequested(note);
		if (state !== "agent-waiting") {
			note = setProperty(note, "agent-by", "home-pc");
			note = setProperty(note, "agent-state", state === "agent-working" ? "working" : "done");
			note = setProperty(note, "agent-at", "2026-10-01T11:03:00+02:00");
			note = setProperty(note, "agent-attempt-answered", "1");
		}
	}
	return serializeTranscriptNote(note);
}

interface Rig {
	world: FakeWorld;
	vault: LoggingVault;
	asked: string[];
	answer: { yes: boolean };
	busy: { value: boolean };
	removal: Removal;
	edited: string[];
	/** Notes open in an editor, whose edits Ctrl+Z can undo. */
	editorOpen: Set<string>;
}

function rig(options: { transcript?: TranscriptState | null; extraLinkers?: string[] } = {}): Rig {
	const world = makeFakeWorld();
	const vault = new LoggingVault();
	world.vault = vault;
	world.clock.set(NOW);
	const state = options.transcript === undefined ? "done" : options.transcript;
	if (state !== "audio-deleted") vault.binaries.set(AUDIO, 5000);
	if (state !== null) vault.seed(NOTE, transcriptText(state));
	vault.seed(DAILY, EMBED_NOTE);
	for (const path of options.extraLinkers ?? []) vault.seed(path, "Heard in ![[Recording 20261001090000.m4a]] too\n");

	const asked: string[] = [];
	const answer = { yes: true };
	const busy = { value: false };
	const edited: string[] = [];
	const editorOpen = new Set<string>();
	const resolveFile = (target: string): string | null => (vault.binaries.has(AUDIO) && AUDIO.endsWith(target) ? AUDIO : null);
	const actions = new RecordingActions({
		vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: async (_path, step) => ({ ran: true, value: await step() }),
		confirm: async () => true,
		refresh: async () => {},
	});
	const keep = new KeepActions({
		vault,
		clock: world.clock,
		settings: world.settings,
		resolveFile,
		exclusively: async (_path, step) => ({ ran: true, value: await step() }),
		whenFree: (_path, run) => run(),
		tell: () => {},
		confirm: async () => true,
		refresh: async () => {},
		notesLinkingTo: () => [],
	});
	const removal = new Removal({
		vault,
		clock: world.clock,
		settings: world.settings,
		resolveFile,
		confirm: async (question) => {
			asked.push(question);
			return answer.yes;
		},
		notesLinking: (path, except) =>
			[...vault.texts.keys()].filter(
				(p) =>
					p !== except &&
					p !== NOTE &&
					(vault.texts.get(p) ?? "").includes(`[[${path.slice(path.lastIndexOf("/") + 1)}]]`),
			),
		openInEditor: (path) => editorOpen.has(path),
		editNote: async (path, change) => {
			const text = vault.texts.get(path);
			if (text === undefined) return false;
			edited.push(path);
			vault.texts.set(path, change(text));
			return true;
		},
		cancel: async (path) => {
			vault.log.push(`cancel ${path}`);
			return actions.cancelHoldingGuard(path);
		},
		deleteAudioKeepNote: (path) => keep.deleteAudio(path),
		exclusively: async (_path, step) => {
			if (busy.value) return { ran: false };
			vault.guarded = true;
			try {
				return { ran: true, value: await step() };
			} finally {
				vault.guarded = false;
			}
		},
		refresh: async () => {},
	});
	return { world, vault, asked, answer, busy, removal, edited, editorOpen };
}

const run = (r: Rig, action: RemovalAction, withNote = true) =>
	r.removal.run(action, withNote ? NOTE : null, AUDIO, DAILY);

const noteOf = (r: Rig) => {
	const note = parseTranscriptNote(r.vault.texts.get(NOTE) ?? "");
	assert.ok(note);
	return note;
};

describe("the four removal entries", () => {
	it("Remove link takes the link and asks nothing; no file is touched", async () => {
		const r = rig();
		const noteBefore = r.vault.texts.get(NOTE);
		const result = await run(r, "remove-link");
		assert.equal(result.changed, true);
		assert.equal(r.asked.length, 0);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nMine.\n\n## Overdue\n");
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(r.vault.binaries.has(AUDIO), true);
		assert.equal(r.vault.texts.get(NOTE), noteBefore);
	});

	it("Remove link and audio asks once naming the audio, trashes it and keeps the transcript note saying so", async () => {
		const r = rig();
		await run(r, "remove-link-and-audio");
		assert.equal(r.asked.length, 1);
		assert.match(r.asked[0], /Audio\/Recording 20261001090000\.m4a/);
		assert.doesNotMatch(r.asked[0], /Transcripts\//);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nMine.\n\n## Overdue\n");
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		assert.equal(readString(noteOf(r), "audio-deleted"), "2026-10-01");
	});

	it("Remove everything asks once naming both files, and leaves neither the audio nor the transcript note", async () => {
		const r = rig();
		await run(r, "remove-everything");
		assert.equal(r.asked.length, 1);
		assert.match(r.asked[0], /Audio\/Recording 20261001090000\.m4a/);
		assert.match(r.asked[0], /Transcripts\/Recording 20261001090000\.md/);
		assert.deepEqual([...r.vault.trashed].sort(), [AUDIO, NOTE]);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nMine.\n\n## Overdue\n");
	});

	it("Delete audio leaves the link and the transcript note", async () => {
		const r = rig();
		await run(r, "delete-audio");
		assert.equal(r.asked.length, 1);
		assert.equal(r.vault.texts.get(DAILY), EMBED_NOTE);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		assert.equal(readString(noteOf(r), "audio-deleted"), "2026-10-01");
	});

	it("a no to the question changes nothing at all", async () => {
		for (const action of ["remove-link-and-audio", "remove-everything", "delete-audio"] as const) {
			const r = rig({ transcript: "waiting" });
			r.answer.yes = false;
			const before = new Map(r.vault.texts);
			const result = await run(r, action);
			assert.equal(result.changed, false, action);
			assert.deepEqual(r.vault.trashed, [], action);
			assert.deepEqual(r.vault.texts, before, action);
			assert.equal(r.vault.binaries.has(AUDIO), true, action);
		}
	});
});

describe("a recording still in the queue", () => {
	it("is cancelled before anything is trashed, and the question says so", async () => {
		const r = rig({ transcript: "waiting" });
		await run(r, "remove-everything");
		assert.match(r.asked[0], /cancelled too/);
		assert.deepEqual(r.vault.log, [`cancel ${NOTE}`, `trash ${AUDIO}`, `trash ${NOTE}`]);
	});

	it("stays cancelled when only its audio goes", async () => {
		const r = rig({ transcript: "waiting" });
		await run(r, "remove-link-and-audio");
		assert.equal(readString(noteOf(r), "transcribe"), "cancelled");
		assert.equal(readString(noteOf(r), "audio-deleted"), "2026-10-01");
	});

	it("runs cancel and every trash inside the transcript note's guard", async () => {
		const r = rig({ transcript: "waiting" });
		await run(r, "remove-everything");
		assert.deepEqual(r.vault.trashedOutsideGuard, []);
	});

	it("does nothing, and says why, when the note is being worked on", async () => {
		const r = rig({ transcript: "waiting" });
		r.busy.value = true;
		const result = await run(r, "remove-everything");
		assert.equal(result.changed, false);
		assert.match(result.message, /being worked on/);
		assert.deepEqual(r.vault.trashed, []);
		assert.equal(r.vault.texts.get(DAILY), EMBED_NOTE);
	});
});

describe("Remove link through Removal, over notes that spell the link their own way", () => {
	const seed = (r: Rig, text: string) => r.vault.texts.set(DAILY, text);

	it("takes an embed written with the folder path", async () => {
		const r = rig();
		seed(r, `# Notes\n\n![[${AUDIO}]]\n\n## Overdue\n`);
		const result = await run(r, "remove-link");
		assert.equal(r.vault.texts.get(DAILY), "# Notes\n\n## Overdue\n");
		assert.equal(result.changed, true);
	});

	it("takes a plain link to the audio, with or without a folder path", async () => {
		for (const link of ["[[Recording 20261001090000.m4a]]", `[[${AUDIO}|the call]]`]) {
			const r = rig();
			seed(r, `Heard in ${link} today\n`);
			await run(r, "remove-link");
			assert.equal(r.vault.texts.get(DAILY), "Heard in  today\n", link);
		}
	});

	it("says no link was found, and changes nothing, when the note holds none", async () => {
		const r = rig();
		seed(r, "# Notes\nNothing recorded here.\n");
		const result = await run(r, "remove-link");
		assert.equal(result.changed, false);
		assert.doesNotMatch(result.message, /^Link removed/);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nNothing recorded here.\n");
	});
});

describe("what Remove link promises about Ctrl+Z", () => {
	it("promises it when the note is open in an editor, where the edit can be undone", async () => {
		const r = rig();
		r.editorOpen.add(DAILY);
		const result = await run(r, "remove-link");
		assert.match(result.message, /Ctrl\+Z brings it back/);
	});

	it("does not promise it when the note is not open, so the file was rewritten", async () => {
		const r = rig();
		const result = await r.removal.run("remove-link", NOTE, AUDIO, DAILY);
		assert.equal(result.changed, true);
		assert.doesNotMatch(result.message, /Ctrl\+Z brings/);
		assert.match(result.message, /cannot be undone/);
	});
});

describe("what the question and the notice say about the link", () => {
	it("claims no link when no note links to the recording", async () => {
		const r = rig();
		r.vault.texts.delete(DAILY);
		const result = await r.removal.run("remove-everything", NOTE, AUDIO, null);
		assert.doesNotMatch(r.asked[0], /Remove the link/);
		assert.match(r.asked[0], /^Delete Audio\/Recording 20261001090000\.m4a and Transcripts\/Recording 20261001090000\.md\? They go to the trash\.$/);
		assert.equal(result.message, "Audio and transcript note removed");
	});

	it("claims no link when several notes link and none was chosen", async () => {
		const r = rig({ extraLinkers: ["Projects/Call.md"] });
		const result = await r.removal.run("remove-link-and-audio", NOTE, AUDIO, null);
		assert.doesNotMatch(r.asked[0], /Remove the link/);
		assert.match(r.asked[0], /^Delete Audio\/Recording 20261001090000\.m4a\? It goes to the trash and the transcript note stays\./);
		assert.equal(result.message, "Audio removed, transcript note kept");
	});

	it("claims no link for a recording without a transcript note either", async () => {
		const r = rig({ transcript: null });
		r.vault.texts.delete(DAILY);
		const result = await r.removal.run("remove-link-and-audio", null, AUDIO, null);
		assert.equal(result.message, "Audio removed");
	});

	it("still says link, audio and transcript note when the link was taken", async () => {
		const r = rig();
		const result = await run(r, "remove-everything");
		assert.equal(result.message, "Link, audio and transcript note removed");
	});
});

describe("what the notice says about a cancel the removal made", () => {
	it("says Delete audio cancelled a waiting recording", async () => {
		const r = rig({ transcript: "waiting" });
		const result = await run(r, "delete-audio");
		assert.equal(result.message, "Audio deleted and the recording cancelled, transcript kept");
	});

	it("says Remove link and audio cancelled it too", async () => {
		const r = rig({ transcript: "waiting" });
		const result = await run(r, "remove-link-and-audio");
		assert.equal(result.message, "Link and audio removed and the recording cancelled, transcript note kept");
	});

	it("says nothing of a cancel when the recording was done", async () => {
		const r = rig();
		assert.equal((await run(r, "delete-audio")).message, "Audio deleted, transcript kept");
	});
});

describe("a recording this device is working on right now", () => {
	for (const action of ["remove-link-and-audio", "remove-everything", "delete-audio"] as const) {
		it(`${action} says so at once instead of asking a question it cannot carry out`, async () => {
			const r = rig({ transcript: "waiting" });
			r.busy.value = true;
			const result = await run(r, action);
			assert.deepEqual(r.asked, []);
			assert.equal(result.changed, false);
			assert.match(result.message, /being worked on/);
			assert.deepEqual(r.vault.trashed, []);
		});
	}

	it("still asks, and works, once the note is free", async () => {
		const r = rig({ transcript: "waiting" });
		const result = await run(r, "remove-everything");
		assert.equal(r.asked.length, 1);
		assert.equal(result.changed, true);
	});
});

describe("a recording whose agent is still answering", () => {
	for (const state of ["agent-waiting", "agent-working"] as const) {
		it(`is cancelled, agent too, before anything is trashed (${state})`, async () => {
			const r = rig({ transcript: state });
			await run(r, "remove-everything");
			assert.match(r.asked[0], /agent/i);
			const cancelled = r.vault.events.indexOf(`write ${NOTE} agent=cancelled`);
			assert.ok(cancelled >= 0, `no write of ${NOTE} with agent: cancelled in ${JSON.stringify(r.vault.events)}`);
			assert.ok(cancelled < r.vault.events.indexOf(`trash ${AUDIO}`), "the agent was cancelled after the audio went");
			assert.ok(cancelled < r.vault.events.indexOf(`trash ${NOTE}`), "the agent was cancelled after the note went");
		});
	}

	it("stays cancelled when only the audio goes, and the question says so", async () => {
		const r = rig({ transcript: "agent-working" });
		await run(r, "remove-link-and-audio");
		assert.match(r.asked[0], /agent/i);
		assert.equal(readString(noteOf(r), "agent"), "cancelled");
	});

	it("is left alone when its answer is already in", async () => {
		const r = rig({ transcript: "agent-done" });
		await run(r, "remove-everything");
		assert.doesNotMatch(r.asked[0], /agent/i);
		assert.deepEqual(r.vault.events.filter((l) => l.startsWith("write")), []);
	});
});

describe("other notes that link to the files", () => {
	it("are named in the question and never edited or refused", async () => {
		const r = rig({ extraLinkers: ["Projects/Call.md"] });
		const other = r.vault.texts.get("Projects/Call.md");
		const result = await run(r, "remove-everything");
		assert.match(r.asked[0], /Other notes link to them: Projects\/Call\.md/);
		assert.equal(result.changed, true);
		assert.equal(r.vault.texts.get("Projects/Call.md"), other);
	});

	it("are absent from the question when there are none", async () => {
		const r = rig();
		await run(r, "remove-everything");
		assert.doesNotMatch(r.asked[0], /Other notes/);
	});

	it("do not include the note whose link is being removed", async () => {
		const r = rig();
		await run(r, "remove-link-and-audio");
		assert.doesNotMatch(r.asked[0], /Journal\/2026-10-01\.md/);
	});

	it("include the note whose embed Delete audio breaks, as the keep time's own question does", async () => {
		const r = rig();
		await run(r, "delete-audio");
		assert.match(r.asked[0], /Other notes link to it: Journal\/2026-10-01\.md\./);
		assert.equal(r.vault.texts.get(DAILY), EMBED_NOTE);
	});

	it("name every note that links to the audio when Delete audio comes from the transcript note, with no note's menu", async () => {
		const r = rig({ extraLinkers: ["Projects/Call.md"] });
		await r.removal.run("delete-audio", NOTE, null, null);
		assert.match(r.asked[0], /Journal\/2026-10-01\.md, Projects\/Call\.md/);
	});

	it("make a panel entrance with several of them refuse to guess which link to take", async () => {
		const r = rig({ extraLinkers: ["Projects/Call.md"] });
		const entries = await r.removal.entriesFor(NOTE, AUDIO, null);
		const link = entries.find((e) => e.action === "remove-link");
		assert.match(link?.greyedBecause ?? "", /Several notes link/);
		// The deleting entries still work, and warn about every one of them.
		const result = await r.removal.run("remove-everything", NOTE, AUDIO, null);
		assert.equal(result.changed, true);
		assert.match(r.asked[0], /Journal\/2026-10-01\.md, Projects\/Call\.md/);
		assert.equal(r.vault.texts.get(DAILY), EMBED_NOTE);
	});
});

describe("recordings without a transcript note", () => {
	it("get the two remove-link entries; the other two are greyed with the reason", async () => {
		const r = rig({ transcript: null });
		const entries = await r.removal.entriesFor(null, AUDIO, DAILY);
		assert.deepEqual(
			entries.map((e) => [e.action, e.greyedBecause === null]),
			[
				["remove-link", true],
				["remove-link-and-audio", true],
				["remove-everything", false],
				["delete-audio", false],
			],
		);
		assert.equal(entries[2].greyedBecause, "This recording has no transcript note");
	});

	it("Remove link and audio asks, takes the link and trashes the audio", async () => {
		const r = rig({ transcript: null });
		await run(r, "remove-link-and-audio", false);
		assert.match(r.asked[0], /Audio\/Recording 20261001090000\.m4a/);
		assert.deepEqual(r.vault.trashed, [AUDIO]);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nMine.\n\n## Overdue\n");
	});

	it("refuses Remove everything and Delete audio with the reason, touching nothing", async () => {
		const r = rig({ transcript: null });
		const result = await run(r, "remove-everything", false);
		assert.equal(result.changed, false);
		assert.equal(result.message, "This recording has no transcript note");
		assert.deepEqual(r.vault.trashed, []);
	});
});

describe("entries greyed by state", () => {
	const gone: RemovalTarget = {
		audioPath: null,
		audioName: "Recording 20261001090000.m4a",
		transcriptPath: NOTE,
		fromNote: DAILY,
		audioDeleted: "2026-09-30",
	};

	it("greys the audio entries once the audio is deleted, with the date, and keeps the rest", () => {
		const byAction = Object.fromEntries(
			removalEntries(gone, { kind: "note", path: DAILY }).map((e) => [e.action, e.greyedBecause]),
		);
		assert.equal(byAction["remove-link"], null);
		assert.equal(byAction["remove-everything"], null);
		assert.equal(byAction["remove-link-and-audio"], "The audio was already deleted 2026-09-30");
		assert.equal(byAction["delete-audio"], "The audio was already deleted 2026-09-30");
	});

	it("greys Remove link when no note links to the recording", () => {
		const entries = removalEntries({ ...gone, audioDeleted: null, audioPath: AUDIO }, { kind: "none" });
		assert.equal(entries[0].greyedBecause, "No note links to this recording");
	});

	it("reads the greying from the transcript note in the vault", async () => {
		const r = rig({ transcript: "audio-deleted" });
		const entries = await r.removal.entriesFor(NOTE, null, DAILY);
		assert.match(entries.find((e) => e.action === "delete-audio")?.greyedBecause ?? "", /already deleted 2026-09-30/);
		const result = await r.removal.run("delete-audio", NOTE, null, DAILY);
		assert.equal(result.changed, false);
		assert.deepEqual(r.vault.trashed, []);
	});

	it("still removes everything of a recording whose audio is gone, naming only the note", async () => {
		const r = rig({ transcript: "audio-deleted" });
		await r.removal.run("remove-everything", NOTE, null, DAILY);
		assert.doesNotMatch(r.asked[0], /m4a/);
		assert.match(r.asked[0], /Transcripts\/Recording 20261001090000\.md/);
		assert.deepEqual(r.vault.trashed, [NOTE]);
		assert.equal(r.vault.texts.get(DAILY), "# Notes\nMine.\n\n## Overdue\n");
	});
});

describe("the question's wording", () => {
	it("says 'it' and 'goes' when only one file is named", () => {
		assert.equal(
			removalQuestion("remove-everything", { audio: null, transcript: NOTE }, ["Daily.md"], false),
			`Remove the link and delete ${NOTE}? It goes to the trash. Other notes link to it: Daily.md.`,
		);
	});

	it("Delete audio asks the keep time's own question", () => {
		assert.equal(
			removalQuestion("delete-audio", { audio: AUDIO, transcript: NOTE }, [], false),
			`Delete ${AUDIO}? It goes to the trash and the transcript note stays.`,
		);
	});
});
