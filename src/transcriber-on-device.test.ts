import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { findModel, type ModelEntry } from "./model-list.js";
import { FakeAudio, FakeModelRunner } from "./model-runner-fakes.js";
import { FakeModelDisk, FakeNetwork } from "./model-store-fakes.js";
import { ModelStore } from "./model-store.js";
import { createOnDeviceTranscriber } from "./transcriber-on-device.js";

const FILENAME = "Recording 20261019093539.m4a";
const DAILY_LOG = "Journal/2026-10-19.md";
const NOTE_PATH = "Recording 20261019093539.md";
const MODEL = findModel("kb-whisper-tiny") as ModelEntry;

/** A lifecycle with the on-device kind registered, over a model folder that starts empty. */
function onDeviceWorld(): {
	world: FakeWorld;
	lifecycle: Lifecycle;
	disk: FakeModelDisk;
	network: FakeNetwork;
	store: ModelStore;
	runner: FakeModelRunner;
	audio: FakeAudio;
} {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, "Earlier thought.\n");
	const disk = new FakeModelDisk();
	const network = new FakeNetwork();
	const store = new ModelStore({
		modelFolder: () => world.currentSettings.modelFolder,
		folder: disk,
		trash: disk,
		download: network,
	});
	const runner = new FakeModelRunner();
	const audio = new FakeAudio();
	audio.recordings.set(FILENAME, audioOfSize(20_000));
	const lifecycle = new Lifecycle(world, {
		...defaultAdapters(),
		transcribers: {
			...defaultAdapters().transcribers,
			"on-device": createOnDeviceTranscriber(store, {
				vault: world.vault,
				clock: world.clock,
				device: world.device,
				audio,
				runner,
			}),
		},
	});
	world.currentSettings.transcribers.dailyLog = {
		kind: "on-device",
		modelId: MODEL.id,
		address: "",
		keyName: "",
		modelName: "",
	};
	return { world, lifecycle, disk, network, store, runner, audio };
}

async function stopDailyLogRecording(lifecycle: Lifecycle): Promise<void> {
	await lifecycle.recordingStopped({
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(20_000),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	});
}

describe("the on-device transcriber when the model is not on this device", () => {
	it("leaves the note waiting with the reason and its three ways out, and sends nothing", async () => {
		const { world, lifecycle, network } = onDeviceWorld();
		await stopDailyLogRecording(lifecycle);
		await lifecycle.tick(world.clock.now());

		const status = lifecycle.statusOf(NOTE_PATH);
		assert.equal(status?.state.transcriber, "waiting");
		const reason = status?.waitingReason ?? "";
		assert.match(reason, /^model not on this device/);
		assert.match(reason, /download KB-Whisper tiny in the plugin's settings on this device/);
		assert.match(reason, /on another device and let Sync carry it here/);
		assert.match(reason, /by hand in vault-recorder\/models\/kb-whisper-tiny/);

		assert.equal(network.asked.length, 0, "nothing was fetched");
		assert.deepEqual(
			world.vault.created,
			[FILENAME, NOTE_PATH],
			"only the audio and the request were written",
		);
	});

	it("does not touch the request note: it still asks for a transcript, taken by nobody", async () => {
		const { world, lifecycle } = onDeviceWorld();
		await stopDailyLogRecording(lifecycle);
		const before = await world.vault.read(NOTE_PATH);
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(await world.vault.read(NOTE_PATH), before);
		assert.match(before ?? "", /\ntranscribe: requested\n/);
	});

	it("asks for a request note, as the hand-off kind does", async () => {
		const { world, lifecycle } = onDeviceWorld();
		await stopDailyLogRecording(lifecycle);
		assert.notEqual(await world.vault.read(NOTE_PATH), null);
	});

	it("stays waiting for a model that is a byte short, as a model Sync is still delivering", async () => {
		const { world, lifecycle, disk } = onDeviceWorld();
		disk.place(MODEL);
		const decoder = `vault-recorder/models/${MODEL.id}/onnx/decoder_model_merged_quantized.onnx`;
		disk.files.set(decoder, (disk.files.get(decoder) as number) - 1);
		await stopDailyLogRecording(lifecycle);
		await lifecycle.tick(world.clock.now()); // looks at the disk
		await lifecycle.tick(world.clock.now()); // reports what it found
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /^model not on this device/);
	});

	it("reads the model folder setting as it is now", async () => {
		const { world, lifecycle } = onDeviceWorld();
		world.currentSettings.modelFolder = "Models";
		await stopDailyLogRecording(lifecycle);
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /by hand in Models\/kb-whisper-tiny/);
	});
});

