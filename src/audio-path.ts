/**
 * Decides the vault path a finished recording is saved at.
 *
 * Kept free of `obsidian` imports so it runs under Node: the two things it
 * needs from Obsidian arrive as parameters.
 */

export interface AudioPathInput {
	/** `Recording YYYYMMDDHHMMSS.<ext>`; the name is never restyled here. */
	filename: string;
	/**
	 * The note the recording's link goes into: today's daily log in daily-log
	 * mode, the cursor snapshot's `filePath` in cursor and meeting mode.
	 */
	sourceNotePath: string;
	/**
	 * The typed `audioFolder` setting, a vault path. Only `""` (or spaces) hands
	 * the choice to Obsidian, whose `./` means the linking note's own folder; a
	 * typed `./` is not that, and a typed `/` means the top of the vault.
	 */
	audioFolder: string;
	/** `app.fileManager.getAvailablePathForAttachment`, bound to the app. */
	getAvailablePathForAttachment: (
		filename: string,
		sourcePath: string,
	) => Promise<string>;
	/** Creates a vault folder if it is missing. The caller owns the vault. */
	ensureFolder: (folder: string) => Promise<void>;
}

/**
 * Returns the path to write the audio at, with its folder already created.
 *
 * A typed folder gives `<folder>/<filename>`. An empty one hands the decision
 * to Obsidian, which knows every attachment choice (vault root, named folder,
 * `./`, `./sub`) and may append ` 1` on a name clash; its answer is returned
 * unchanged, so the link written into the note must name this returned path.
 */
export async function decideAudioPath(input: AudioPathInput): Promise<string> {
	const trimmed = input.audioFolder.trim();
	const typed = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");

	// Only slashes typed: the top of the vault, as before Obsidian's folder was
	// consulted. Only an empty field hands the choice to Obsidian.
	const path =
		trimmed !== ""
			? typed !== ""
				? `${typed}/${input.filename}`
				: input.filename
			: await input.getAvailablePathForAttachment(
					input.filename,
					input.sourceNotePath,
				);

	const slash = path.lastIndexOf("/");
	if (slash > 0) await input.ensureFolder(path.slice(0, slash));
	return path;
}
