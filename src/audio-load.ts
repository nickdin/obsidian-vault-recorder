/**
 * Getting a recording into the player's audio element and waiting until it
 * knows its length, which is when it can be moved to an offset.
 *
 * Separate from `audio-player.ts` because it needs nothing from Obsidian, so a
 * fake element can drive it under Node.
 */

import { readString, type TranscriptNote } from "./transcript-note";

/**
 * The recording a transcript note names, or the words for a notice when there
 * is none to play: the audio was deleted, the note names none, or `find` (the
 * vault's lookup of a link) knows no such file. Nothing is loaded in any of
 * these cases.
 */
export function resolveRecording<File>(
	note: TranscriptNote,
	find: (target: string) => File | null,
): { file: File } | { problem: string } {
	const deleted = readString(note, "audio-deleted");
	if (deleted !== undefined) return { problem: `The audio was deleted ${deleted}, so there is nothing to play` };
	const link = readString(note, "audio");
	if (link === undefined) return { problem: "This note does not name its recording" };
	const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0];
	const file = find(target);
	return file === null ? { problem: `The recording ${target} is not in the vault` } : { file };
}

/** The part of an `HTMLAudioElement` loading uses. */
export type LoadableAudio = Pick<
	HTMLAudioElement,
	"pause" | "preload" | "src" | "readyState" | "addEventListener" | "removeEventListener" | "error"
> & { dataset: DOMStringMap };

/** How long to wait for a recording's length before giving up, in milliseconds. */
export const METADATA_WAIT_MS = 8_000;

/**
 * Point `element` at the recording `path` (served at `src`) unless it already
 * holds it, then wait for its length. A failed load is not remembered: the
 * next call loads the recording again.
 */
export async function loadRecording(
	element: LoadableAudio,
	path: string,
	src: string,
	waitMs: number = METADATA_WAIT_MS,
): Promise<void> {
	if (element.dataset.vaultRecorderFile !== path) {
		element.pause();
		element.dataset.vaultRecorderFile = path;
		element.preload = "auto";
		element.src = src;
	}
	try {
		await whenKnownLength(element, waitMs);
	} catch (err) {
		// Forget the file, so the next click sets the source again: a recording
		// that failed (it had not arrived yet, say) is tried afresh, not waited
		// for another full wait.
		delete element.dataset.vaultRecorderFile;
		throw err;
	}
}

/** Resolve once the element knows how long the recording is, which is when it can be moved. */
function whenKnownLength(element: LoadableAudio, waitMs: number): Promise<void> {
	if (element.readyState >= 1) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("The recording did not load"));
		}, waitMs);
		const onLoaded = (): void => {
			cleanup();
			resolve();
		};
		const onError = (): void => {
			cleanup();
			reject(new Error(`The recording could not be read (${element.error?.message ?? "unknown error"})`));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			element.removeEventListener("loadedmetadata", onLoaded);
			element.removeEventListener("error", onError);
		};
		element.addEventListener("loadedmetadata", onLoaded);
		element.addEventListener("error", onError);
	});
}
