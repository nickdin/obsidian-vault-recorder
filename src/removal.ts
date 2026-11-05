/**
 * Removing a recording (spec #69 § 11, decided in #68).
 *
 * Four entries, offered on a recording's right-click menu in the note, on its
 * queue-panel row and on a line at the top of its transcript note:
 *
 *  - "Remove link": the embed (and, in a meeting note, the transcript link
 *    beside it) leaves the note. No question. A note open in an editor is
 *    changed through it, so Ctrl+Z brings the link back; any other note is
 *    rewritten, and the notice says that cannot be undone. No file is touched.
 *  - "Remove link and audio": that, and the audio file goes to the trash. The
 *    transcript note stays and says the audio is gone.
 *  - "Remove everything": that, and the transcript note goes to the trash too.
 *  - "Delete audio": the audio goes, the link stays. Every button for it, the
 *    state line's included, comes through here (`main.ts`, `runAction`); the
 *    note's final write is `KeepActions.deleteAudio`'s, with its question
 *    already asked here.
 *
 * Every entry that deletes a file first checks that the transcript note's
 * lifecycle guard is free, and says so at once if it is not, since a question
 * the guard would then refuse is no question to ask. It asks once, naming the
 * files and any other note that links to them (a warning, never a refusal, and
 * those notes are never edited). Then, inside the guard, it takes the link,
 * cancels the transcriber and the agent if either is still going, and trashes:
 * a tick cannot write the note between those steps. The question itself is
 * asked outside the guard, because a dialog may stay open for any time.
 *
 * The rules reach the vault only through the ports below, so they run under
 * Node with the in-memory vault; `main.ts` supplies Obsidian's.
 */

import { isAudioPath } from "./audio-file";
import { closesFence, openingFence } from "./note-insert";
import type { ClockPort, VaultPort } from "./lifecycle";
import { audioTargetOf, deleteAudioQuestion } from "./keep-time";
import type { VaultRecorderSettings } from "./settings-data";
import { deriveState, parseTranscriptNote, readString, serializeTranscriptNote, setProperty } from "./transcript-note";

export type RemovalAction = "remove-link" | "remove-link-and-audio" | "remove-everything" | "delete-audio";

export const REMOVAL_LABELS: Record<RemovalAction, string> = {
	"remove-link": "Remove link",
	"remove-link-and-audio": "Remove link and audio",
	"remove-everything": "Remove everything",
	"delete-audio": "Delete audio",
};

const ORDER: RemovalAction[] = ["remove-link", "remove-link-and-audio", "remove-everything", "delete-audio"];

// --- Taking the link out of a note's text -------------------------------------------