describe("the on-device transcriber once the model is on this device", () => {
	it("stops waiting for the model on the next look: placed by hand, or carried by Sync", async () => {
		const { world, lifecycle, disk } = onDeviceWorld();
		await stopDailyLogRecording(lifecycle);
		await lifecycle.tick(world.clock.now());
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /^model not on this device/);

		disk.place(MODEL);
		await lifecycle.tick(world.clock.now()); // this tick looks at the disk
		await lifecycle.tick(world.clock.now()); // this one reports what it found
		assert.equal(lifecycle.statusOf(NOTE_PATH)?.waitingReason, null);
	});

	it("waits again when the model is removed", async () => {
		const { world, lifecycle, disk, store } = onDeviceWorld();
		disk.place(MODEL);
		await store.refreshOne(MODEL.id);
		await stopDailyLogRecording(lifecycle);
		assert.equal(lifecycle.statusOf(NOTE_PATH)?.waitingReason, null);

		await store.remove(MODEL);
		await lifecycle.tick(world.clock.now());
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /^model not on this device/);
	});
});

/** Spec #69 § 5: every waiting reason names its ways out. */
function assertPhoneReasonWithWaysOut(reason: string | null | undefined): void {
	assert.match(reason ?? "", /^on-device transcription does not run on phones\. Ways out: /);
	assert.match(reason ?? "", /pick another transcriber for this mode in the plugin's settings/);
	assert.match(reason ?? "", /or let a device that has the model transcribe it/);
}

describe("the other reasons the on-device transcriber waits", () => {
	it("says on-device transcription does not run on phones, before anything about the model", async () => {
		const { world, lifecycle } = onDeviceWorld();
		world.device.phone = true;
		await stopDailyLogRecording(lifecycle);
		assertPhoneReasonWithWaysOut(lifecycle.statusOf(NOTE_PATH)?.waitingReason);
	});

	it("says no model is chosen when the mode names none, or one that is not on the list", async () => {
		const { world, lifecycle } = onDeviceWorld();
		world.currentSettings.transcribers.dailyLog.modelId = "";
		await stopDailyLogRecording(lifecycle);
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /^no speech model is chosen/);

		world.currentSettings.transcribers.dailyLog.modelId = "not-on-the-list";
		await lifecycle.tick(world.clock.now());
		assert.match(lifecycle.statusOf(NOTE_PATH)?.waitingReason ?? "", /^no speech model is chosen/);
	});
});

// --- Transcribing -------------------------------------------------------------------

import { markCancelled, markTryAgain, parseTranscriptNote, serializeTranscriptNote } from "./transcript-note.js";
import { chunkCount, languageFor, matchModelFile, progressOfWindows, threadCount } from "./model-runner.js";
import type { StoppedRecording } from "./lifecycle.js";

/** On-device chosen, the model on this device and the world told so: the next two ticks may run it. */
async function readyWorld() {
	const w = onDeviceWorld();
	w.disk.place(MODEL);
	await w.store.refreshOne(MODEL.id);
	await stopDailyLogRecording(w.lifecycle);
	return w;
}

/** What the lifecycle sees of the note now: the tick shows the state from before its adapters ran. */
async function statusOf(w: { world: FakeWorld; lifecycle: Lifecycle }) {
	await w.lifecycle.lookAgain(NOTE_PATH, w.world.clock.now());
	return w.lifecycle.statusOf(NOTE_PATH);
}

const noteText = async (w: { world: FakeWorld }): Promise<string> => (await w.world.vault.read(NOTE_PATH)) ?? "";

