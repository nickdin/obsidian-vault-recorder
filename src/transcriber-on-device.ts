/**
 * The on-device transcriber (spec #69 § 4 On-device).
 *
 * A recording whose mode has chosen on-device waits, with a reason this device
 * derives and never writes into the note, until it can be taken: not a phone,
 * not the meeting mode, the chosen model on this device in full
 * (`model-store.ts` — downloaded here, carried by Sync from another device, or
 * placed by hand), and the recording itself on this device.
 *
 * Then this device claims the note in its own name, hands the recording to the
 * model runner (`model-runner.ts`) with the model and the language, writes the
 * runner's progress into the note as it comes, and writes the plain text under
 * `## Transcript` when the runner returns. The runner loads the model when the
 * job starts and releases it when the job ends; nothing here holds a model.
 *
 * This module has no network port, so it cannot send anything; the model files
 * are read by the runner out of the model folder.
 */

import type { ClockPort, DevicePort, NoteTick, TranscriberAdapter, VaultPort } from "./lifecycle";
import { findModel, type ModelEntry } from "./model-list";
import { languageFor, type ModelRunner } from "./model-runner";
import { CLAIM_SETTLE_MS, claimNote, identityOf, sleep, stillClaimedBy } from "./serving-device";
import type { TranscriberEntry } from "./settings-data";
import type { AudioPort } from "./transcriber-service";
import {
	MODE_WORDS,
	formatTimestamp,
	markDone,
	markFailed,
	markProgress,
	parseTranscriptNote,
	readInteger,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note";

/** What the adapter needs to know about the models on this device. */
export interface ModelPresence {
	/** What the last look at the disk found; see `ModelStore.isPresent`. */
	isPresent(modelId: string): boolean;
	/** Look at the disk again for this model. */
	refreshOne(modelId: string): Promise<boolean>;
	/** Where the model's files go, for the reason to name. */
	folderOf(entry: ModelEntry): string;
}

/** What the adapter writes the note through, and runs the model with. */
export interface OnDevicePorts {
	/** The lifecycle's own vault, clock and device: the adapter writes the note through them. */
	vault: Pick<VaultPort, "read" | "write">;
	clock: ClockPort;
	device: DevicePort;
	audio: AudioPort;
	runner: ModelRunner;
	/** How a serving device waits between its claim and its second read; real time when left out. */
	wait?: (ms: number) => Promise<void>;
}

const MEETING_REASON =
	"on-device transcription is not offered for meetings: pick another transcriber for the meeting mode in the plugin's settings";

const PHONE_REASON =
	"on-device transcription does not run on phones. Ways out: pick another transcriber for this mode in the plugin's settings, or let a device that has the model transcribe it.";

const AUDIO_REASON =
	"the recording is not on this device yet. Ways out: wait for Obsidian Sync to deliver the recording, or let the device that recorded it transcribe it.";

/**
 * The least time between two progress writes: each write is a change Sync
 * carries, and the spec fixes progress at "at most every five minutes"
 * (#69 § 2 and § 15). The percentage the note shows is the last one written,
 * so up to five minutes old.
 */
const PROGRESS_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The least time between two looks at the note to see whether it was cancelled
 * or asked for again. A look only reads, so it costs Sync nothing; it keeps a
 * Cancel from waiting for the next progress write, which is minutes away.
 */
const NOTE_LOOK_INTERVAL_MS = 1000;

/** The audio link of a note, as the name inside `[[…]]`. */
function audioLinkOf(note: TranscriptNote): string | null {
	const written = readString(note, "audio");
	const match = written === undefined ? null : /\[\[([^\]|#]+)/.exec(written);
	return match ? match[1].trim() : null;
}

/**
 * The adapter for the `on-device` kind. `pluginAdapters` in
 * `adapter-table.ts` registers it in the lifecycle's table, beside `none`,
 * `hand-off` and `service`.
 */
export function createOnDeviceTranscriber(models: ModelPresence, ports: OnDevicePorts): TranscriberAdapter {
	/** Audio links the device has no complete copy of yet. */
	const audioMissing = new Set<string>();
	/**
	 * Whether a tick of this adapter holds the one slot for a model run. Ticks
	 * overlap by design, and each run loads a whole model into a worker of its
	 * own, so one run at a time: a tick that finds the slot taken leaves its
	 * note waiting for the tick after the run ends.
	 */
	let slotTaken = false;

	function stampOf(at: Date): string {
		return formatTimestamp(at, ports.clock.utcOffsetMinutes(at));
	}

	/** Why this note cannot be taken on this device whatever else is true, or `null`. */
	function blocker(note: TranscriptNote, entry: TranscriberEntry, device: DevicePort): string | null {
		if (device.isPhone()) return PHONE_REASON;
		if (readString(note, "mode") === MODE_WORDS.meeting) return MEETING_REASON;
		const model = findModel(entry.modelId);
		if (!model) return "no speech model is chosen for this mode: pick one in the plugin's settings";
		if (!models.isPresent(model.id)) {
			return (
				`model not on this device. Ways out: download ${model.name} in the plugin's settings on this device, ` +
				`download it on another device and let Sync carry it here, ` +
				`or put its files by hand in ${models.folderOf(model)}`
			);
		}
		return null;
	}

	/** The reason shown for a waiting note, or `null` when this device can take it. */
	function reasonFor(note: TranscriptNote, entry: TranscriberEntry, device: DevicePort): string | null {
		const reason = blocker(note, entry, device);
		if (reason !== null) return reason;
		const link = audioLinkOf(note);
		return link !== null && audioMissing.has(link) ? AUDIO_REASON : null;
	}

	/**
	 * Whether the note on disk is still this device's attempt: not cancelled,
	 * not asked for again, and still claimed by this device.
	 */
	function stillOurs(current: TranscriptNote, attempt: number): boolean {
		return stillClaimedBy(current, identityOf(ports.device), attempt);
	}

	async function readNote(path: string): Promise<TranscriptNote | null> {
		const text = await ports.vault.read(path);
		return text === null ? null : parseTranscriptNote(text);
	}

	async function tick(item: NoteTick<TranscriberEntry>): Promise<void> {
		// Taken before the first await, so two overlapping ticks cannot both pass.
		if (slotTaken) return;
		slotTaken = true;
		try {
			await takeAndRun(item);
		} finally {
			slotTaken = false;
		}
	}

	async function takeAndRun(item: NoteTick<TranscriberEntry>): Promise<void> {
		const { path, note, state, entry, now } = item;
		// The look at the disk lives here, not in `waitingReason`, which is
		// synchronous: this tick looks, and the reason changes on the tick
		// after, when a model has arrived by Sync or by hand.
		await models.refreshOne(entry.modelId);
		if (state.transcriber !== "waiting") return;
		// A wait that runs nothing. A recording not on this device yet is not one
		// of these: it is looked for again on every tick, below.
		if (blocker(note, entry, ports.device) !== null) return;
		const model = findModel(entry.modelId);
		if (!model) return;

		const link = audioLinkOf(note);
		const audio = link === null ? null : await ports.audio.read(link, path);
		const expected = readInteger(note, "audio-bytes") ?? 0;
		if (link === null || audio === null || audio.byteLength < expected) {
			if (link !== null) audioMissing.add(link);
			return;
		}
		audioMissing.delete(link);

		// Claim the note in this device's own name, so no other device runs it too.
		// The note is read again here, after the awaits above: a Cancel or a
		// Try again written since the lifecycle read it must not be undone by
		// writing the copy from the start of the tick back.
		const attempt = readInteger(note, "attempt") ?? 1;
		const fresh = await readNote(path);
		if (
			fresh === null ||
			readString(fresh, "transcribe") === "cancelled" ||
			(readInteger(fresh, "attempt") ?? 1) !== attempt ||
			// Another device wrote its claim first, and the first writer does the work.
			readInteger(fresh, "transcriber-attempt") === attempt
		) {
			return;
		}
		const who = identityOf(ports.device);
		await ports.vault.write(path, serializeTranscriptNote(claimNote(fresh, who, stampOf(now))));
		// A serving device waits, then reads the note again; see the service adapter.
		if (ports.device.role() === "serving") {
			await (ports.wait ?? sleep)(CLAIM_SETTLE_MS);
			const settled = await readNote(path);
			if (settled === null || !stillClaimedBy(settled, who, attempt)) return;
		}

		const abort = new AbortController();
		const startedAt = ports.clock.now().getTime();
		// The first percentage is written at once, then one per interval.
		let lastWrite = startedAt - PROGRESS_WRITE_INTERVAL_MS;
		let lastLook = startedAt - NOTE_LOOK_INTERVAL_MS;
		let lastPercent = 0;
		let writing: Promise<void> = Promise.resolve();

		/**
		 * Read the note and stop the model if it is no longer this attempt's;
		 * with a `percent`, also write it. The note is read again right before
		 * the write, so a Cancel written since is never overwritten.
		 */
		const lookAndWrite = async (percent: number | null): Promise<void> => {
			const current = await readNote(path);
			if (current === null || !stillOurs(current, attempt)) {
				abort.abort();
				return;
			}
			if (percent !== null) {
				await ports.vault.write(path, serializeTranscriptNote(markProgress(current, percent)));
			}
		};

		const onProgress = (percent: number): void => {
			const at = ports.clock.now().getTime();
			const due = percent > lastPercent && at - lastWrite >= PROGRESS_WRITE_INTERVAL_MS;
			if (!due && at - lastLook < NOTE_LOOK_INTERVAL_MS) return;
			lastLook = at;
			if (due) {
				lastPercent = percent;
				lastWrite = at;
			}
			// Writes follow one another, never overlap.
			writing = writing.then(() => lookAndWrite(due ? percent : null)).catch((err) => {
				console.error("[vault-recorder] could not write the transcription's progress:", err);
			});
		};

		try {
			const result = await ports.runner.transcribe({
				model,
				language: languageFor(model, readString(note, "language")),
				audio,
				onProgress,
				signal: abort.signal,
			});
			await writing;

			// The text lands on the note as it is now, unless it has moved on.
			const current = await readNote(path);
			if (current === null || !stillOurs(current, attempt)) return;
			const finished = ports.clock.now();
			await ports.vault.write(
				path,
				serializeTranscriptNote(
					markDone(current, {
						at: stampOf(finished),
						seconds: Math.max(0, Math.round((finished.getTime() - now.getTime()) / 1000)),
						text: result.text,
					}),
				),
			);
		} catch (err) {
			await writing;
			if (abort.signal.aborted) return; // cancelled or asked for again: the note says so already
			const current = await readNote(path);
			if (current === null || !stillOurs(current, attempt)) return;
			const message = err instanceof Error ? err.message : String(err);
			await ports.vault.write(
				path,
				serializeTranscriptNote(
					markFailed(current, {
						at: stampOf(ports.clock.now()),
						name: ports.device.name(),
						reason: `The speech model failed: ${message} (audio: ${audio.byteLength} bytes)`,
					}),
				),
			);
		}
	}

	return {
		kind: "on-device",
		requestsTranscriptNote: true,
		waitingReason: (note, entry, device) => reasonFor(note, entry, device),
		tick,
	};
}
