/**
 * Which files count as a recording. Kept free of `obsidian` imports so it runs
 * under Node.
 *
 * The list is the extensions the plugin records (`m4a`, `webm`) plus the ones
 * Obsidian itself plays as audio (`mp3`, `wav`, `ogg`, `flac`, `3gp`): an older
 * recording made by another tool is still something to transcribe, an image or
 * a PDF is not.
 */

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["m4a", "webm", "mp3", "wav", "ogg", "flac", "3gp"]);

/** Whether the vault path names an audio file, by its extension, ignoring case. */
export function isAudioPath(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
