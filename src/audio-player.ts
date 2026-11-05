/**
 * Playing a recording from an offset: what a click on a turn's time does
 * (spec #69 § 8, "Clicking a turn's time plays the recording from that offset
 * while the audio exists").
 *
 * One audio element, owned by the plugin and kept for as long as it runs, so a
 * second click moves the same playback rather than starting another. It is
 * reached by a plain `src` from `vault.getResourcePath`, which every platform
 * Obsidian runs on plays, a phone included.
 *
 * The position is set before playing and it is the position, `element.currentTime`,
 * that says where a click took the recording. A device without a sound card
 * (the server's test Obsidian) can set it and cannot be heard; whether `play()`
 * went through is reported separately.
 */

import { TFile, type App } from "obsidian";

import { loadRecording, resolveRecording } from "./audio-load";
import { parseTranscriptNote } from "./transcript-note";

export interface PlayResult {
	/** The position was set, whether or not the sound could start. */
	positioned: boolean;
	/** `play()` was accepted. `false` when the audio is gone or the platform refused. */
	playing: boolean;
	/** Words for a notice when something stopped it, else `null`. */
	problem: string | null;
}

export class RecordingPlayer {
	/** The element playback goes through; `null` until the first click. Read by the drive. */
	element: HTMLAudioElement | null = null;

	constructor(private readonly app: App) {}

	/** Play the recording of the transcript note at `notePath`, from `seconds`. */
	async playFrom(notePath: string, seconds: number): Promise<PlayResult> {
		const audio = await this.audioOf(notePath);
		if (typeof audio === "string") return { positioned: false, playing: false, problem: audio };

		const element = this.element ?? (this.element = createEl("audio"));
		try {
			await loadRecording(element, audio.path, this.app.vault.getResourcePath(audio));
		} catch (err) {
			return { positioned: false, playing: false, problem: err instanceof Error ? err.message : String(err) };
		}
		element.currentTime = seconds;
		try {
			await element.play();
			return { positioned: true, playing: true, problem: null };
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			return { positioned: true, playing: false, problem: `The recording could not start playing: ${why}` };
		}
	}

	/** Stop and let go of the file; called when the plugin unloads. */
	dispose(): void {
		if (!this.element) return;
		this.element.pause();
		this.element.removeAttribute("src");
		this.element.load();
		this.element = null;
	}

	/** The recording's file, or the reason there is none. */
	private async audioOf(notePath: string): Promise<TFile | string> {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) return `There is no note at ${notePath}`;
		const note = parseTranscriptNote(await this.app.vault.cachedRead(noteFile));
		if (note === null) return "This note is not a transcript note this plugin wrote";
		const found = resolveRecording(note, (target) => this.app.metadataCache.getFirstLinkpathDest(target, notePath));
		return "file" in found ? found.file : found.problem;
	}
}
