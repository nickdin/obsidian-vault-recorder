/**
 * #200: a request says which kind of transcriber (and agent) its mode had, so a
 * hand-off program and every device agree on whose it is. The plugin writes
 * `transcribe-kind` and `agent-kind`; a device decides by the note's line, and
 * by its own settings only for a note written before the line existed.
 */
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
import { FakeDevice, audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions } from "./lifecycle-actions.js";
import {
	markAgentFailed,
	markFailed,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note.js";
import type { AgentKind, TranscriberKind } from "./settings-data.js";

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

/** An adapter for every kind, each with a tick that only says it ran. */
function recordingAdapters() {
	const calls: string[] = [];
	const transcriber = (kind: TranscriberKind): TranscriberAdapter => ({
		kind,
		requestsTranscriptNote: true,
		waitingReason: () => null,
		tick: async () => void calls.push(`transcriber:${kind}`),
	});
	const agent = (kind: AgentKind): AgentAdapter => ({
		kind,
		waitingReason: () => null,
		tick: async () => void calls.push(`agent:${kind}`),
	});
	const adapters: Adapters = {
		transcribers: {
			...defaultAdapters().transcribers,
			"hand-off": transcriber("hand-off"),
			service: transcriber("service"),
			"on-device": transcriber("on-device"),
		},
		agents: { ...defaultAdapters().agents, "hand-off": agent("hand-off"), service: agent("service") },
	};
	return { adapters, calls };
}

function world(): FakeWorld {
	const w = makeFakeWorld();
	w.vault.seed(DAILY_LOG, "Earlier thought.\n");
	return w;
}

/** The actions as main.ts wires them, answering yes to every question. */
function actionsFor(w: FakeWorld, lifecycle: Lifecycle): RecordingActions {
	return new RecordingActions({
		vault: w.vault,
		clock: w.clock,
		settings: w.settings,
		exclusively: (path, step) => lifecycle.exclusively(path, step),
		noteProperties: w.noteProperties,
		confirm: async () => true,
		refresh: (path) => lifecycle.look(path, w.clock.now()),
	});
}

function noteIn(w: FakeWorld, path = NOTE): TranscriptNote {
	const note = parseTranscriptNote(w.vault.texts.get(path) ?? "");
	assert.ok(note, "a transcript note");
	return note;
}

describe("the request names its transcriber's kind", () => {
	for (const kind of ["hand-off", "service", "on-device"] as const) {
		it(`writes transcribe-kind: ${kind} for a recording stopped in a ${kind} mode`, async () => {
			const w = world();
			w.currentSettings.transcribers.dailyLog.kind = kind;
			const lifecycle = new Lifecycle(w, recordingAdapters().adapters);
			await lifecycle.recordingStopped(dailyStop());
			assert.equal(readString(noteIn(w), "transcribe-kind"), kind);
		});
	}

	it("is rewritten by try again with the mode's kind then, and left alone by cancel", async () => {
		const w = world();
		w.currentSettings.transcribers.dailyLog.kind = "service";
		const lifecycle = new Lifecycle(w, recordingAdapters().adapters);
		await lifecycle.recordingStopped(dailyStop());
		const actions = actionsFor(w, lifecycle);

		w.currentSettings.transcribers.dailyLog.kind = "hand-off";
		await actions.cancel(NOTE);
		assert.equal(readString(noteIn(w), "transcribe"), "cancelled");
		assert.equal(readString(noteIn(w), "transcribe-kind"), "service", "cancel leaves the kind");

		await actions.requestAgain(NOTE);
		assert.equal(readString(noteIn(w), "transcribe-kind"), "hand-off", "asking again after a cancel");

		w.vault.texts.set(
			NOTE,
			serializeTranscriptNote(
				markFailed(noteIn(w), { at: "2026-10-19T09:40:00+02:00", reason: "no answer", name: "home-pc" }),
			),
		);
		w.currentSettings.transcribers.dailyLog.kind = "on-device";
		const tried = await actions.tryAgain(NOTE);
		assert.equal(tried.changed, true, tried.message);
		assert.equal(readString(noteIn(w), "attempt"), "3");
		assert.equal(readString(noteIn(w), "transcribe-kind"), "on-device", "try again");
	});
});

/** A daily-log note whose transcript a device finished at 09:36, before any agent was asked. */
function finishedNote(lines: string[] = []): string {
	return [
		"---",
		"rule-version: 1",
		`audio: "[[${FILENAME}]]"`,
		"mode: daily-log",
		"recorded: 2026-10-19T09:35:39+02:00",
		"attempt: 1",
		"transcribe: requested",
		...lines,
		"transcriber: laptop",
		"transcriber-state: done",
		"transcriber-at: 2026-10-19T09:36:00+02:00",
		"transcriber-attempt: 1",
		"---",
		"",
		"## Transcript",
		"",
		"Remember the cable.",
		"",
	].join("\n");
}

describe("the agent's ask names its agent's kind", () => {
	it("is written with the automatic ask and again with run agent again, each with the mode's kind then", async () => {
		const w = world();
		w.currentSettings.agents.dailyLog.kind = "service";
		w.currentSettings.agents.dailyLog.chosenAt = "2026-10-19T09:00:00+02:00";
		w.vault.seed(NOTE, finishedNote());
		const lifecycle = new Lifecycle(w, recordingAdapters().adapters);

		await lifecycle.tick(w.clock.now());
		assert.equal(readString(noteIn(w), "agent"), "requested");
		assert.equal(readString(noteIn(w), "agent-kind"), "service", "the automatic ask");

		w.vault.texts.set(
			NOTE,
			serializeTranscriptNote(markAgentFailed(noteIn(w), { at: "2026-10-19T09:37:00+02:00", reason: "no answer" })),
		);
		w.currentSettings.agents.dailyLog.kind = "hand-off";
		const ran = await actionsFor(w, lifecycle).runAgentAgain(NOTE);
		assert.equal(ran.changed, true, ran.message);
		assert.equal(readString(noteIn(w), "agent-attempt"), "2");
		assert.equal(readString(noteIn(w), "agent-kind"), "hand-off", "run agent again");
	});
});

/** A waiting daily-log request recorded at 09:35:39, with `lines` after `transcribe`. */
function waitingNote(lines: string[]): string {
	return [
		"---",
		"rule-version: 1",
		`audio: "[[${FILENAME}]]"`,
		"audio-bytes: 20000",
		"mode: daily-log",
		"recorded: 2026-10-19T09:35:39+02:00",
		"attempt: 1",
		"transcribe: requested",
		...lines,
		"---",
		"",
	].join("\n");
}

/** What a serving device hands to the adapters for `noteText`, an hour after the recording, past its grace period. */
async function servingTicks(
	noteText: string,
	settings: { transcriber?: TranscriberKind; agent?: AgentKind },
): Promise<string[]> {
	const w = world();
	w.currentSettings.transcribers.dailyLog.kind = settings.transcriber ?? "none";
	w.currentSettings.agents.dailyLog.kind = settings.agent ?? "none";
	w.vault.seed(NOTE, noteText);
	const { adapters, calls } = recordingAdapters();
	const serving = new Lifecycle({ ...w, device: new FakeDevice("server", "serving") }, adapters);
	w.clock.advance(HOUR);
	await serving.tick(w.clock.now());
	return calls;
}

describe("a device decides whose a request is by the note's kind", () => {
	it("does not take a hand-off request although the mode's settings now say service", async () => {
		const calls = await servingTicks(waitingNote(["transcribe-kind: hand-off"]), { transcriber: "service" });
		assert.deepEqual(calls, []);
	});

	it("takes a service request with the service transcriber although the settings now say hand-off", async () => {
		const calls = await servingTicks(waitingNote(["transcribe-kind: service"]), { transcriber: "hand-off" });
		assert.deepEqual(calls, ["transcriber:service"]);
	});

	it("takes an on-device request with the on-device transcriber although the settings now say service", async () => {
		const calls = await servingTicks(waitingNote(["transcribe-kind: on-device"]), { transcriber: "service" });
		assert.deepEqual(calls, ["transcriber:on-device"]);
	});

	it("follows the settings for a request written before the line existed", async () => {
		assert.deepEqual(await servingTicks(waitingNote([]), { transcriber: "service" }), ["transcriber:service"]);
		assert.deepEqual(await servingTicks(waitingNote([]), { transcriber: "hand-off" }), []);
	});

	it("takes nothing for a kind word it does not know", async () => {
		const calls = await servingTicks(waitingNote(["transcribe-kind: cloud"]), { transcriber: "service" });
		assert.deepEqual(calls, []);
	});

	it("says why a request with a kind word it does not know waits, for the transcriber and the agent", async () => {
		const w = world();
		w.currentSettings.transcribers.dailyLog.kind = "service";
		w.currentSettings.agents.dailyLog.kind = "service";
		const lifecycle = new Lifecycle(w, recordingAdapters().adapters);

		w.vault.seed(NOTE, waitingNote(["transcribe-kind: cloud"]));
		await lifecycle.tick(w.clock.now());
		assert.match(lifecycle.statusOf(NOTE)?.waitingReason ?? "", /kind of transcriber.*'cloud'/);

		w.vault.seed(NOTE, finishedAgentNote(["agent: requested", "agent-kind: cloud", "agent-attempt: 1", "agent-for: 2026-10-19T09:36:00+02:00"]));
		await lifecycle.tick(w.clock.now());
		assert.match(lifecycle.statusOf(NOTE)?.waitingReason ?? "", /kind of agent.*'cloud'/);
	});

	const asked = (kind: string | null): string[] => [
		"agent: requested",
		...(kind === null ? [] : [`agent-kind: ${kind}`]),
		"agent-attempt: 1",
		"agent-for: 2026-10-19T09:36:00+02:00",
	];

	it("does not take a hand-off agent's ask although the settings now say service", async () => {
		const calls = await servingTicks(finishedAgentNote(asked("hand-off")), { agent: "service" });
		assert.deepEqual(calls, []);
	});

	it("takes a service agent's ask with the service agent although the settings now say hand-off", async () => {
		const calls = await servingTicks(finishedAgentNote(asked("service")), { agent: "hand-off" });
		assert.deepEqual(calls, ["agent:service"]);
	});

	it("follows the settings for an agent ask written before the line existed", async () => {
		assert.deepEqual(await servingTicks(finishedAgentNote(asked(null)), { agent: "service" }), ["agent:service"]);
		assert.deepEqual(await servingTicks(finishedAgentNote(asked(null)), { agent: "hand-off" }), []);
	});
});

/** `finishedNote` with the agent's ask `lines` after the transcriber's answer. */
function finishedAgentNote(lines: string[]): string {
	return finishedNote().replace("transcriber-attempt: 1\n", `transcriber-attempt: 1\n${lines.join("\n")}\n`);
}