describe("the on-device transcriber with the model on this device", () => {
	it("asks the runner for the chosen model, the recording and Swedish, once", async () => {
		const w = await readyWorld();
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 1);
		assert.equal(w.runner.jobs[0].model.id, "kb-whisper-tiny");
		assert.equal(w.runner.jobs[0].language, "sv");
		assert.equal(w.runner.jobs[0].audioBytes, 20_000);

		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 1, "a note that is done is not run again");
	});

	it("writes the plain text under ## Transcript, with the transcriber lines in this device's name", async () => {
		const w = await readyWorld();
		w.world.device.deviceName = "laptop-7";
		w.runner.text = "This is a spoken note.";
		await w.lifecycle.tick(w.world.clock.now());

		const text = await noteText(w);
		assert.match(text, /\ntranscriber: laptop-7\n/);
		assert.match(text, /\ntranscriber-state: done\n/);
		assert.match(text, /\ntranscriber-attempt: 1\n/);
		assert.match(text, /\n## Transcript\n+This is a spoken note\.\n/);
		assert.doesNotMatch(text, /transcriber-progress/);
		assert.equal((await statusOf(w))?.state.transcriber, "done");
	});

	it("writes the model's progress into the note while it runs, and no oftener than once every five minutes", async () => {
		const w = await readyWorld();
		const seen: Array<string | undefined> = [];
		w.runner.script = async (job) => {
			const progressNow = async (): Promise<string | undefined> =>
				/\ntranscriber-progress: (\d+)\n/.exec(await noteText(w))?.[1];
			job.onProgress(3);
			await settle();
			seen.push(await progressNow());
			w.world.clock.advance(301_000);
			job.onProgress(20);
			job.onProgress(21); // inside the same five minutes: not written
			await settle();
			seen.push(await progressNow());
			w.world.clock.advance(301_000);
			job.onProgress(60);
			await settle();
			seen.push(await progressNow());
			assert.match(await noteText(w), /\ntranscriber-state: taken\n/, "claimed while it runs");
		};
		await w.lifecycle.tick(w.world.clock.now());
		assert.deepEqual(seen, ["3", "20", "60"]);
		assert.doesNotMatch(await noteText(w), /transcriber-progress/, "gone once the text is there");
	});

	it("writes progress once at the start and once per 300 seconds while it rises every second for 720 seconds", async () => {
		const w = await readyWorld();
		let progressWrites = 0;
		const write = w.world.vault.write.bind(w.world.vault);
		w.world.vault.write = async (path, text) => {
			if (/\ntranscriber-progress: \d+\n/.test(text)) progressWrites++;
			await write(path, text);
		};
		w.runner.script = async (job) => {
			for (let second = 0; second <= 720; second++) {
				job.onProgress(Math.min(98, 3 + Math.floor(second / 8)));
				await settle();
				w.world.clock.advance(1000);
			}
		};
		await w.lifecycle.tick(w.world.clock.now());
		// The start, 300 s and 600 s: three. The final `done` write carries no progress line.
		assert.equal(progressWrites, 3);
		assert.match(await noteText(w), /\ntranscriber-state: done\n/);
	});

	it("passes the language setting on to a model that takes one", async () => {
		const w = await readyWorld();
		w.world.currentSettings.transcribers.dailyLog.modelId = "whisper-base";
		w.world.currentSettings.language = "en";
		w.disk.place(findModel("whisper-base") as ModelEntry);
		await w.store.refreshOne("whisper-base");
		w.world.vault.texts.clear();
		w.world.vault.seed(DAILY_LOG, "Earlier thought.\n");
		await stopDailyLogRecording(w.lifecycle);
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs[0].model.id, "whisper-base");
		assert.equal(w.runner.jobs[0].language, "en");
	});

	it("tells a Swedish-only model Swedish whatever the language setting says", () => {
		const swedish = findModel("kb-whisper-base") as ModelEntry;
		const multi = findModel("whisper-base") as ModelEntry;
		assert.equal(languageFor(swedish, "en"), "sv");
		assert.equal(languageFor(swedish, undefined), "sv");
		assert.equal(languageFor(multi, "en"), "en");
		assert.equal(languageFor(multi, undefined), null);
		assert.equal(languageFor(multi, "  "), null);
	});

	it("writes the failure with the runner's own words and writes no text", async () => {
		const w = await readyWorld();
		w.runner.script = async () => {
			throw new Error("Error: no available backend found");
		};
		await w.lifecycle.tick(w.world.clock.now());
		const text = await noteText(w);
		assert.match(text, /\ntranscriber-state: failed\n/);
		assert.match(text, /transcriber-reason: .*The speech model failed: Error: no available backend found \(audio: 20000 bytes\)/);
		assert.doesNotMatch(text, /## Transcript/);
		assert.equal((await statusOf(w))?.state.transcriber, "failed");
	});

	it("stops the model and leaves the note cancelled when the user cancels while it runs", async () => {
		const w = await readyWorld();
		w.runner.script = async (job) => {
			const current = parseTranscriptNote(await noteText(w));
			assert.ok(current);
			await w.world.vault.write(NOTE_PATH, serializeTranscriptNote(markCancelled(current)));
			w.world.clock.advance(1500);
			job.onProgress(40);
			await settle();
			assert.equal(job.signal.aborted, true, "the model was told to stop");
		};
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.abortedJobs, 1);
		const text = await noteText(w);
		assert.match(text, /\ntranscribe: cancelled\n/);
		assert.doesNotMatch(text, /## Transcript/, "no text lands on a cancelled note");
		assert.equal((await statusOf(w))?.state.transcriber, "cancelled");
	});

	it("notices a Cancel within seconds although progress is written only every five minutes", async () => {
		const w = await readyWorld();
		w.runner.script = async (job) => {
			job.onProgress(3); // written: the next write is five minutes away
			await settle();
			const current = parseTranscriptNote(await noteText(w));
			assert.ok(current);
			await w.world.vault.write(NOTE_PATH, serializeTranscriptNote(markCancelled(current)));
			w.world.clock.advance(2000);
			job.onProgress(4); // no write is due, but the note is looked at
			await settle();
			assert.equal(job.signal.aborted, true, "the model was told to stop two seconds after the Cancel");
		};
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.abortedJobs, 1, "the run was stopped, not left to the end");
		assert.match(await noteText(w), /\ntranscribe: cancelled\n/);
	});

	it("drops the text of an attempt that was asked for again while it ran", async () => {
		const w = await readyWorld();
		w.runner.script = async () => {
			const current = parseTranscriptNote(await noteText(w));
			assert.ok(current);
			await w.world.vault.write(NOTE_PATH, serializeTranscriptNote(markTryAgain(current)));
		};
		await w.lifecycle.tick(w.world.clock.now());
		const text = await noteText(w);
		assert.match(text, /\nattempt: 2\n/);
		assert.doesNotMatch(text, /## Transcript/, "attempt 1's text is not written onto attempt 2");
	});

	it("waits, runs nothing and writes nothing while the recording is not on this device, then runs when it arrives", async () => {
		const w = await readyWorld();
		w.audio.recordings.clear();
		const before = await noteText(w);
		await w.lifecycle.tick(w.world.clock.now());
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 0);
		assert.equal(await noteText(w), before);
		assert.match((await statusOf(w))?.waitingReason ?? "", /^the recording is not on this device yet/);

		w.audio.recordings.set(FILENAME, audioOfSize(20_000));
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 1);
		assert.equal((await statusOf(w))?.state.transcriber, "done");
	});

	it("waits for a recording Sync has only partly delivered", async () => {
		const w = await readyWorld();
		w.audio.recordings.set(FILENAME, audioOfSize(19_999));
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 0);
	});
});

