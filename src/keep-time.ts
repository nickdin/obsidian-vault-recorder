/**
 * Keep time and audio deletion (spec #69 § 10, decided in #54).
 *
 * One keep time in days, empty by default. Once a recording's transcript is
 * finished and the keep time has passed, its audio file goes to the trash and
 * the transcript note says so. Everything that decides *whether* is a pure
 * function of the note (`audioFate`); everything that *does* it is `KeepTime`
 * (the tick) and `KeepActions` (the buttons), both of which reach the vault only
 * through the ports below, so they run under Node with the in-memory vault.
 *
 * What is never deleted, in the order the rules ask: nothing while the keep
 * time is empty; nothing while `keep-audio` is set; nothing while the
 * transcript is not finished (waiting, being transcribed, overdue, failed,
 * cancelled, a rule version this plugin does not know); nothing while a speaker
 * split that was asked for has failed, except for a meeting a service answered,
 * which never had a split and counts as done (the note says who answered: a
 * plugin transcriber writes `transcriber-device`, a program does not); nothing while a speaker
 * is unnamed and `naming` is not `finished`. A recording with no transcript
 * note is never looked at at all: only transcript notes are walked.
 *
 * The agent is not among the holds: "finished for the keep time means
 * transcript and split, not agent" (§ 9).
 *
 * The clock starts at the done time, which is `transcriber-at` of the answer to
 * the current attempt. "Try again" raises `attempt`, so the old answer stops
 * counting at once and the clock starts again when the new answer lands.
 */

import { isAudioPath } from "./audio-file";
import type { ClockPort, DevicePort, VaultPort } from "./lifecycle";
import { isNamingFinished, unnamedLabels } from "./naming";
import { CLAIM_DEVICE_LINE } from "./serving-device";
import {
	RECORDING_MODE_KEYS,
	type RecordingModeKey,
	type VaultRecorderSettings,
} from "./settings-data";
import {
	MODE_WORDS,
	deriveState,
	markCancelled,
	parseTimestamp,
	parseTranscriptNote,
	readBoolean,
	readString,
	removeProperty,
	serializeTranscriptNote,
	setProperty,
	type DerivedState,
	type TranscriptNote,
} from "./transcript-note";

export const DAY_MS = 86_400_000;

/**
 * How long after the audio is due an ordinary desktop device waits before it
 * deletes. The spec says the serving device deletes "when the vault has one,
 * otherwise any desktop device", but a device only knows its own role: the
 * serving switch is kept on the device and never synced. So an ordinary desktop
 * gives the serving device (if the vault has one) an hour to get there first and
 * for its `audio-deleted` line to reach this device by Sync; a vault without a
 * serving device is deleted from an hour late, which no one can tell at a keep
 * time counted in days. One number, cheap to change here.
 */
export const ORDINARY_DEVICE_DELAY_MS = 60 * 60_000;

// --- The words ---------------------------------------------------------------------

/** `Audio deleted 2026-11-02, transcript kept`: drawn in place of the embed of a deleted recording (spec § 7). */
export function deletedEmbedWords(date: string): string {
	return `Audio deleted ${date}, transcript kept`;
}

/** The date the transcript note shows after deletion. */
export function deletedWords(date: string): string {
	return `Audio deleted ${date}`;
}

/** Why a recording's audio is kept, as the note and the queue panel's "Audio held" row say it. */
export function heldWords(reason: string): string {
	return `Audio is kept: ${reason}`;
}

/** The date the transcript note shows before deletion. */
export function goesWords(date: string): string {
	return `Audio will be deleted ${date}`;
}

// --- Dates --------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, "0");

