/**
 * The three things a person does to a recording by hand: cancel it, try it
 * again, and transcribe it (spec #69 §§ 2–3, user stories 23–25). The commands
 * and the buttons on the drawn state line both call these; the rules live here,
 * once, and reach the vault only through the lifecycle's own ports so they run
 * under Node with the in-memory vault.
 *
 * What an action writes is the plugin's own marks (`transcribe`, `attempt`),
 * never a transcriber's property: one writer per line. A transcript the
 * program writes after a cancel is kept and shown done — `deriveState` already
 * reads it that way, so cancelling never has to undo anything.
 */

import {
	deriveState,
	buildRequestNote,
	formatTimestamp,
	markAgentCancelled,
	markAgentRequested,
	markCancelled,
	markTryAgain,
	parseTranscriptNote,
	readSection,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note";
import { actionsFor, speakersToName, type RecordingAction } from "./state-line";
import {
	clearNaming,
	hasNamedSpeakers,
	isNamingFinished,
	leaveRestUnnamed,
	renameSpeaker,
	unnamedLabels,
} from "./naming";
import { isAudioPath } from "./audio-file";
import { modeKeyOf } from "./keep-time";
import { normalizeFolder, requestForRecording, type LifecyclePorts } from "./lifecycle";
import { hasAgentText } from "./agent-service";
import { type AgentKind, type RecordingModeKey, type TranscriberKind } from "./settings-data";
import { dailyLogConfigFor, type DailyLogConfig, type DailyNotesOptions } from "./daily-log";

/**
 * The question "try again" asks before it replaces a transcript that already
 * has text. Spec #69, user story 24: "'try again' [should] ask before replacing
 * a transcript that already has text, and … tell me names and the agent's
 * answer will be redone, so that my corrections are not lost silently."
 */
export const TRY_AGAIN_QUESTION =
	"This recording already has a transcript. Trying again replaces it, and any speaker names and the agent's answer will be redone. Try again?";

/**
 * What "try again" says when the note already holds speaker names: the new
 * transcript's speakers start as numbers again. It does not say who gave the
 * names: a label the transcriber wrote itself is lost the same way, and the note
 * does not record who set a label. Spec #69 § 8: "'try again' removes it, says
 * names will be lost".
 */
export const TRY_AGAIN_NAMES_LOST =
	" Speaker names already in the note, whether you gave them or the transcriber wrote them, are replaced by numbers again.";

/** Added when the user had said "leave the rest unnamed": that goes too. */
export const TRY_AGAIN_NAMING_CLEARED = " “Leave the rest unnamed” is cleared as well.";

/**
 * The question for this note: the plain one, and when the note holds names or a
 * "leave the rest unnamed" the matching sentences go before its closing
 * "Try again?", so the question is still the last thing asked.
 */
export function tryAgainQuestion(note: TranscriptNote): string {
	const warning =
		(hasNamedSpeakers(note) ? TRY_AGAIN_NAMES_LOST : "") +
		(isNamingFinished(note) ? TRY_AGAIN_NAMING_CLEARED : "");
	return warning === "" ? TRY_AGAIN_QUESTION : TRY_AGAIN_QUESTION.replace(/ Try again\?$/, `${warning} Try again?`);
}

/**
 * The question "run the agent again" asks before it replaces an agent section
 * that has text. The note keeps no copy of what the agent wrote, so any text
 * there may be the user's own changes.
 */
export const RUN_AGENT_QUESTION =
	"The agent's section already has text, and it may hold changes you made. Running the agent again replaces it. Run it again?";

/** What an action did, in words for a notice. `changed` is false when nothing was written. */
export interface ActionResult {
	changed: boolean;
	message: string;
}

export interface ActionPorts extends Pick<LifecyclePorts, "vault" | "clock" | "settings"> {
	/** Where a meeting's participants are read from; without it a by-hand request has none. */
	noteProperties?: LifecyclePorts["noteProperties"];
	/**
	 * The paths of the notes that embed the recording at `audioPath`. Without
	 * it, a by-hand request made with the audio file itself in focus cannot
	 * tell which note the recording is in.
	 */
	notesEmbedding?: (audioPath: string) => string[];
	/** The Daily Notes plugin's folder and format, or `undefined` when it is off; they say which notes are daily logs. */
	dailyNotes?: () => DailyNotesOptions | undefined;
	/** Ask a yes/no question; `false` for no or for dismissing the dialog. */
	confirm(question: string): Promise<boolean>;
	/**
	 * Called after the note at `notePath` was written or created, so what is
	 * drawn follows at once. It only looks at the note: it must not wait for a
	 * transcription, because the action's answer waits for it.
	 */
	refresh(notePath: string): Promise<void>;
	/**
	 * `Lifecycle.exclusively`: run `step` while the lifecycle's adapters and the
	 * keep time are kept off the note at `path`. Every action reads the note and
	 * writes a changed copy back inside it, so an answer or a keep flag written
	 * meanwhile is not overwritten by the older copy. `{ ran: false }` when
	 * something is on the note, and `holder` says what: `"work"` is the adapters'
	 * transcription or agent request, `"other"` anything else, and a port that
	 * does not say counts as `"other"`. The action then changes nothing and says
	 * so; the two cancels alone write anyway when the holder is `"work"`.
	 */
	exclusively<T>(
		path: string,
		step: () => Promise<T>,
	): Promise<{ ran: true; value: T } | { ran: false; holder?: "work" | "other" }>;
}

const unchanged = (message: string): ActionResult => ({ changed: false, message });

const BUSY =
	"The recording is being worked on right now, so this cannot be changed yet. Try again when that is done.";

/** Writes the changed copy of the note an action is working on. */
type WriteNote = (note: TranscriptNote) => Promise<void>;

export class RecordingActions {
	constructor(private readonly ports: ActionPorts) {}

	/** Cancel a recording that is waiting or being transcribed. The note stays. */
	async cancel(notePath: string): Promise<ActionResult> {
		return this.underGuard(notePath, (write) => this.cancelStep(notePath, write), { writeWhenHeld: true });
	}

	/**
	 * `cancel` for a caller that already holds the note's guard, which the guard
	 * does not allow twice: `Removal` cancels inside its own hold on the note.
	 */
	cancelHoldingGuard(notePath: string): Promise<ActionResult> {
		return this.cancelStep(notePath, (note) => this.save(notePath, note));
	}

	private async cancelStep(notePath: string, write: WriteNote): Promise<ActionResult> {
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return unchanged(loaded);
		if (!this.offered(loaded, "cancel")) {
			return unchanged("Only a recording that is waiting or being transcribed can be cancelled");
		}
		await write(markCancelled(loaded));
		return { changed: true, message: "Cancelled. The note stays; “Transcribe” asks again." };
	}

	/**
	 * Cancel the agent while it is waiting or working: the note says
	 * `agent: cancelled`, naming by hand is allowed, and "Run agent again" asks
	 * afresh. A hand-off program's answer written after the cancel is kept; a
	 * service request already in flight is dropped (its device writes only while
	 * the note still shows its own claim).
	 */
	async cancelAgent(notePath: string): Promise<ActionResult> {
		return this.underGuard(notePath, async (write) => {
			const loaded = await this.load(notePath);
			if (typeof loaded === "string") return unchanged(loaded);
			const { agent } = this.stateOf(loaded);
			if (agent !== "waiting" && agent !== "working") {
				return unchanged("Only an agent that is waiting or working can be cancelled");
			}
			await write(markAgentCancelled(loaded));
			return { changed: true, message: "The agent is cancelled. “Run agent again” asks it afresh." };
		}, { writeWhenHeld: true });
	}

	/**
	 * Raise the attempt so the program redoes the recording. On a note that
	 * already has text it asks first; the text stays until the program answers.
	 */
	async tryAgain(notePath: string): Promise<ActionResult> {
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return unchanged(loaded);
		const audioDeleted = readString(loaded, "audio-deleted");
		if (audioDeleted !== undefined) {
			return unchanged(`The audio was deleted ${audioDeleted}, so there is nothing to try again`);
		}
		if (!this.offered(loaded, "try-again")) {
			return unchanged("This recording is not in a state that can be tried again");
		}
		if (hasText(loaded) && !(await this.ports.confirm(tryAgainQuestion(loaded)))) {
			return unchanged("Left as it was");
		}
		// The dialog can stay open for any time, so the guard is taken only now:
		// read the note again, so a transcript, an answer or a correction written
		// meanwhile is not lost, and check it is still something that can be tried again.
		return this.underGuard(notePath, async (write) => {
			const current = await this.load(notePath);
			if (typeof current === "string") return unchanged(current);
			if (!this.offered(current, "try-again") || readString(current, "audio-deleted") !== undefined) {
				return unchanged("This recording changed while the question was open, and can no longer be tried again");
			}
			// A new transcript has new speakers: "leave the rest unnamed" goes with the old ones.
			await write(markTryAgain(clearNaming(current), this.transcriberKindNow(current)));
			return { changed: true, message: "Asked again. The old text stays until the program answers." };
		});
	}

	/**
	 * Name a speaker: `written` replaces `label` throughout the note, exactly as
	 * given (a participant or the owner as the note lists them, a typed name as
	 * plain text). The note is read again here, so a correction made while the
	 * list was open is not lost.
	 */
	async nameSpeaker(notePath: string, label: string, written: string): Promise<ActionResult> {
		return this.underGuard(notePath, async (write) => {
			const loaded = await this.load(notePath);
			if (typeof loaded === "string") return unchanged(loaded);
			const waiting = this.namingWaits(loaded);
			if (waiting !== null) return unchanged(waiting);
			const renamed = renameSpeaker(loaded, label, written);
			if (renamed === loaded) return unchanged(`${label} is no longer in this note`);
			await write(renamed);
			return { changed: true, message: `${label} is now ${written}` };
		});
	}

	/**
	 * Why naming cannot start on this note right now, or `null` when it can: the
	 * note cannot be read, or text is about to be replaced or added. Asked before
	 * the list opens, so nobody picks a name that would be refused.
	 */
	async whyNotNaming(notePath: string): Promise<string | null> {
		const loaded = await this.load(notePath);
		return typeof loaded === "string" ? loaded : this.namingWaits(loaded);
	}

	/**
	 * Naming waits while the transcriber or the agent is waiting or working for
	 * this note. A new transcript replaces the text a name would be
	 * written into; an agent answer written from the transcript it read earlier
	 * would bring `Speaker N` back into the note.
	 */
	private namingWaits(note: TranscriptNote): string | null {
		const state = this.stateOf(note);
		if (state.transcriber === "waiting" || state.transcriber === "being-transcribed") {
			return "The transcript is being redone, so its speakers cannot be named yet. Wait for the new transcript, or cancel it first";
		}
		if (state.agent === "waiting" || state.agent === "working") {
			return "The agent is still answering, so the speakers cannot be named yet. Wait for its answer, or cancel it first";
		}
		return null;
	}

	/** "Leave the rest unnamed": the note says `naming: finished` and stops asking. */
	async leaveUnnamed(notePath: string): Promise<ActionResult> {
		return this.underGuard(notePath, async (write) => {
			const loaded = await this.load(notePath);
			if (typeof loaded === "string") return unchanged(loaded);
			if (speakersToName(loaded, this.stateOf(loaded)) === 0) {
				return unchanged("There are no unnamed speakers to leave");
			}
			await write(leaveRestUnnamed(loaded));
			return { changed: true, message: "The rest are left unnamed. “Try again” asks about them afresh." };
		});
	}

	/**
	 * The first speaker still named only by number: where "Name speakers"
	 * starts. When there is none, or the note cannot be read, the `notice` says
	 * which: an unreadable note is never reported as fully named.
	 */
	async firstUnnamed(notePath: string): Promise<{ label: string } | { notice: string }> {
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return { notice: loaded };
		const label = unnamedLabels(loaded)[0];
		return label === undefined ? { notice: "Every speaker in this note is named" } : { label };
	}

	/**
	 * Run the agent again by hand: the plugin asks for the agent's step afresh
	 * (`agent: requested`, `agent-attempt` raised by one), and the agent that is
	 * chosen for the note's mode answers. A section that has text is replaced
	 * only after the user says yes.
	 */
	async runAgentAgain(notePath: string): Promise<ActionResult> {
		const refusal = (note: TranscriptNote): string | null => {
			const mode = modeKeyOf(note);
			if (mode === undefined || this.ports.settings().agents[mode].kind === "none") {
				return "No agent is chosen for this kind of recording — choose one in the settings";
			}
			const state = this.stateOf(note);
			if (state.transcriber !== "done" && state.transcriber !== "done-without-speaker-split") {
				return "There is no transcript yet for the agent to work on";
			}
			if ((state.agent === "waiting" || state.agent === "working") && !state.agentOverdue) {
				return "The agent is already on its way with this recording";
			}
			return null;
		};
		const loaded = await this.load(notePath);
		if (typeof loaded === "string") return unchanged(loaded);
		const why = refusal(loaded);
		if (why !== null) return unchanged(why);
		if (hasAgentText(loaded) && !(await this.ports.confirm(RUN_AGENT_QUESTION))) {
			return unchanged("Left as it was");
		}
		// The dialog can stay open for any time, so the guard is taken only now:
		// read the note again, so an answer or an edit written meanwhile is judged
		// on what the note says now.
		return this.underGuard(notePath, async (write) => {
			const current = await this.load(notePath);
			if (typeof current === "string") return unchanged(current);
			const nowWhy = refusal(current);
			if (nowWhy !== null) return unchanged(`This recording changed while the question was open. ${nowWhy}`);
			const { clock } = this.ports;
			const raised = clock.now();
			const kind = this.agentKindNow(current);
			await write(
				markAgentRequested(current, { kind, raisedAt: formatTimestamp(raised, clock.utcOffsetMinutes(raised)) }),
			);
			return { changed: true, message: "Asked the agent again. The old section stays until it answers." };
		});
	}

	/** Ask again for a cancelled recording. */
	async requestAgain(notePath: string): Promise<ActionResult> {
		return this.underGuard(notePath, async (write) => {
			const loaded = await this.load(notePath);
			if (typeof loaded === "string") return unchanged(loaded);
			if (!this.offered(loaded, "transcribe")) {
				return unchanged("Only a cancelled recording can be requested again");
			}
			await write(markTryAgain(loaded, this.transcriberKindNow(loaded)));
			return { changed: true, message: "Requested again" };
		});
	}

	/**
	 * Transcribe a recording: create the request for an older recording that
	 * has none, or ask again for one whose request was cancelled. A recording
	 * that already has a request is left alone.
	 *
	 * `mode` chooses the transcriber; without it the mode is the linking note's
	 * (`modeOfLinkingNote`). `linkedFrom` is the note the recording is embedded
	 * in; without it the notes that embed the recording are looked up.
	 */
	async transcribe(
		audioPath: string,
		options: { mode?: RecordingModeKey; linkedFrom?: string } = {},
	): Promise<ActionResult> {
		const { vault, clock, settings } = this.ports;
		if (!isAudioPath(audioPath)) return unchanged(`${audioPath} is not a recording`);
		const existing = await this.noteForAudio(audioPath);
		if (existing !== null) {
			const note = parseTranscriptNote((await vault.read(existing)) ?? "");
			if (note !== null && deriveState(note, clock.now(), settings().overdueHours).transcriber === "cancelled") {
				return this.requestAgain(existing);
			}
			return unchanged("This recording already has a request");
		}

		const guess: Guess =
			options.mode === undefined
				? await this.guessMode(audioPath, options.linkedFrom)
				: { mode: options.mode, ...(options.linkedFrom === undefined ? {} : { linkedFrom: options.linkedFrom }) };
		const mode = guess.mode;
		if (settings().transcribers[mode].kind === "none") {
			const none = "No transcriber is chosen for this kind of recording — choose one in the settings";
			return unchanged(guess.why === undefined ? none : `${guess.why} ${none}`);
		}
		const bytes = await vault.fileSize(audioPath);
		if (bytes === null) return unchanged(`There is no recording at ${audioPath}`);

		const notePath = transcriptPathFor(settings().transcriptFolder, audioPath);
		const request = buildRequestNote(
			requestForRecording(this.ports, {
				mode,
				audioPath,
				audioBytes: bytes,
				...(guess.linkedFrom === undefined ? {} : { linkingNotePath: guess.linkedFrom }),
				notePath,
				recordedAt: recordedAt(audioPath, clock),
			}),
		);
		const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
		if (folder !== "") await vault.createFolder(folder);
		await vault.create(notePath, serializeTranscriptNote(request));
		await this.ports.refresh(notePath);
		const requested = "Requested. It waits for the transcriber.";
		return { changed: true, message: guess.why === undefined ? requested : `${requested} ${guess.why}` };
	}

	/**
	 * The note a recording is linked from, and the mode a recording there would
	 * have had at stop. With `linkedFrom` known that note decides; without it
	 * (the audio file itself is in focus) the notes embedding the recording are
	 * looked up: none gives the daily log, one decides, several decide when
	 * they agree and otherwise give the daily log with a notice naming them.
	 */
	private async guessMode(audioPath: string, linkedFrom: string | undefined): Promise<Guess> {
		if (linkedFrom !== undefined) return this.modeOfLinkingNote(linkedFrom);
		const notes = [...(this.ports.notesEmbedding?.(audioPath) ?? [])].sort();
		if (notes.length === 0) return dailyLogGuess("This recording is not embedded in any note");
		const guesses = await Promise.all(notes.map((note) => this.modeOfLinkingNote(note)));
		if (guesses.every((guess) => guess.mode === guesses[0].mode)) return guesses[0];
		return dailyLogGuess(`This recording is embedded in ${notes.join(", ")}, which are not the same kind of note`);
	}

	/**
	 * The mode a recording embedded in the note `linkedFrom` would have had at
	 * stop. The note itself records no mode, so, in this order: a daily log's
	 * path gives the daily log; a note that names participants is a meeting
	 * note; otherwise the mode the other recordings linked from it agree on.
	 * With none, or several different modes, the daily log's mode, and `why`
	 * says so for the notice.
	 */
	private async modeOfLinkingNote(linkedFrom: string): Promise<Guess> {
		const { settings, noteProperties, dailyNotes } = this.ports;
		const withNote = (mode: RecordingModeKey): Guess => ({ mode, linkedFrom });
		if (isDailyLogPath(linkedFrom, dailyLogConfigFor(settings(), dailyNotes?.()))) return withNote("dailyLog");
		const property = settings().participantsProperty.trim();
		if (property !== "" && (noteProperties?.list(linkedFrom, property)?.length ?? 0) > 0) {
			return withNote("meeting");
		}
		const modes = new Set<RecordingModeKey>();
		for (const path of await this.ports.vault.listTranscriptNotes()) {
			const note = parseTranscriptNote((await this.ports.vault.read(path)) ?? "");
			const link = note === null ? undefined : readString(note, "linked-from");
			if (note === null || link === undefined || !linksTo(link, linkedFrom)) continue;
			const mode = modeKeyOf(note);
			if (mode !== undefined) modes.add(mode);
		}
		if (modes.size === 0) return { ...dailyLogGuess(`There is no other recording in ${linkedFrom} to say what kind of note it is`), linkedFrom };
		if (modes.size > 1) {
			return {
				...dailyLogGuess(`The recordings in ${linkedFrom} were made in different modes (daily log, cursor, meeting)`),
				linkedFrom,
			};
		}
		return withNote([...modes][0]);
	}

	// --- Helpers -------------------------------------------------------------------

	/**
	 * The transcriber kind the note's mode has in the settings now, which a new
	 * attempt is written for; `undefined` for a mode word the plugin does
	 * not know, whose note keeps the kind it had.
	 */
	private transcriberKindNow(note: TranscriptNote): TranscriberKind | undefined {
		const mode = modeKeyOf(note);
		return mode === undefined ? undefined : this.ports.settings().transcribers[mode].kind;
	}

	/** The agent kind the note's mode has in the settings now, which an ask is written for; as `transcriberKindNow`. */
	private agentKindNow(note: TranscriptNote): AgentKind | undefined {
		const mode = modeKeyOf(note);
		return mode === undefined ? undefined : this.ports.settings().agents[mode].kind;
	}

	private stateOf(note: TranscriptNote): ReturnType<typeof deriveState> {
		return deriveState(note, this.ports.clock.now(), this.ports.settings().overdueHours);
	}

	private offered(note: TranscriptNote, action: RecordingAction): boolean {
		return actionsFor(note, this.stateOf(note)).offers.some((offer) => offer.action === action);
	}

	/** The parsed note, or the reason it cannot be acted on. */
	private async load(notePath: string): Promise<TranscriptNote | string> {
		const text = await this.ports.vault.read(notePath);
		if (text === null) return `There is no note at ${notePath}`;
		return parseTranscriptNote(text) ?? "This note is not a transcript note this plugin wrote";
	}

	private async save(notePath: string, note: TranscriptNote): Promise<void> {
		await this.ports.vault.write(notePath, serializeTranscriptNote(note));
		await this.ports.refresh(notePath);
	}

	/**
	 * Run an action's final read and write as one step under the note's guard.
	 * The step writes through the function it is given; the redraw (`refresh`)
	 * waits until the guard is let go, because it hands the note to the
	 * lifecycle's tick, which would find the note held and pass it by. A note
	 * someone else holds is not waited for: the action changes nothing and says
	 * so.
	 *
	 * Exception, `writeWhenHeld`, for the two cancels: when the holder is the
	 * adapters' work (the transcription or the agent request being cancelled;
	 * its tick holds the note for the whole of it), that work reads the cancel
	 * from the note and drops its late answer, and refusing the cancel would
	 * refuse it exactly while it is offered, so it writes as it did before the
	 * guard, unguarded. Any other holder (a keep click being applied, another
	 * action's write, the lifecycle's own agent request or naming, a removal)
	 * has a write of its own pending, and a copy read before it would be saved
	 * after it, so the cancel is refused like every other action.
	 */
	private async underGuard(
		notePath: string,
		step: (write: WriteNote) => Promise<ActionResult>,
		options: { writeWhenHeld?: boolean } = {},
	): Promise<ActionResult> {
		let wrote = false;
		const ran = await this.ports.exclusively(notePath, () =>
			step(async (note) => {
				await this.ports.vault.write(notePath, serializeTranscriptNote(note));
				wrote = true;
			}),
		);
		if (!ran.ran) {
			if (options.writeWhenHeld === true && ran.holder === "work") {
				return step((note) => this.save(notePath, note));
			}
			return unchanged(BUSY);
		}
		if (wrote) await this.ports.refresh(notePath);
		return ran.value;
	}

	/** The transcript note whose `audio` property names this recording, or `null`. */
	private async noteForAudio(audioPath: string): Promise<string | null> {
		const name = audioPath.slice(audioPath.lastIndexOf("/") + 1);
		for (const path of await this.ports.vault.listTranscriptNotes()) {
			const note = parseTranscriptNote((await this.ports.vault.read(path)) ?? "");
			const link = note === null ? undefined : readString(note, "audio");
			if (link === undefined) continue;
			const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0];
			if (target.slice(target.lastIndexOf("/") + 1) === name) return path;
		}
		return null;
	}
}