describe("on-device transcription where it is not offered or cannot run", () => {
	it("on a phone runs nothing, writes nothing and sets the reason", async () => {
		const w = await readyWorld();
		w.world.device.phone = true;
		const before = await noteText(w);
		await w.lifecycle.tick(w.world.clock.now());
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 0);
		assert.equal(await noteText(w), before);
		assertPhoneReasonWithWaysOut((await statusOf(w))?.waitingReason ?? undefined);
	});

	it("never takes a meeting, even if the settings file says on-device for that mode", async () => {
		const w = onDeviceWorld();
		w.disk.place(MODEL);
		await w.store.refreshOne(MODEL.id);
		w.world.currentSettings.transcribers.meeting = {
			kind: "on-device",
			modelId: MODEL.id,
			address: "",
			keyName: "",
			modelName: "",
		};
		w.world.vault.seed("Meetings/Planning.md", "Notes\n");
		const stop: StoppedRecording = {
			mode: "meeting",
			filename: FILENAME,
			peak: 0.3,
			audio: audioOfSize(20_000),
			linkTarget: { kind: "cursor", snapshot: { filePath: "Meetings/Planning.md", line: 0, ch: 0 } },
		};
		await w.lifecycle.recordingStopped(stop);
		await w.lifecycle.tick(w.world.clock.now());
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 0);
		assert.match(
			(await statusOf(w))?.waitingReason ?? "",
			/^on-device transcription is not offered for meetings/,
		);
	});

	it("runs nothing for a model that is not on this device", async () => {
		const w = onDeviceWorld();
		await stopDailyLogRecording(w.lifecycle);
		await w.lifecycle.tick(w.world.clock.now());
		await w.lifecycle.tick(w.world.clock.now());
		assert.equal(w.runner.jobs.length, 0);
	});
});