// A link to the audio: `![[…]]` (an embed) or `[[…]]`, with the transcript link `[[…]]` the
// meeting mode writes right after it, or a Markdown link `![](…)` / `[](…)` whose address may be
// percent-encoded or in angle brackets.
const WIKILINK = /!?\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]( ?\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\])?/g;
const MARKDOWN_LINK = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function decoded(address: string): string {
	const bare = address.replace(/^<|>$/g, "").split("#")[0];
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

/**
 * `content` without the links to `audioPath` and without the transcript link
 * `[[…]]` the meeting mode writes right after one. A line left empty goes, and
 * so does the blank line the plugin put before it: the plugin's insertion under
 * the notes heading writes a blank line on both sides of the embed, so a blank
 * line before the embed is taken only when one follows it too. The cursor modes
 * write the embed alone, and a blank line before one is the user's. A line that
 * holds other text keeps it, and so does every line inside a fenced code block.
 * Nothing else changes, byte for byte.
 *
 * A link names the file by its path or by its name alone, as Obsidian does;
 * both match. When only a name is known (`audioPath` has no folder: the audio
 * is gone), a link by any folder path to that name matches. `transcriptTargets`
 * are the texts the transcript link may carry (its path, its name, either with
 * or without `.md`).
 */
export function removeRecordingLink(content: string, audioPath: string, transcriptTargets: readonly string[]): string {
	const name = baseName(audioPath);
	const nameOnly = audioPath === name;
	const isAudio = (target: string): boolean => {
		const t = target.trim();
		return t === audioPath || t === name || (nameOnly && baseName(t) === name);
	};
	const wanted = new Set(
		transcriptTargets.flatMap((t) => [t, t.replace(/\.md$/, ""), baseName(t), baseName(t).replace(/\.md$/, "")]),
	);
	const lines = content.split("\n");
	const out: string[] = [];
	let fence: ReturnType<typeof openingFence> = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const bare = line.replace(/\r$/, "");
		if (fence !== null) {
			if (closesFence(bare, fence)) fence = null;
			out.push(line);
			continue;
		}
		fence = openingFence(bare);
		if (fence !== null) {
			out.push(line);
			continue;
		}
		let found = false;
		let rest = line.replace(
			WIKILINK,
			(whole: string, target: string, tail: string | undefined, tailTarget: string | undefined) => {
				if (!isAudio(target)) return whole;
				found = true;
				return tail !== undefined && !wanted.has((tailTarget ?? "").trim()) ? tail : "";
			},
		);
		rest = rest.replace(MARKDOWN_LINK, (whole: string, address: string) => {
			if (!isAudio(decoded(address))) return whole;
			found = true;
			return "";
		});
		if (!found || rest.trim() !== "") {
			out.push(found ? rest : line);
			continue;
		}
		// The line held nothing else: it goes. The blank line before it goes only when the
		// plugin put it there, which it did if another blank line follows.
		const followedByBlank = i + 1 < lines.length && lines[i + 1].trim() === "";
		if (followedByBlank && out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	}
	return out.join("\n");
}

/**
 * The smallest edit that turns `before` into `after`: what to replace, as
 * offsets into `before`, and with what. Lets the editor apply a removal as one
 * small change, so Ctrl+Z undoes just that and the cursor stays put.
 */
export function smallestEdit(before: string, after: string): { from: number; to: number; insert: string } {
	let start = 0;
	const limit = Math.min(before.length, after.length);
	while (start < limit && before[start] === after[start]) start++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

// --- What each entry offers -----------------------------------------------------------

/** Where a recording's link is, as far as an entrance that is not the note itself can tell. */
export type LinkHome =
	| { kind: "note"; path: string }
	| { kind: "none" }
	| { kind: "several"; paths: string[] };

/**
 * Where the link is: the note whose menu it was, or else the one note that
 * links to the audio (the transcript note's own `audio` link does not count).
 */
export function linkHomeOf(fromNote: string | null, transcriptPath: string | null, linkers: readonly string[]): LinkHome {
	if (fromNote !== null) return { kind: "note", path: fromNote };
	const holders = linkers.filter((p) => p !== transcriptPath);
	if (holders.length === 0) return { kind: "none" };
	return holders.length === 1 ? { kind: "note", path: holders[0] } : { kind: "several", paths: [...holders] };
}

/** The recording an entry is about. */
export interface RemovalTarget {
	/** The audio file; `null` when it is gone (deleted already, or never found). */
	audioPath: string | null;
	/** The audio's name as the note's embed spells it, for finding the embed. */
	audioName: string;
	/** The recording's transcript note; `null` for a recording without one. */
	transcriptPath: string | null;
	/** The note whose link is being removed, when the entrance is that note's own menu. */
	fromNote: string | null;
	/** Where the audio file has gone, as a date, when the transcript note says so. */
	audioDeleted: string | null;
}

export interface RemovalEntry {
	action: RemovalAction;
	label: string;
	/** `null` when the entry applies; otherwise why it is greyed. */
	greyedBecause: string | null;
}

/**
 * The four entries and which of them apply. `home` is where the link is:
 * the note whose menu it was, or the one note that links to the audio.
 */
export function removalEntries(target: RemovalTarget, home: LinkHome): RemovalEntry[] {
	const linkProblem =
		home.kind === "none"
			? "No note links to this recording"
			: home.kind === "several"
				? "Several notes link to this recording: right-click the link in the note you mean"
				: null;
	const audioGone = target.audioDeleted !== null || target.audioPath === null;
	const audioProblem = audioGone
		? target.audioDeleted !== null
			? `The audio was already deleted ${target.audioDeleted}`
			: "The audio file is not in the vault"
		: null;
	const noNote = "This recording has no transcript note";
	const problems: Record<RemovalAction, string | null> = {
		"remove-link": linkProblem,
		"remove-link-and-audio": audioProblem,
		// Everything can run with the audio already gone: the note still goes.
		"remove-everything": target.transcriptPath === null ? noNote : null,
		"delete-audio": target.transcriptPath === null ? noNote : audioProblem,
	};
	return ORDER.map((action) => ({ action, label: REMOVAL_LABELS[action], greyedBecause: problems[action] }));
}

/**
 * The one question a file-deleting entry asks: the files it names, whether it
 * cancels a recording still in the queue, and the other notes that link to
 * those files. "Delete audio" asks the keep time's own question.
 */
export function removalQuestion(
	action: Exclude<RemovalAction, "remove-link">,
	files: { audio: string | null; transcript: string | null },
	linkedFrom: readonly string[],
	queued: boolean,
	agentActive = false,
	linkTaken = true,
): string {
	if (action === "delete-audio") {
		return withAgentSentence(deleteAudioQuestion(files.audio ?? "", linkedFrom, queued), agentActive, linkedFrom);
	}
	const named = [files.audio, action === "remove-everything" ? files.transcript : null].filter(
		(f): f is string => f !== null,
	);
	const verb = linkTaken ? "Remove the link and delete" : "Delete";
	let question =
		action === "remove-everything"
			? `${verb} ${named.join(" and ")}? ${named.length > 1 ? "They go" : "It goes"} to the trash.`
			: `${verb} ${files.audio}? It goes to the trash and the transcript note stays.`;
	if (queued) question += " The recording is still waiting for its transcript, so it is cancelled too.";
	if (agentActive) question += AGENT_SENTENCE;
	if (linkedFrom.length > 0) question += ` Other notes link to ${named.length > 1 ? "them" : "it"}: ${linkedFrom.join(", ")}.`;
	return question;
}

const AGENT_SENTENCE = " The agent is still answering, so it is cancelled too.";

/** `question` with the agent's sentence put before the list of linking notes that `deleteAudioQuestion` ends on. */
function withAgentSentence(question: string, agentActive: boolean, linkedFrom: readonly string[]): string {
	if (!agentActive) return question;
	if (linkedFrom.length === 0) return question + AGENT_SENTENCE;
	const at = question.lastIndexOf(" Other notes link");
	return at === -1 ? question + AGENT_SENTENCE : question.slice(0, at) + AGENT_SENTENCE + question.slice(at);
}

// --- Doing it ---------------------------------------------------------------------------------

export interface RemovalResult {
	changed: boolean;
	message: string;
}

export interface RemovalPorts {
	vault: Pick<VaultPort, "read" | "write" | "trash" | "linkText">;
	clock: ClockPort;
	settings: () => VaultRecorderSettings;
	resolveFile(linkTarget: string, fromPath: string): string | null;
	/** Ask a yes/no question; `false` for no or for dismissing the dialog. */
	confirm(question: string): Promise<boolean>;
	/** The notes other than `exceptPath` that link to `path`. */
	notesLinking(path: string, exceptPath: string | null): string[];
	/**
	 * Change the text of the note at `path` the way an edit would: through its
	 * open editor when it has one, so Ctrl+Z undoes it. `false` when the note
	 * is gone.
	 */
	editNote(path: string, change: (text: string) => string): Promise<boolean>;
	/** Whether the note is open in an editor, which is where `editNote`'s change can be undone. */
	openInEditor(path: string): boolean;
	/** `RecordingActions.cancel`. */
	cancel(notePath: string): Promise<{ changed: boolean; message: string }>;
	/** The keep time's deletion of the audio, with the transcript note kept and its question already asked. */
	deleteAudioKeepNote(notePath: string): Promise<{ changed: boolean; message: string }>;
	/** `Lifecycle.exclusively`. */
	exclusively<T>(path: string, step: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
	/** Called after a transcript note changed or went, so what is drawn follows. */
	refresh(notePath: string): Promise<void>;
}

const BUSY = "The recording is being worked on right now, so it cannot be removed yet. Try again when that is done.";

/** "Link, audio and transcript note removed": only what was taken, `false` for what was not. */
function removed(parts: Array<string | false>): string {
	const named = parts.filter((p): p is string => p !== false);
	const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
	return `${list[0].toUpperCase()}${list.slice(1)} removed`;
}

const nothing = (message: string): RemovalResult => ({ changed: false, message });

export class Removal {
	constructor(private readonly ports: RemovalPorts) {}

	/** What the entry for this recording offers, read from the vault now. */
	async entriesFor(transcriptPath: string | null, audioPath: string | null, fromNote: string | null): Promise<RemovalEntry[]> {
		const resolved = await this.resolve(transcriptPath, audioPath, fromNote);
		if (typeof resolved === "string") return [];
		return removalEntries(resolved.target, this.homeOf(resolved));
	}

	/**
	 * Run one entry. `transcriptPath` is the recording's transcript note, `null`
	 * for one without; `audioPath` is the audio file when the entrance knows it
	 * (an embed in a note), `fromNote` the note whose menu it was.
	 */
	async run(
		action: RemovalAction,
		transcriptPath: string | null,
		audioPath: string | null,
		fromNote: string | null,
	): Promise<RemovalResult> {
		const resolved = await this.resolve(transcriptPath, audioPath, fromNote);
		if (typeof resolved === "string") return nothing(resolved);
		const { target } = resolved;
		const home = this.homeOf(resolved);
		const entry = removalEntries(target, home).find((e) => e.action === action);
		if (entry?.greyedBecause) return nothing(entry.greyedBecause);

		const homePath = home.kind === "note" ? home.path : null;
		if (action === "remove-link") {
			const undoable = homePath !== null && this.ports.openInEditor(homePath);
			const removed = await this.removeLink(homePath, target);
			if (!removed) return nothing("The note holds no link to this recording");
			return {
				changed: true,
				message: undoable
					? "Link removed. Ctrl+Z brings it back."
					: "Link removed. The note was not open, so this cannot be undone with Ctrl+Z.",
			};
		}

		// Ask only what can be carried out: a note being worked on refuses the guard at once,
		// and a transcription on this device holds it for the whole model run.
		if (target.transcriptPath !== null) {
			const probe = await this.ports.exclusively(target.transcriptPath, async () => true);
			if (!probe.ran) return nothing(BUSY);
		}

		const pending = this.pending(resolved.noteText);
		const linkedFrom = this.otherLinks(action, target, homePath);
		const question = removalQuestion(
			action,
			{ audio: target.audioPath, transcript: target.transcriptPath },
			linkedFrom,
			pending.transcriber,
			pending.agent,
			homePath !== null,
		);
		if (!(await this.ports.confirm(question))) return nothing("Left as it was");

		return this.deleteFiles(action, target, homePath);
	}

	// --- steps ---

	private async deleteFiles(action: RemovalAction, target: RemovalTarget, homePath: string | null): Promise<RemovalResult> {
		const { transcriptPath } = target;
		const steps = async (): Promise<RemovalResult> => {
			// The link first: it is what the user sees, and Ctrl+Z can bring it back.
			const linkTaken = action !== "delete-audio" && (await this.removeLink(homePath, target));
			let cancelled = false;
			if (transcriptPath !== null) {
				// A recording still in the queue, and an agent still answering, are cancelled before its files go.
				const transcriber = await this.ports.cancel(transcriptPath);
				const agent = await this.cancelAgent(transcriptPath);
				cancelled = transcriber.changed || agent;
			}
			const audioGoes = target.audioPath !== null;
			if (action === "remove-everything") {
				if (target.audioPath !== null) await this.ports.vault.trash(target.audioPath);
				if (transcriptPath !== null) await this.ports.vault.trash(transcriptPath);
				return { changed: true, message: removed([linkTaken && "link", audioGoes && "audio", "transcript note"]) };
			}
			// Audio only: the transcript note stays and says so (the keep time's own action).
			if (transcriptPath === null || target.audioPath === null) {
				if (target.audioPath !== null) await this.ports.vault.trash(target.audioPath);
				return { changed: true, message: removed([linkTaken && "link", audioGoes && "audio"]) };
			}
			const result = await this.ports.deleteAudioKeepNote(transcriptPath);
			if (!result.changed) return { changed: false, message: result.message };
			const andCancelled = cancelled ? " and the recording cancelled" : "";
			return {
				changed: true,
				message:
					action === "delete-audio"
						? `Audio deleted${andCancelled}, transcript kept`
						: `${removed([linkTaken && "link", "audio"])}${andCancelled}, transcript note kept`,
			};
		};
		if (transcriptPath === null) return steps();
		const ran = await this.ports.exclusively(transcriptPath, steps);
		if (!ran.ran) return nothing(BUSY);
		if (action === "remove-everything") await this.ports.refresh(transcriptPath);
		return ran.value;
	}

	/** Takes the link out of the note; `true` only when the note held one. */
	private async removeLink(homePath: string | null, target: RemovalTarget): Promise<boolean> {
		if (homePath === null) return false;
		const transcriptTargets = target.transcriptPath === null ? [] : [target.transcriptPath];
		let taken = false;
		const noteExists = await this.ports.editNote(homePath, (text) => {
			const after = removeRecordingLink(text, target.audioPath ?? target.audioName, transcriptTargets);
			taken = after !== text;
			return after;
		});
		return noteExists && taken;
	}

	/** Whether the transcriber, and whether the agent, have a request in the queue that cancelling would stop. */
	private pending(noteText: string | null): { transcriber: boolean; agent: boolean } {
		const note = noteText === null ? null : parseTranscriptNote(noteText);
		if (note === null) return { transcriber: false, agent: false };
		const state = deriveState(note, this.ports.clock.now(), this.ports.settings().overdueHours);
		return {
			transcriber: state.transcriber === "waiting" || state.transcriber === "being-transcribed",
			agent: state.agent === "waiting" || state.agent === "working",
		};
	}

	/**
	 * Write `agent: cancelled` when the agent still has a request open, so a
	 * program reading the note (in the trash too) sees the drop. The note is read
	 * again here: the transcriber's own cancel has just written it.
	 */
	private async cancelAgent(notePath: string): Promise<boolean> {
		const text = await this.ports.vault.read(notePath);
		const note = text === null ? null : parseTranscriptNote(text);
		if (note === null) return false;
		const { agent } = deriveState(note, this.ports.clock.now(), this.ports.settings().overdueHours);
		if (agent !== "waiting" && agent !== "working") return false;
		await this.ports.vault.write(notePath, serializeTranscriptNote(setProperty(note, "agent", "cancelled")));
		return true;
	}

	/** Notes that link to a file about to go, other than the transcript note and the one whose link is being removed. */
	private otherLinks(action: RemovalAction, target: RemovalTarget, homePath: string | null): string[] {
		// "Delete audio" removes no link, so the note that embeds the audio is one of those it breaks.
		const linkTaken = action === "delete-audio" ? null : homePath;
		const except = new Set([linkTaken, target.transcriptPath].filter((p): p is string => p !== null));
		const files = [target.audioPath, action === "remove-everything" ? target.transcriptPath : null].filter(
			(p): p is string => p !== null,
		);
		const found = new Set<string>();
		for (const file of files) {
			for (const path of this.ports.notesLinking(file, null)) if (!except.has(path)) found.add(path);
		}
		return [...found].sort();
	}

	private homeOf(resolved: Resolved): LinkHome {
		return linkHomeOf(resolved.fromNote, resolved.target.transcriptPath, resolved.linkers);
	}

	private async resolve(
		transcriptPath: string | null,
		audioPath: string | null,
		fromNote: string | null,
	): Promise<Resolved | string> {
		let noteText: string | null = null;
		let audioDeleted: string | null = null;
		let audio = audioPath;
		let audioName = audioPath === null ? "" : baseName(audioPath);
		if (transcriptPath !== null) {
			noteText = await this.ports.vault.read(transcriptPath);
			const note = noteText === null ? null : parseTranscriptNote(noteText);
			if (note === null) return "This note is not a transcript note this plugin wrote";
			audioDeleted = readString(note, "audio-deleted") ?? null;
			const named = audioTargetOf(note);
			if (named !== undefined) {
				audioName = baseName(named);
				if (audio === null && audioDeleted === null) {
					audio = this.ports.resolveFile(named, transcriptPath);
				}
			}
		}
		if (audio !== null && !isAudioPath(audio)) return `'${audio}' is not a recording, so it was left alone`;
		if (audioDeleted !== null) audio = null;
		// A deleted recording's embed no longer resolves: look for it by the name the note gives.
		const linkers = this.ports.notesLinking(audio ?? audioName, null);
		return {
			target: { audioPath: audio, audioName, transcriptPath, fromNote, audioDeleted },
			fromNote,
			linkers,
			noteText,
		};
	}
}

interface Resolved {
	target: RemovalTarget;
	fromNote: string | null;
	/** Every note that links to the audio. */
	linkers: string[];
	noteText: string | null;
}