const hasText = (note: TranscriptNote): boolean =>
	[readSection(note, "transcript"), readSection(note, "agent")].some(
		(text) => text !== undefined && text.trim() !== "",
	);

/** Same place `lifecycle.ts` puts a transcript note: the transcript folder, else beside the audio. */
function transcriptPathFor(transcriptFolder: string, audioPath: string): string {
	const slash = audioPath.lastIndexOf("/");
	const audioFolder = slash === -1 ? "" : audioPath.slice(0, slash);
	const name = audioPath.slice(slash + 1).replace(/\.[^.]+$/, "") + ".md";
	const configured = normalizeFolder(transcriptFolder.trim());
	const folder = configured === "" ? audioFolder : configured;
	return folder === "" ? name : `${folder}/${name}`;
}

/**
 * When the recording stopped, read from `Recording YYYYMMDDHHMMSS` in the
 * clock's zone; the clock's now when the name has no such stamp. An older
 * recording is dated by its own name, so it is not made to look new.
 */
function recordedAt(audioPath: string, clock: ActionPorts["clock"]): Date {
	const stamp = /Recording (\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\./.exec(audioPath);
	if (!stamp) return clock.now();
	const [y, mo, d, h, mi, s] = stamp.slice(1).map(Number);
	const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	return new Date(guess.getTime() - clock.utcOffsetMinutes(guess) * 60_000);
}

/** What the by-hand guess settles: the mode, the note it came from, and the reason for a notice when it is a guess. */
interface Guess {
	mode: RecordingModeKey;
	linkedFrom?: string;
	why?: string;
}

const dailyLogGuess = (reason: string): Guess => ({
	mode: "dailyLog",
	why: `${reason}, so it is requested as a daily log recording.`,
});

const withoutMd = (path: string): string => path.replace(/\.md$/, "");

/**
 * Whether the `linked-from` link text of a transcript note names the note at
 * `notePath`. The request writes the shortest link that is unambiguous, so a
 * link is the whole path or a tail of it; two notes of one name in different
 * folders therefore stay apart.
 */
function linksTo(linkText: string, notePath: string): boolean {
	const target = withoutMd(linkText.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0]);
	const path = withoutMd(notePath);
	return path === target || path.endsWith(`/${target}`);
}

/** Whether `path` is where the daily log of some date lives: the configured folder, a name in the configured format. */
function isDailyLogPath(path: string, config: DailyLogConfig): boolean {
	const folder = normalizeFolder(config.folder.trim());
	const slash = path.lastIndexOf("/");
	if ((slash === -1 ? "" : normalizeFolder(path.slice(0, slash))) !== folder) return false;
	const widths: Record<string, number> = { YYYY: 4, MM: 2, DD: 2, HH: 2, mm: 2, ss: 2 };
	const pattern = config.format
		.split(/(YYYY|MM|DD|HH|mm|ss)/)
		.map((part) => (Object.prototype.hasOwnProperty.call(widths, part) ? `\\d{${widths[part]}}` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`^${pattern}$`).test(withoutMd(path.slice(slash + 1)));
}