describe("what the model runner and its worker agree on", () => {
	it("asks ONNX Runtime for the processors there are, at most four", () => {
		assert.equal(threadCount(12), 4);
		assert.equal(threadCount(2), 2);
		assert.equal(threadCount(1), 1);
		assert.equal(threadCount(0), 1);
		assert.equal(threadCount(undefined), 1);
	});

	it("counts the windows the library cuts a recording into", () => {
		// 30 s windows, 5 s stride: a window starts 20 s after the last.
		assert.equal(chunkCount(30 * 16000, 16000, 30, 5), 1);
		assert.equal(chunkCount(10 * 16000, 16000, 30, 5), 1);
		assert.equal(chunkCount(31 * 16000, 16000, 30, 5), 2);
		assert.equal(chunkCount(50 * 16000, 16000, 30, 5), 2);
		assert.equal(chunkCount(51 * 16000, 16000, 30, 5), 3);
		assert.equal(chunkCount(3600 * 16000, 16000, 30, 5), 1 + Math.ceil((3570 * 16000) / (20 * 16000)));
	});

	it("shares the percentage between the model's windows, and never reaches 100", () => {
		assert.equal(progressOfWindows(0, 4), 20);
		assert.ok(progressOfWindows(2, 4) > 20 && progressOfWindows(2, 4) < 99);
		assert.equal(progressOfWindows(4, 4), 99);
		assert.equal(progressOfWindows(9, 4), 99);
		assert.equal(progressOfWindows(1, 0), 20);
	});

	it("finds a model file under both the local path and the Hugging Face address the library tries", () => {
		assert.equal(matchModelFile("kb-whisper-tiny", "/models/kb-whisper-tiny/onnx/encoder_model_quantized.onnx"), "onnx/encoder_model_quantized.onnx");
		assert.equal(matchModelFile("kb-whisper-tiny", "kb-whisper-tiny/config.json"), "config.json");
		assert.equal(
			matchModelFile("kb-whisper-tiny", "https://huggingface.co/kb-whisper-tiny/resolve/main/tokenizer.json"),
			"tokenizer.json",
		);
		assert.equal(matchModelFile("kb-whisper-tiny", "https://huggingface.co/other-model/resolve/main/config.json"), null);
		assert.equal(matchModelFile("whisper-base", "/models/kb-whisper-base/config.json"), null, "another model's folder is not this model's");
	});
});