/** `2026-11-02`, in the zone whose offset from UTC is `offsetMinutes`. */
export function dateWords(atMs: number, offsetMinutes: number): string {
	const shifted = new Date(atMs + offsetMinutes * 60_000);
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// --- What becomes of one recording's audio --------------------------------------------

export type AudioFate =
	/** The keep time is empty: nothing is ever deleted. */
	| { kind: "off" }
	/** The audio was deleted on `date` (the written `audio-deleted`). */
	| { kind: "deleted"; date: string }
	/**
	 * Something stops it. `pending` is true when the only reason is that the
	 * transcript is not finished yet, which the state line already says.
	 */
	| { kind: "held"; reason: string; pending: boolean }
	/** The audio goes at `atMs` (milliseconds since the epoch). */
	| { kind: "goes"; atMs: number };

/** What the rules need to know about the vault's settings and the clock. */
export interface FateContext {
	keepTimeDays: number | null;
}

/** The mode a note was recorded in, as the settings key; `undefined` for a mode word not known. */
export function modeKeyOf(note: TranscriptNote): RecordingModeKey | undefined {
	const word = readString(note, "mode");
	return RECORDING_MODE_KEYS.find((key) => MODE_WORDS[key] === word);
}

/** The context for a note from the live settings. */
export function fateContextFor(_note: TranscriptNote, settings: VaultRecorderSettings): FateContext {
	return { keepTimeDays: settings.keepTimeDays };
}

/**
 * Whether the plugin's own transcriber took this note. Both of the plugin's
 * transcribers claim a note with `transcriber-device` (`claimNote`); a program
 * under the hand-off rule writes only its own name. Of the two, only the
 * service answers a meeting in plain text, so on a note that was done without
 * the split it means a service answered. Read from the note, never from the
 * mode's current setting: the setting can be switched after the transcript was made.
 */
function pluginAnswered(note: TranscriptNote): boolean {
	return readString(note, CLAIM_DEVICE_LINE) !== undefined;
}

const held = (reason: string, pending = false): AudioFate => ({ kind: "held", reason, pending });

/** Every rule of § 10, for one transcript note at `state`. Pure. */
export function audioFate(note: TranscriptNote, state: DerivedState, context: FateContext): AudioFate {
	const deleted = readString(note, "audio-deleted");
	if (deleted !== undefined) return { kind: "deleted", date: deleted };
	const days = context.keepTimeDays;
	if (days === null) return { kind: "off" };
	if (readBoolean(note, "keep-audio") === true) return held("keep audio is set");

	// A note waiting or being transcribed is not finished however late it is; an
	// overdue one says so, since that is the word the user sees on the state line.
	if (state.transcriberOverdue) return held("the transcript is overdue", true);
	switch (state.transcriber) {
		case "waiting":
			return held("the transcript is waiting", true);
		case "being-transcribed":
			return held("the transcript is being made", true);
		case "failed":
			return held("the transcript failed", true);
		case "cancelled":
			return held("the transcript was cancelled", true);
		case "unknown-rule-version":
			return held("the note's rule version is not one this plugin knows", true);
		case "done-without-speaker-split":
			// A service answers in plain text, so a meeting through one never has a
			// split and counts as done. Any other transcriber that was asked for a
			// split and did not give one has failed at it.
			if (readBoolean(note, "speaker-split") === true && !pluginAnswered(note)) {
				return held("the speaker split that was asked for failed");
			}
			break;
		case "done":
			break;
	}

	if (!isNamingFinished(note)) {
		const unnamed = unnamedLabels(note).length;
		if (unnamed > 0) {
			return held(`${unnamed} ${unnamed === 1 ? "speaker is" : "speakers are"} unnamed`);
		}
	}

	const doneAt = parseTimestamp(readString(note, "transcriber-at"));
	if (doneAt === null) return held("the note does not say when the transcript was finished");
	return { kind: "goes", atMs: doneAt + days * DAY_MS };
}

/**
 * The line a transcript note draws about its audio, or `null` when there is
 * nothing to say: the date it will go, or after deletion the written date.
 * A hold the state line already explains (a transcript not finished) is not
 * repeated.
 */
export function audioLine(fate: AudioFate, offsetMinutes: (atMs: number) => number): string | null {
	switch (fate.kind) {
		case "off":
			return null;
		case "deleted":
			return deletedWords(fate.date);
		case "held":
			return fate.pending ? null : heldWords(fate.reason);
		case "goes":
			return goesWords(dateWords(fate.atMs, offsetMinutes(fate.atMs)));
	}
}

// --- The settings question -----------------------------------------------------------------

/** Turning the keep time on or shortening it asks; lengthening it or emptying it does not. */
export function keepTimeNeedsQuestion(before: number | null, after: number | null): boolean {
	if (after === null) return false;
	return before === null || after < before;
}

/** The question asked before a keep time that would delete audio now takes effect. */
export function keepTimeQuestion(days: number, count: number): string {
	const recordings =
		count === 1 ? "1 recording loses its audio" : `${count} recordings lose their audio`;
	return `Audio will be deleted ${days} ${days === 1 ? "day" : "days"} after its transcript is finished. ${recordings} now, to the trash. Use this keep time?`;
}

// --- Ports --------------------------------------------------------------------------------

export interface KeepTimePorts {
	vault: Pick<VaultPort, "read" | "write" | "trash" | "listTranscriptNotes">;
	clock: ClockPort;
	device: DevicePort;
	/** Read live, so a change in the settings page applies to the next tick. */
	settings: () => VaultRecorderSettings;
	/** The vault path of the file a link names, resolved from the note that holds it; `null` when there is none. */
	resolveFile(linkTarget: string, fromPath: string): string | null;
	/**
	 * Run `step` while the lifecycle's adapters are kept off the note at `path`
	 * (`Lifecycle.exclusively`); `{ ran: false }` when they are on it.
	 */
	exclusively<T>(path: string, step: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
}

/** The text a note's `audio` property links to: `[[Recording 1.m4a]]` gives `Recording 1.m4a`. */
export function audioTargetOf(note: TranscriptNote): string | undefined {
	const link = readString(note, "audio");
	if (link === undefined) return undefined;
	return link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0];
}

export interface KeepTickResult {
	/** Transcript notes whose audio this tick trashed. */
	deleted: string[];
	/** Notes where the deletion failed, each with the reason; the line was taken off again. */
	failed: { path: string; message: string }[];
}

/**
 * Write `audio-deleted` first, trash the file second. If the trash call throws
 * the line is taken off again, so the next try is not mistaken for a recording
 * whose audio is already gone, and the error goes on to the caller.
 */
async function writeLineThenTrash(
	ports: Pick<KeepTimePorts, "vault">,
	notePath: string,
	note: TranscriptNote,
	audioPath: string,
	date: string,
): Promise<void> {
	await ports.vault.write(notePath, serializeTranscriptNote(setProperty(note, "audio-deleted", date)));
	try {
		await ports.vault.trash(audioPath);
	} catch (err) {
		const text = await ports.vault.read(notePath);
		const current = text === null ? null : parseTranscriptNote(text);
		if (current !== null && readString(current, "audio-deleted") === date) {
			await ports.vault.write(notePath, serializeTranscriptNote(removeProperty(current, "audio-deleted")));
		}
		throw err;
	}
}

/**
 * The audio file a note names: its path, `null` when the note names none or the
 * vault has no such file, or a problem when the link points at something that
 * is not a recording. The keep time never trashes anything but a recording.
 */
function findRecording(
	ports: Pick<KeepTimePorts, "resolveFile">,
	notePath: string,
	note: TranscriptNote,
): { path: string } | { problem: string } | null {
	const target = audioTargetOf(note);
	if (target === undefined) return null;
	const resolved = ports.resolveFile(target, notePath);
	if (resolved === null) return null;
	if (!isAudioPath(resolved)) {
		return { problem: `The note links its audio to '${resolved}', which is not a recording, so it was left alone` };
	}
	return { path: resolved };
}

// --- The tick ---------------------------------------------------------------------------------

export class KeepTime {
	private running = false;

	constructor(private readonly ports: KeepTimePorts) {}

	/**
	 * Look at every transcript note and delete the audio whose time has come.
	 * Called on the same interval as the lifecycle's tick.
	 *
	 * A phone never deletes. A serving device deletes when the audio is due; an
	 * ordinary desktop waits `ORDINARY_DEVICE_DELAY_MS` more. A note that cannot
	 * be handled does not stop the others; it comes back in `failed`.
	 */
	async tick(now: Date): Promise<KeepTickResult> {
		const result: KeepTickResult = { deleted: [], failed: [] };
		const settings = this.ports.settings();
		if (settings.keepTimeDays === null || this.ports.device.isPhone() || this.running) return result;
		const delay = this.ports.device.role() === "serving" ? 0 : ORDINARY_DEVICE_DELAY_MS;
		this.running = true;
		try {
			for (const path of await this.ports.vault.listTranscriptNotes()) {
				try {
					if (await this.deleteIfDue(path, now, delay)) result.deleted.push(path);
				} catch (err) {
					result.failed.push({ path, message: err instanceof Error ? err.message : String(err) });
				}
			}
		} finally {
			this.running = false;
		}
		return result;
	}

	/**
	 * The note is read, changed and written back inside the lifecycle's guard
	 * for it: an answer landing between the read and the write would otherwise
	 * be overwritten, or the line written here lost to the answer's older copy.
	 * A note the lifecycle is working on is left for the next tick.
	 */
	private async deleteIfDue(path: string, now: Date, delayMs: number): Promise<boolean> {
		const { vault, clock, settings } = this.ports;
		const outcome = await this.ports.exclusively(path, async () => {
			const text = await vault.read(path);
			const note = text === null ? null : parseTranscriptNote(text);
			if (note === null) return false;
			const live = settings();
			const state = deriveState(note, now, live.overdueHours);
			const fate = audioFate(note, state, fateContextFor(note, live));
			if (fate.kind !== "goes" || fate.atMs + delayMs > now.getTime()) return false;
			const audio = findRecording(this.ports, path, note);
			if (audio === null) return false;
			if ("problem" in audio) throw new Error(audio.problem);
			await writeLineThenTrash(this.ports, path, note, audio.path, dateWords(now.getTime(), clock.utcOffsetMinutes(now)));
			return true;
		});
		return outcome.ran && outcome.value;
	}

	/**
	 * How many recordings would lose their audio at once under a keep time of
	 * `days`: what the settings page names when it asks. Counts what is due,
	 * whichever device would do the deleting.
	 */
	async countLosingAudioNow(days: number, now: Date): Promise<number> {
		const { vault, settings } = this.ports;
		let count = 0;
		for (const path of await vault.listTranscriptNotes()) {
			const text = await vault.read(path);
			const note = text === null ? null : parseTranscriptNote(text);
			if (note === null) continue;
			const live = settings();
			const fate = audioFate(note, deriveState(note, now, live.overdueHours), {
				...fateContextFor(note, live),
				keepTimeDays: days,
			});
			if (fate.kind !== "goes" || fate.atMs > now.getTime()) continue;
			// A link to something that is not a recording is not counted; the tick
			// reports it as a failure when it reaches the note.
			const audio = findRecording(this.ports, path, note);
			if (audio !== null && "path" in audio) count++;
		}
		return count;
	}
}

// --- The actions: keep audio, delete audio ---------------------------------------------------------

/** What a person can do to one recording's audio by hand. */
export type KeepAction = "keep-audio" | "release-audio" | "delete-audio";

export interface KeepOffer {
	action: KeepAction;
	label: string;
}

/**
 * What the note and the panel's row offer about the audio. Nothing once the
 * audio is gone. "Keep audio" and "Stop keeping audio" are the two states of
 * the same switch.
 */
export function keepOffers(note: TranscriptNote): KeepOffer[] {
	if (readString(note, "audio-deleted") !== undefined) return [];
	return [
		readBoolean(note, "keep-audio") === true
			? { action: "release-audio", label: "Stop keeping audio" }
			: { action: "keep-audio", label: "Keep audio" },
		{ action: "delete-audio", label: "Delete audio" },
	];
}

export interface KeepActionResult {
	/** Whether the note was changed, or, for a keep click made while the note is busy, whether the click was accepted to be applied when it is free. */
	changed: boolean;
	message: string;
}

export interface KeepActionPorts
	extends Pick<KeepTimePorts, "vault" | "clock" | "settings" | "resolveFile" | "exclusively"> {
	/**
	 * `Lifecycle.whenFree`: run `run` the moment the lifecycle lets the note at
	 * `path` go, at once when it already has. A keep click made while an
	 * adapter holds the note waits here.
	 */
	whenFree(path: string, run: () => void): void;
	/** Say, after the fact, what a click that waited came to; the click's own answer came earlier. */
	tell(message: string): void;
	/** Ask a yes/no question; `false` for no or for dismissing the dialog. */
	confirm(question: string): Promise<boolean>;
	/** Called after the note was written, so what is drawn follows at once. */
	refresh(notePath: string): Promise<void>;
	/** The notes other than `exceptPath` that link to `audioPath`, for the question to name. */
	notesLinkingTo(audioPath: string, exceptPath: string): string[];
}

const unchanged = (message: string): KeepActionResult => ({ changed: false, message });

export class KeepActions {
	constructor(private readonly ports: KeepActionPorts) {}

	/**
	 * The last "Keep audio" (`true`) or "Stop keeping audio" (`false`) click on
	 * each note the lifecycle was working on, waiting to be applied. A later
	 * click replaces an earlier one; a note is in here exactly while a waiter
	 * for it is registered with the lifecycle.
	 */
	private readonly waiting = new Map<string, boolean>();

	/**
	 * Exempt one recording from the keep time (`keep-audio: true`), or take the
	 * exemption off again. The read and the write are one step under the note's
	 * guard, so an answer landing between them is not overwritten and the flag
	 * is not lost to the answer's older copy.
	 *
	 * A note the lifecycle is working on, which an adapter's tick holds for the
	 * whole of a transcription or a model request, is not refused: the click is
	 * accepted at once, the result says it takes effect when the work is done,
	 * and it is applied under the guard when the note is free, on the note as it
	 * is by then. A second click before then replaces the first. What the
	 * applied click came to is told through the `tell` port.
	 */
	async setKeepAudio(notePath: string, keep: boolean): Promise<KeepActionResult> {
		const ran = await this.ports.exclusively(notePath, () => this.change(notePath, keep));
		if (!ran.ran) return this.wait(notePath, keep);
		if (ran.value.wrote) await this.ports.refresh(notePath);
		return ran.value.result;
	}

	/** The read, the check and the write of the flag; the caller holds the note's guard. */
	private async change(notePath: string, keep: boolean): Promise<{ result: KeepActionResult; wrote: boolean }> {
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return { result: unchanged(loaded), wrote: false };
		const deleted = readString(loaded, "audio-deleted");
		if (deleted !== undefined) return { result: unchanged(`The audio was already deleted ${deleted}`), wrote: false };
		const next = keep ? setProperty(loaded, "keep-audio", "true") : removeProperty(loaded, "keep-audio");
		await this.ports.vault.write(notePath, serializeTranscriptNote(next));
		return {
			result: {
				changed: true,
				message: keep ? "This recording's audio is kept" : "This recording's audio follows the keep time again",
			},
			wrote: true,
		};
	}

	/** Keep the click until the note is free, and say so. */
	private wait(notePath: string, keep: boolean): KeepActionResult {
		const alreadyWaiting = this.waiting.has(notePath);
		this.waiting.set(notePath, keep);
		if (!alreadyWaiting) this.applyWhenFree(notePath);
		return {
			changed: true,
			message: `${keep ? "Keeping the audio" : "Going back to the keep time"} takes effect when the work on the recording is done. If that work is removing the recording, there is nothing left to change and you are told so then.`,
		};
	}

	/**
	 * Take the note the moment the lifecycle lets it go: `exclusively` is
	 * called in the same turn, before any tick can, so the waiting click is
	 * first in line. A note taken again before this gets it keeps the click
	 * waiting. The click's value is read inside the guard, so a click made
	 * while it is being applied is applied after it.
	 */
	private applyWhenFree(notePath: string): void {
		this.ports.whenFree(notePath, () => {
			void (async () => {
				try {
					const ran = await this.ports.exclusively(notePath, async () => {
						const keep = this.waiting.get(notePath);
						if (keep === undefined) return null;
						this.waiting.delete(notePath);
						return this.change(notePath, keep);
					});
					if (!ran.ran) return this.applyWhenFree(notePath);
					if (ran.value === null) return;
					if (ran.value.wrote) await this.ports.refresh(notePath);
					this.ports.tell(ran.value.result.message);
				} catch (err) {
					this.ports.tell(`The keeping of the audio could not be changed: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
		});
	}

	/**
	 * Delete one recording's audio now. It asks once, naming the file and any
	 * other notes that link to it. A recording still waiting or being
	 * transcribed is cancelled first and stays cancelled: its audio is the one
	 * thing the transcriber needs.
	 *
	 * It does not take the note's guard: its only caller is `Removal`, which
	 * holds the guard for the whole removal (the guard cannot be taken twice).
	 */
	async deleteAudio(notePath: string): Promise<KeepActionResult> {
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return unchanged(loaded);
		const deleted = readString(loaded, "audio-deleted");
		if (deleted !== undefined) return unchanged(`The audio was already deleted ${deleted}`);
		const audio = findRecording(this.ports, notePath, loaded);
		if (audio === null) return unchanged("There is no audio file for this recording in the vault");
		if ("problem" in audio) return unchanged(audio.problem);
		const audioPath = audio.path;

		const state = this.stateOf(loaded);
		const queued = state.transcriber === "waiting" || state.transcriber === "being-transcribed";
		if (!(await this.ports.confirm(deleteAudioQuestion(audioPath, this.ports.notesLinkingTo(audioPath, notePath), queued)))) {
			return unchanged("Left as it was");
		}

		// The dialog can stay open for any time: read the note again.
		const current = await this.load(notePath);
		if (typeof current === "string") return unchanged(current);
		if (readString(current, "audio-deleted") !== undefined) {
			return unchanged("The audio was deleted while the question was open");
		}
		const nowQueued = this.stateOf(current).transcriber;
		const cancelled =
			nowQueued === "waiting" || nowQueued === "being-transcribed" ? markCancelled(current) : current;
		const { clock, vault } = this.ports;
		const now = clock.now();
		try {
			await writeLineThenTrash(
				{ vault },
				notePath,
				cancelled,
				audioPath,
				dateWords(now.getTime(), clock.utcOffsetMinutes(now)),
			);
		} catch (err) {
			// The line is taken off again; a cancel stays, it was asked for.
			await this.ports.refresh(notePath);
			return unchanged(`The audio could not be deleted: ${err instanceof Error ? err.message : String(err)}`);
		}
		await this.ports.refresh(notePath);
		return {
			changed: true,
			message: cancelled === current ? "Audio deleted, transcript kept" : "Audio deleted and the recording cancelled, transcript note kept",
		};
	}

	private stateOf(note: TranscriptNote): DerivedState {
		return deriveState(note, this.ports.clock.now(), this.ports.settings().overdueHours);
	}

	private async load(notePath: string): Promise<TranscriptNote | string> {
		const text = await this.ports.vault.read(notePath);
		if (text === null) return `There is no note at ${notePath}`;
		return parseTranscriptNote(text) ?? "This note is not a transcript note this plugin wrote";
	}
}

/** The one question "Delete audio" asks, naming the file and what links to it. */
export function deleteAudioQuestion(audioPath: string, linkedFrom: readonly string[], queued: boolean): string {
	let question = `Delete ${audioPath}? It goes to the trash and the transcript note stays.`;
	if (queued) {
		question += " The recording is still waiting for its transcript, so it is cancelled too.";
	}
	if (linkedFrom.length > 0) {
		question += ` Other notes link to it: ${linkedFrom.join(", ")}.`;
	}
	return question;
}