describe("one on-device model run at a time", () => {
	const FILENAMES = ["Recording 20261019093539.m4a", "Recording 20261019093540.m4a", "Recording 20261019093541.m4a"];
	const notePathOf = (filename: string): string => filename.replace(/\.m4a$/, ".md");

	it("runs one model at a time however many notes wait and however the ticks overlap, and takes the next note after it", async () => {
		const w = await readyWorld();
		// readyWorld recorded FILENAMES[0]; two more notes wait beside it.
		for (const filename of FILENAMES.slice(1)) {
			w.audio.recordings.set(filename, audioOfSize(20_000));
			await w.lifecycle.recordingStopped({
				mode: "dailyLog",
				filename,
				peak: 0.3,
				audio: audioOfSize(20_000),
				linkTarget: { kind: "daily-log", path: DAILY_LOG },
			});
		}
		const releases: Array<() => void> = [];
		w.runner.script = () => new Promise<void>((release) => releases.push(release));

		const now = w.world.clock.now();
		const ticks = [w.lifecycle.tick(now), w.lifecycle.tick(now), w.lifecycle.tick(now)];
		await settle();
		assert.equal(w.runner.jobs.length, 1, "one run started");
		assert.equal(w.runner.inFlight, 1);
		const claimed: string[] = [];
		for (const filename of FILENAMES) {
			const text = (await w.world.vault.read(notePathOf(filename))) ?? "";
			if (/\ntranscriber-state: taken\n/.test(text)) claimed.push(filename);
			else assert.match(text, /\ntranscribe: requested\n/, "a note that waits is left as it was");
		}
		assert.equal(claimed.length, 1, "only the note being run is claimed");

		// Release each run in turn. The first tick, once its run ends, walks on to
		// the next waiting note and runs it: still one at a time.
		for (let round = 0; round < FILENAMES.length; round++) {
			assert.equal(w.runner.jobs.length, round + 1, "the next note runs only once the last run ended");
			assert.equal(w.runner.inFlight, 1);
			releases[round]();
			await settle();
		}
		await Promise.all(ticks);
		assert.equal(w.runner.maxInFlight, 1, "never two runs at the same moment");
		assert.equal(w.runner.jobs.length, FILENAMES.length);
		for (const filename of FILENAMES) {
			assert.match((await w.world.vault.read(notePathOf(filename))) ?? "", /\ntranscriber-state: done\n/);
		}
	});
});

describe("a Cancel or Try again that lands while the adapter is claiming the note", () => {
	it("is not overwritten by the claim: the note ends cancelled, the model never runs", async () => {
		const w = await readyWorld();
		// The user clicks Cancel while the adapter is reading the recording, after the lifecycle read the note.
		const read = w.audio.read.bind(w.audio);
		w.audio.read = async (link, fromPath) => {
			const current = parseTranscriptNote(await noteText(w));
			assert.ok(current);
			await w.world.vault.write(NOTE_PATH, serializeTranscriptNote(markCancelled(current)));
			return read(link, fromPath);
		};
		await w.lifecycle.tick(w.world.clock.now());
		const text = await noteText(w);
		assert.match(text, /\ntranscribe: cancelled\n/, "the claim did not put 'requested' back");
		assert.doesNotMatch(text, /transcriber-state: taken/);
		assert.doesNotMatch(text, /## Transcript/);
		assert.equal(w.runner.jobs.length, 0, "no model was run for a cancelled note");
	});

	it("is not overwritten by the claim when the note was asked for again meanwhile", async () => {
		const w = await readyWorld();
		const read = w.audio.read.bind(w.audio);
		w.audio.read = async (link, fromPath) => {
			const current = parseTranscriptNote(await noteText(w));
			assert.ok(current);
			await w.world.vault.write(NOTE_PATH, serializeTranscriptNote(markTryAgain(current)));
			return read(link, fromPath);
		};
		await w.lifecycle.tick(w.world.clock.now());
		const text = await noteText(w);
		assert.match(text, /\nattempt: 2\n/, "attempt 2 is kept");
		assert.doesNotMatch(text, /transcriber-state: taken/, "attempt 1's claim is not written onto attempt 2");
		assert.equal(w.runner.jobs.length, 0);
	});
});

/** Let the adapter's queued progress writes finish. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
