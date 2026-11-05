/**
 * The lifecycle of a recording: what happens when one stops, and (from the
 * hand-off ticket on) what happens to its transcript note afterwards.
 *
 * This module owns the rules and touches the outside world only through the
 * ports below, so it runs under Node with no Obsidian. `main.ts` builds the
 * real ports (`obsidian-ports.ts`); tests build the fakes in
 * `lifecycle-fakes.ts`.
 *
 * `recordingStopped` is the one place "a recording stopped" is handled, so a
 * later ticket hooks in here and nowhere else.
 */

import { HAND_OFF_AGENT } from "./agent-hand-off";
import { shouldRequestAgent } from "./agent-service";
import { decideAudioPath } from "./audio-path";
import { rememberNumbered, withNamesGiven, type SeenLabels } from "./late-names";
import { insertAtSnapshot, insertInMeetingNote, type CursorSnapshot } from "./cursor-snapshot";
import { classifyInsertOutcome, insertRecordingLink } from "./note-insert";
import { holdsOwnClaim, identityOf, inGracePeriod, isServedKind, letGoOfClaim, type ClaimStep } from "./serving-device";
import {
	RECORDING_MODE_KEYS,
	type AgentEntry,
	type AgentKind,
	type RecordingModeKey,
	type TranscriberEntry,
	type TranscriberKind,
	type VaultRecorderSettings,
} from "./settings-data";
import {
	MODE_WORDS,
	buildRequestNote,
	deriveState,
	formatTimestamp,
	markAgentFor,
	markAgentRequested,
	parseTranscriptNote,
	readAgentKind,
	readString,
	readTranscribeKind,
	serializeTranscriptNote,
	type DerivedState,
	type TranscriptNote,
	type TranscriptRequest,
} from "./transcript-note";

/**
 * Peak-RMS threshold for a recording. Below this, the microphone was muted or
 * the room was completely silent, and no file is saved.
 * 0.02 is roughly -34 dBFS: a normal microphone in a quiet room has enough
 * self-noise to peak above 0.03, while a hard-muted one peaks near zero.
 * It is calibrated against linear RMS, so the peak handed in must be the
 * unscaled one.
 */
export const SILENT_THRESHOLD = 0.02;

/**
 * Smallest blob worth saving as a recording. Belt and braces on top of the
 * peak-RMS threshold: it catches header-only files that never received any
 * chunk, from a MediaRecorder that never fired `dataavailable`. Raised from
 * 1024 — an MP4 or WebM header is often over 1 KB on its own.
 */
export const MIN_AUDIO_BYTES = 8192;

// --- Ports -------------------------------------------------------------------

/**
 * The vault, as the lifecycle needs it. Paths are vault-relative, with `/`.
 * `create` and `createBinary` throw when the path is taken, as Obsidian's do.
 */
export interface VaultPort {
	/** The text of a file, or `null` when there is no such file. */
	read(path: string): Promise<string | null>;
	/** Replace the text of a file that exists. */
	write(path: string, text: string): Promise<void>;
	/** Create a text file. Throws when the path is taken. */
	create(path: string, text: string): Promise<void>;
	/** Create a binary file. Throws when the path is taken. */
	createBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Create a folder; nothing happens when it already exists. */
	createFolder(path: string): Promise<void>;
	/** Move a file to the trash, following Obsidian's own trash setting. */
	trash(path: string): Promise<void>;
	/** Size in bytes of the file at `path`, or `null` when there is no such file. */
	fileSize(path: string): Promise<number | null>;
	/**
	 * The paths of the notes whose properties carry `rule-version` — the
	 * candidates for a transcript note. Recognition by properties, never by
	 * folder or name.
	 */
	listTranscriptNotes(): Promise<string[]>;
	/** The text to put inside `[[…]]` to link `path` from the note at `fromPath`. */
	linkText(path: string, fromPath: string): string;
	/**
	 * Where Obsidian would save an attachment called `filename` added to the
	 * note at `sourcePath`: its attachment setting applied, `./` and `./sub`
	 * included, and a ` 1` suffix when the name is taken.
	 */
	availablePathForAttachment(filename: string, sourcePath: string): Promise<string>;
}

export interface ClockPort {
	now(): Date;
	/** Minutes east of UTC that the clock's own zone is at `at` (+120 for +02:00). */
	utcOffsetMinutes(at: Date): number;
}

export type DeviceRole = "ordinary" | "serving";

/** Who this device is. Never written into a transcript note on its own. */
export interface DevicePort {
	/**
	 * A stable id for this device, kept in local storage and never shown. A
	 * claim carries it beside the name, so two devices on the same default name
	 * are told apart and a rename does not strand a claim. A device that has
	 * none is told apart by its name.
	 */
	id?(): string;
	name(): string;
	role(): DeviceRole;
	isPhone(): boolean;
}

/** Properties of a note, as the metadata cache has them. */
export interface NotePropertiesPort {
	/**
	 * The values of the property `property` in the note at `path`, as strings,
	 * or `undefined` when the note has no such property. A single value comes
	 * back as a list of one.
	 */
	list(path: string, property: string): string[] | undefined;
}

export interface LifecyclePorts {
	vault: VaultPort;
	clock: ClockPort;
	device: DevicePort;
	noteProperties: NotePropertiesPort;
	/** Read live, so a change in the settings page applies to the next stop. */
	settings: () => VaultRecorderSettings;
}

// --- The stop path -----------------------------------------------------------

/** Where the link to the new recording goes. */
export type LinkTarget =
	| { kind: "daily-log"; path: string }
	| { kind: "cursor"; snapshot: CursorSnapshot };

/** Everything the lifecycle needs to know about a recording that has just stopped. */
export interface StoppedRecording {
	/** The recording mode; chooses the transcriber and agent. */
	mode: "dailyLog" | "cursor" | "meeting";
	/** `Recording YYYYMMDDHHMMSS.<ext>`. */
	filename: string;
	/** Highest linear RMS seen while recording, unscaled. */
	peak: number;
	audio: ArrayBuffer;
	linkTarget: LinkTarget;
}

export interface StopResult {
	outcome: "saved" | "silent" | "too-short";
	/** Where the audio went; set when `outcome` is `"saved"`. */
	audioPath?: string;
	/** The transcript note this stop created; set only when it created one. */
	transcriptNotePath?: string;
	/** Messages for the user, in the order to show them. */
	messages: string[];
}

/** What the lifecycle knows about one transcript note, as of the last time it looked. */
export interface NoteStatus {
	path: string;
	state: DerivedState;
	/**
	 * Why this device cannot take the note forward, derived here from this
	 * device's settings and never written into the note; `null` when nothing on
	 * this device is in the way.
	 */
	waitingReason: string | null;
}

/** A change to what is known about a transcript note; `current` is `undefined` once the note is gone. */
export interface NoteStatusChange {
	path: string;
	previous: NoteStatus | undefined;
	current: NoteStatus | undefined;
}

/** What `requestForRecording` needs to know about one recording. */
export interface RecordingRequestInput {
	mode: "dailyLog" | "cursor" | "meeting";
	audioPath: string;
	audioBytes: number;
	/** The note the recording is embedded in; `undefined` when it is in none. */
	linkingNotePath?: string;
	/** Where the transcript note will be written; links are made relative to it. */
	notePath: string;
	recordedAt: Date;
}

/**
 * The request a recording of this mode has: the one built at stop, and the one
 * "Transcribe this recording" builds for an older recording, so the two cannot
 * drift apart. The meeting mode splits speakers; the linking note's
 * participants go in when it lists any. The mode's transcriber kind goes in as
 * `transcribe-kind`, so a program takes only what the user chose it for.
 */
export function requestForRecording(
	ports: Pick<LifecyclePorts, "vault" | "clock" | "settings"> & Partial<Pick<LifecyclePorts, "noteProperties">>,
	input: RecordingRequestInput,
): TranscriptRequest {
	const { vault, clock, noteProperties } = ports;
	const settings = ports.settings();
	const { audioPath, linkingNotePath, notePath } = input;
	const request: TranscriptRequest = {
		audio: vault.linkText(audioPath, notePath),
		audioBytes: input.audioBytes,
		mode: MODE_WORDS[input.mode],
		recorded: formatTimestamp(input.recordedAt, clock.utcOffsetMinutes(input.recordedAt)),
		speakerSplit: input.mode === "meeting",
		attempt: 1,
		transcribeKind: settings.transcribers[input.mode].kind,
	};
	if (linkingNotePath !== undefined) request.linkedFrom = vault.linkText(linkingNotePath, notePath);
	const participantsProperty = settings.participantsProperty.trim();
	const participants =
		participantsProperty === "" || linkingNotePath === undefined
			? undefined
			: noteProperties?.list(linkingNotePath, participantsProperty);
	if (participants !== undefined && participants.length > 0) {
		request.participants = participants;
	}
	const owner = settings.ownerName.trim();
	if (owner !== "") request.owner = owner;
	const language = settings.language.trim();
	if (language !== "" && language !== "detect") request.language = language;
	return request;
}

/**
 * The notes the lifecycle holds, and for each whether the holder is the
 * adapters' work (`work`: a transcription or an agent request under way) or
 * anything else. Letting one go also runs, in the order they were asked, what
 * is waiting for that note to be free (`whenFree`), so the four places that let
 * a note go cannot forget a waiter.
 */
class HeldNotes extends Map<string, { at: number; work?: true }> {
	private readonly waiting = new Map<string, (() => void)[]>();

	/** Run `run` the moment the note at `path` is free: at once when it is. */
	whenFree(path: string, run: () => void): void {
		if (!this.has(path)) {
			run();
			return;
		}
		this.waiting.set(path, [...(this.waiting.get(path) ?? []), run]);
	}

	override delete(path: string): boolean {
		const deleted = super.delete(path);
		const waiters = this.waiting.get(path);
		if (deleted && waiters !== undefined) {
			this.waiting.delete(path);
			// A waiter that throws must not stop the others, nor the release it runs in.
			for (const run of waiters) {
				try {
					run();
				} catch (err) {
					console.error(`[vault-recorder] something waiting for '${path}' failed:`, err);
				}
			}
		}
		return deleted;
	}
}

export class Lifecycle {
	private readonly statusByPath = new Map<string, NoteStatus>();
	private readonly listeners = new Set<(change: NoteStatusChange) => void>();
	/**
	 * Notes whose adapters are being run right now, or whose claim is being let
	 * go of, so a later tick leaves them be.
	 */
	private readonly dispatching = new HeldNotes();
	/** When the window was last hidden, or `null`; see `returnedToScreen`. */
	private awayAt: number | null = null;
	/**
	 * Transcript notes this lifecycle made at a stop. The device that recorded
	 * goes first, so a serving device does not hold back its own recordings. It
	 * lives in memory: after a restart the grace period applies to every note.
	 */
	private readonly madeHere = new Set<string>();
	/**
	 * For each note, the `transcriber-at` this device last asked the agent about.
	 * Two devices' clocks can disagree about whether an answer came after a
	 * transcript; this keeps one device from asking again and again for the same
	 * transcript. It lives in memory: after a restart the note's own words decide.
	 */
	private readonly agentAskedFor = new Map<string, string>();
	/**
	 * For each note whose agent has not answered, the numbered turns seen before any naming; an entry clears when the names are written or the agent has answered, not before. In memory only.
	 */
	private readonly seenLabels = new Map<string, SeenLabels>();

	constructor(
		private readonly ports: LifecyclePorts,
		private readonly adapters: Adapters = defaultAdapters(),
	) {}

	/**
	 * A recording has stopped: decide whether it is worth keeping, save it,
	 * link it from the note it belongs to.
	 *
	 * Throws when the audio cannot be written, as the stop path always did; the
	 * caller shows that. Problems after the audio is safe (a link that cannot be
	 * written, a request that cannot be written) come back as messages.
	 */
	async recordingStopped(stop: StoppedRecording): Promise<StopResult> {
		// The primary guard against a silent recording: if the peak RMS never
		// rose above SILENT_THRESHOLD, the microphone was muted or the room was
		// completely silent. Do not save — the transcriber would otherwise
		// produce an empty transcript.
		if (stop.peak < SILENT_THRESHOLD) {
			return {
				outcome: "silent",
				messages: ["The recording was silent — no file saved"],
			};
		}

		// Belt and braces: a header-only blob with no chunks. Rare, but it
		// covers MediaRecorder edge cases where a peak was reported and no
		// audio chunk was ever delivered.
		if (stop.audio.byteLength < MIN_AUDIO_BYTES) {
			return {
				outcome: "too-short",
				messages: [
					"The recording was too short or too quiet — no file saved",
				],
			};
		}

		const messages: string[] = [];
		const linkingNotePath = linkTargetPath(stop.linkTarget);

		const audioPath = await resolveAudioPath(
			this.ports,
			stop.filename,
			linkingNotePath,
			stop.audio.byteLength,
		);
		await this.saveAudio(audioPath, stop.audio);
		// The link names the file actually written, which is not `stop.filename`
		// when Obsidian suffixed it.
		const audioName = audioPath.slice(audioPath.lastIndexOf("/") + 1);

		// The transcript note goes first: a meeting note's link to it is written
		// beside the audio embed in the same line, and Obsidian can only name a
		// note it already has.
		const requested = await this.requestTranscript(stop, audioPath, linkingNotePath);

		// The audio is safe: a link that cannot be written must not stop the
		// transcript request from being written, and the other way round.
		let linkMessage: string | null;
		try {
			linkMessage = await this.insertLink(
				stop.linkTarget,
				audioName,
				stop.mode === "meeting" ? requested.path : undefined,
				stop.mode,
			);
		} catch (err) {
			linkMessage = `The recording was saved but not linked: ${
				err instanceof Error ? err.message : String(err)
			}`;
		}
		if (linkMessage) messages.push(linkMessage);
		if (requested.message) messages.push(requested.message);

		messages.push(`Recording saved: ${audioName}`);
		return {
			outcome: "saved",
			audioPath,
			transcriptNotePath: requested.created ? requested.path : undefined,
			messages,
		};
	}

	// --- Transcript notes ------------------------------------------------------

	/**
	 * Create the transcript note for a recording whose mode has a transcriber
	 * that asks through a note. With "none" nothing is created. A note that is
	 * already there (the same stop run twice) is left exactly as it is: it may
	 * hold a transcriber's answer by now.
	 *
	 * A failure here must not lose the recording, which is already safe, so it
	 * comes back as a message for the user.
	 */
	private async requestTranscript(
		stop: StoppedRecording,
		audioPath: string,
		linkingNotePath: string,
	): Promise<{ created: boolean; path?: string; message?: string }> {
		const settings = this.ports.settings();
		const entry = settings.transcribers[stop.mode];
		const adapter = this.adapters.transcribers[entry.kind];
		if (!adapter) {
			return {
				created: false,
				message: `No transcriber of kind '${entry.kind}' is available — the recording was saved without a transcript request`,
			};
		}
		if (!adapter.requestsTranscriptNote) return { created: false };

		const path = transcriptNotePath(settings, audioPath);
		try {
			if ((await this.ports.vault.read(path)) !== null) {
				return { created: false, path };
			}
			await ensureParentFolder(this.ports.vault, path);
			const note = buildRequestNote(this.requestFor(stop, audioPath, linkingNotePath, path));
			await this.ports.vault.create(path, serializeTranscriptNote(note));
			this.madeHere.add(path);
			await this.observe(path, this.ports.clock.now(), false);
			return { created: true, path };
		} catch (err) {
			return {
				created: false,
				message: `The recording was saved, but its transcript request could not be written: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}

	private requestFor(
		stop: StoppedRecording,
		audioPath: string,
		linkingNotePath: string,
		notePath: string,
	): TranscriptRequest {
		return requestForRecording(this.ports, {
			mode: stop.mode,
			audioPath,
			audioBytes: stop.audio.byteLength,
			linkingNotePath,
			notePath,
			recordedAt: this.ports.clock.now(),
		});
	}

	/** What is known about every transcript note, as of the last `tick` or stop. */
	statuses(): NoteStatus[] {
		return [...this.statusByPath.values()];
	}

	/** What is known about one transcript note, or `undefined` when it is not known. */
	statusOf(path: string): NoteStatus | undefined {
		return this.statusByPath.get(path);
	}

	/**
	 * Be told whenever what is known about a transcript note changes: it
	 * appears, its state or overdue flag or waiting reason changes, it goes.
	 * This is the one place a view (the queue panel, the in-place drawing)
	 * hangs on. Returns the function that stops listening.
	 */
	onNoteStateChanged(listener: (change: NoteStatusChange) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Look at every transcript note in the vault at `now`: derive its state,
	 * tell the listeners what changed, and hand it to the adapter the note's
	 * mode has chosen. Waiting, overdue, retries, claims and deletion all hang
	 * off this one call, which `main.ts` makes on an interval.
	 *
	 * One note that cannot be read must not stop the rest, nor the interval:
	 * it is reported to the console and the next note is looked at.
	 *
	 * Ticks may overlap: an adapter's network call runs inside a tick and can
	 * outlast the interval, and one slow note must not stop the others. What
	 * must not overlap is one note's adapters, so a note whose adapters are still
	 * running is only looked at, not handed on again; the next interval tries it.
	 */
	async tick(now: Date): Promise<void> {
		const paths = await this.ports.vault.listTranscriptNotes();
		const present = new Set(paths);
		for (const path of paths) {
			try {
				await this.observe(path, now, true);
			} catch (err) {
				console.error(`[vault-recorder] could not look at transcript note '${path}':`, err);
			}
		}
		for (const path of [...this.statusByPath.keys()]) {
			if (!present.has(path)) this.record(path, undefined);
		}
	}

	/**
	 * Look again at one transcript note this lifecycle already knows, without
	 * handing it to its adapters: a view calls this when the note was edited, so
	 * what it draws follows at once rather than at the next tick.
	 */
	async lookAgain(path: string, now: Date): Promise<void> {
		if (!this.statusByPath.has(path)) return;
		try {
			await this.observe(path, now, false);
		} catch (err) {
			console.error(`[vault-recorder] could not look at transcript note '${path}':`, err);
		}
	}

	/**
	 * Look at one transcript note, known or not, without handing it to its
	 * adapters: what an action (cancel, try again, transcribe) calls so the view
	 * follows what it just wrote. It never waits for a transcription; the note's
	 * adapters meet it on the next tick.
	 */
	async look(path: string, now: Date): Promise<void> {
		try {
			await this.observe(path, now, false);
		} catch (err) {
			console.error(`[vault-recorder] could not look at transcript note '${path}':`, err);
		}
	}

	/**
	 * Read one note and record its status. With `dispatch`, also give it to the
	 * adapters its mode has chosen and write the names a person gave before the
	 * agent answered (`keepNamesGiven`); a note just created at stop is only
	 * recorded, and its adapters meet it on the next tick.
	 */
	private async observe(path: string, now: Date, dispatch: boolean): Promise<void> {
		const text = await this.ports.vault.read(path);
		const parsed = text === null ? null : parseTranscriptNote(text);
		if (parsed === null) {
			this.record(path, undefined);
			return;
		}
		let note: TranscriptNote = parsed;
		const settings = this.ports.settings();
		const mode = modeKeyOf(note);
		const asked = dispatch && mode ? await this.requestAgentIfDone(path, note, mode, now) : null;
		if (asked !== null) note = asked;
		const state = deriveState(note, now, settings.overdueHours);
		note = await this.keepNamesGiven(path, note, state.agent, dispatch);
		// Whose each step is: the kind the note names, so the plugin and a hand-off
		// program agree even after the mode's kind changed; the mode's kind in the
		// settings only for a note written before those lines existed.
		const transcriberEntry = mode
			? entryForKind(settings.transcribers[mode], readTranscribeKind(note))
			: undefined;
		const transcriberAdapter = transcriberEntry
			? this.adapters.transcribers[transcriberEntry.kind]
			: undefined;
		const agentEntry = mode ? entryForKind(settings.agents[mode], readAgentKind(note)) : undefined;
		const agentAdapter = agentEntry ? this.adapters.agents[agentEntry.kind] : undefined;
		let waitingReason: string | null = null;
		// A kind word the plugin does not know is taken by nothing here, and says so.
		const unknownKind = (step: "transcriber" | "agent", line: string, again: string): string =>
			`This recording asks for a kind of ${step} this plugin does not know ('${readString(note, line)}'). ${again} asks with the mode's kind now`;
		if (state.transcriber === "waiting" && mode && readTranscribeKind(note) === null) {
			waitingReason = unknownKind("transcriber", "transcribe-kind", "Cancel, then Transcribe,");
		} else if (state.agent === "waiting" && mode && readAgentKind(note) === null) {
			waitingReason = unknownKind("agent", "agent-kind", "Cancel agent, then Run agent again,");
		} else if (state.transcriber === "waiting" && transcriberAdapter && transcriberEntry) {
			waitingReason = transcriberAdapter.waitingReason(note, transcriberEntry, this.ports.device);
		} else if (state.agent === "waiting" && agentAdapter && agentEntry) {
			waitingReason = agentAdapter.waitingReason(note, agentEntry, this.ports.device);
		}
		this.record(path, { path, state, waitingReason });
		if (!dispatch) return;

		if (this.dispatching.has(path)) return;
		// Held as the adapters' work: a by-hand Cancel may write while this is the holder,
		// because the work it cancels reads the cancel and drops its late answer.
		const mine = { at: this.ports.clock.now().getTime(), work: true as const };
		this.dispatching.set(path, mine);
		try {
			// A serving device leaves a recording made elsewhere alone until the
			// grace period is over (serving-device.ts); the claim is the adapter's.
			const asking = {
				state,
				note,
				now,
				serving: this.ports.device.role() === "serving",
				madeHere: this.madeHere.has(path),
			};
			// A hand-off request is a program's to take, never a serving device's:
			// it is not given to an adapter's tick, whatever the adapter has.
			const takes = (step: ClaimStep, kind: string): boolean =>
				!asking.serving || isServedKind(step, kind);
			if (
				mode &&
				transcriberEntry &&
				transcriberAdapter?.tick &&
				takes("transcriber", transcriberEntry.kind) &&
				!inGracePeriod({ ...asking, step: "transcriber", kind: transcriberEntry.kind })
			) {
				await transcriberAdapter.tick({ path, note, state, mode, entry: transcriberEntry, now });
			}
			if (
				mode &&
				agentEntry &&
				agentAdapter?.tick &&
				state.agent !== "none" &&
				takes("agent", agentEntry.kind) &&
				!inGracePeriod({ ...asking, step: "agent", kind: agentEntry.kind })
			) {
				await agentAdapter.tick({ path, note, state, mode, entry: agentEntry, now });
			}
		} finally {
			// A release may have freed the path for a newer run already.
			if (this.dispatching.get(path) === mine) this.dispatching.delete(path);
		}
	}

	/**
	 * While the agent has not answered, remember the numbered turns; when its answer
	 * lands on a tick, write the names the person gave meanwhile over the `Speaker N`
	 * it still says. Returns the note as it stands afterwards.
	 */
	private async keepNamesGiven(
		path: string,
		note: TranscriptNote,
		agent: ReturnType<typeof deriveState>["agent"],
		dispatch: boolean,
	): Promise<TranscriptNote> {
		if (agent === "none") return note;
		const transcriptAt = readString(note, "transcriber-at") ?? "";
		if (agent !== "done") {
			this.seenLabels.set(path, rememberNumbered(this.seenLabels.get(path), note, transcriptAt));
			return note;
		}
		const seen = this.seenLabels.get(path);
		if (seen === undefined || !dispatch) return note;
		if (seen.transcriptAt === transcriptAt && withNamesGiven(note, seen) !== note) {
			const ran = await this.exclusively(path, async () => {
				const text = await this.ports.vault.read(path);
				const fresh = text === null ? null : parseTranscriptNote(text);
				if (fresh === null) return null;
				const named = withNamesGiven(fresh, seen);
				if (named === fresh) return fresh;
				await this.ports.vault.write(path, serializeTranscriptNote(named));
				return named;
			});
			if (!ran.ran) return note;
			this.seenLabels.delete(path);
			return ran.value ?? note;
		}
		this.seenLabels.delete(path);
		return note;
	}

	/**
	 * When a transcript is done and the mode has an agent, the plugin asks for the
	 * agent's step (`agent: requested`, `agent-attempt` raised by one). The rule
	 * is `shouldRequestAgent`. The note is read again right before the write, so
	 * two devices that decide at the same moment write the same attempt number.
	 * Returns the note as written, or `null` when nothing was asked.
	 */
	private async requestAgentIfDone(
		path: string,
		note: TranscriptNote,
		mode: RecordingModeKey,
		now: Date,
	): Promise<TranscriptNote | null> {
		const { vault } = this.ports;
		const settings = this.ports.settings();
		const entry = settings.agents[mode];
		if (entry.kind === "none" || !this.adapters.agents[entry.kind]) return null;
		const wanted = (candidate: TranscriptNote): boolean =>
			shouldRequestAgent(
				candidate,
				deriveState(candidate, now, settings.overdueHours),
				now,
				settings.overdueHours,
				entry.chosenAt,
			) && this.agentAskedFor.get(path) !== readString(candidate, "transcriber-at");
		if (!wanted(note)) return null;
		// The read and the write are one step under the note's guard, so the keep
		// time's deletion cannot land between them; a note that is busy is asked
		// about again at the next tick.
		const ran = await this.exclusively(path, async () => {
			const text = await vault.read(path);
			const fresh = text === null ? null : parseTranscriptNote(text);
			if (fresh === null || !wanted(fresh)) return null;
			// An ask that would be overdue the moment it is made (a transcript older than the
			// overdue time) is stamped with its own start; any other ask carries no stamp.
			const unstamped = markAgentRequested(fresh, { kind: entry.kind });
			const { clock } = this.ports;
			const stamped = deriveState(unstamped, now, settings.overdueHours).agentOverdue
				? markAgentRequested(fresh, { kind: entry.kind, raisedAt: formatTimestamp(now, clock.utcOffsetMinutes(now)) })
				: unstamped;
			const requested = markAgentFor(stamped);
			await vault.write(path, serializeTranscriptNote(requested));
			this.agentAskedFor.set(path, readString(fresh, "transcriber-at") ?? "");
			return requested;
		});
		return ran.ran ? ran.value : null;
	}

	/**
	 * Run `step` — a read of the note and the write that follows it — while this
	 * lifecycle's adapters and claim releases are kept off the note. A note they
	 * are working on is not waited for: `{ ran: false }` comes back at once and
	 * the caller tries again at its next tick. It says who holds the note:
	 * `holder: "work"` for the adapters' transcription or agent request, which
	 * is what a by-hand Cancel cancels, `"other"` for everything else that takes
	 * the guard (a by-hand action, a keep click, the agent request or the names
	 * the lifecycle writes, a removal, a claim release). The keep time's
	 * deletion goes through here, so it never writes a copy of the note an
	 * answer has since moved on from.
	 */
	async exclusively<T>(
		path: string,
		step: () => Promise<T>,
	): Promise<{ ran: true; value: T } | { ran: false; holder: "work" | "other" }> {
		const holder = this.dispatching.get(path);
		if (holder !== undefined) return { ran: false, holder: holder.work === true ? "work" : "other" };
		const mine = { at: this.ports.clock.now().getTime() };
		this.dispatching.set(path, mine);
		try {
			return { ran: true, value: await step() };
		} finally {
			if (this.dispatching.get(path) === mine) this.dispatching.delete(path);
		}
	}

	/**
	 * Run `run` the moment the note at `path` is free of this lifecycle's
	 * adapters, at once when it is. It runs where the note is let go, so a
	 * caller that takes `exclusively` first thing in it gets the note before any
	 * tick does; a `run` that finds the note taken again calls this again.
	 */
	whenFree(path: string, run: () => void): void {
		this.dispatching.whenFree(path, run);
	}

	/** Obsidian has left the screen: a send still pending when it returns may have been lost meanwhile. */
	leftTheScreen(): void {
		this.awayAt = this.ports.clock.now().getTime();
	}

	/**
	 * Obsidian has come back to the screen. A send this device started and has
	 * not heard an answer to may have been lost while the app was away (a phone
	 * suspends it): the device lets go of its own unanswered claim, removing its
	 * own transcriber lines and raising `attempt` by one. A note this device is
	 * working on right now is left alone, and so is every claim written in
	 * another device's name: no device releases another's claim.
	 */
	async returnedToScreen(now: Date): Promise<void> {
		const who = identityOf(this.ports.device);
		const awayAt = this.awayAt;
		this.awayAt = null;
		const lostWhileAway = (startedAt: number): boolean =>
			this.ports.device.isPhone() && awayAt !== null && startedAt <= awayAt;
		for (const path of await this.ports.vault.listTranscriptNotes()) {
			// The note is held as dispatching while it is read and written, so a
			// tick cannot claim it in between: a claim written after the read would
			// be let go of from a copy that does not show it.
			const running = this.dispatching.get(path);
			if (running !== undefined) {
				// On a phone the system suspends Obsidian, and a send begun before it
				// left the screen may never be answered although its promise is still
				// pending (it gives up only after 30 minutes). That one is let go of
				// too. A desktop does not suspend Obsidian, so a send under way there
				// is healthy and is left alone; so is one begun after the window came
				// back.
				if (!lostWhileAway(running.at)) continue;
				try {
					const text = await this.ports.vault.read(path);
					const note = text === null ? null : parseTranscriptNote(text);
					if (note !== null && holdsOwnClaim(note, who)) {
						await this.ports.vault.write(path, serializeTranscriptNote(letGoOfClaim(note)));
						await this.observe(path, now, false);
					}
				} catch (err) {
					console.error(`[vault-recorder] could not let go of the claim on '${path}':`, err);
				} finally {
					if (this.dispatching.get(path) === running) this.dispatching.delete(path);
				}
				continue;
			}
			const mine = { at: 0 };
			this.dispatching.set(path, mine);
			try {
				const text = await this.ports.vault.read(path);
				const note = text === null ? null : parseTranscriptNote(text);
				if (note === null || !holdsOwnClaim(note, who)) continue;
				await this.ports.vault.write(path, serializeTranscriptNote(letGoOfClaim(note)));
				await this.observe(path, now, false);
			} catch (err) {
				console.error(`[vault-recorder] could not let go of the claim on '${path}':`, err);
			} finally {
				if (this.dispatching.get(path) === mine) this.dispatching.delete(path);
			}
		}
	}

	private record(path: string, current: NoteStatus | undefined): void {
		const previous = this.statusByPath.get(path);
		if (JSON.stringify(previous) === JSON.stringify(current)) return;
		if (current) this.statusByPath.set(path, current);
		else this.statusByPath.delete(path);
		for (const listener of this.listeners) {
			try {
				listener({ path, previous, current });
			} catch (err) {
				console.error("[vault-recorder] a listener of note changes threw:", err);
			}
		}
	}

	/**
	 * Write the audio file. A file already there with the same size is the same
	 * recording saved by an earlier run of this stop, and is left alone; one
	 * with another size is a different file and throws.
	 */
	private async saveAudio(
		audioPath: string,
		audio: ArrayBuffer,
	): Promise<void> {
		const { vault } = this.ports;
		await ensureParentFolder(vault, audioPath);
		const existing = await vault.fileSize(audioPath);
		if (existing === audio.byteLength) return;
		await vault.createBinary(audioPath, audio);
	}

	/**
	 * Write the audio embed. In meeting mode, with `transcriptPath` set, the
	 * transcript note's link goes on the same line right after the embed, so a
	 * meeting note reaches its transcript without the plugin. Both are written
	 * here, once: in meeting mode a note that already holds the embed is left
	 * as it is (the check is below, before the insert). The daily log takes the
	 * line last in its notes section, creating the section when it is missing;
	 * a meeting note takes it there too when it has the notes heading and at the
	 * cursor when it has not; cursor mode always takes it at the cursor.
	 */
	private async insertLink(
		target: LinkTarget,
		filename: string,
		transcriptPath: string | undefined,
		mode: StoppedRecording["mode"],
	): Promise<string | null> {
		const { vault } = this.ports;
		if (target.kind === "daily-log") {
			const content = await vault.read(target.path);
			if (content === null) {
				return "The daily log could not be found at stop — the recording was saved but not linked";
			}
			const updated = insertRecordingLink(
				content,
				filename,
				this.ports.settings().notesHeading,
			);
			if (classifyInsertOutcome(content, updated) === "inserted") {
				await vault.write(target.path, updated);
			}
			return null;
		}

		const { snapshot } = target;
		const content = await vault.read(snapshot.filePath);
		if (content === null) {
			return "The file is gone — the recording was saved but not linked";
		}
		const embed = `![[${filename}]]`;
		if (transcriptPath !== undefined && content.includes(embed)) return null;
		const link =
			transcriptPath === undefined
				? embed
				: `${embed} [[${vault.linkText(transcriptPath, snapshot.filePath)}]]`;
		const { result, outcome } =
			mode === "meeting"
				? insertInMeetingNote(
						content,
						link,
						snapshot.line,
						snapshot.ch,
						this.ports.settings().notesHeading,
					)
				: insertAtSnapshot(content, link, snapshot.line, snapshot.ch);
		if (outcome === "already-present") return null;
		await vault.write(snapshot.filePath, result);
		return outcome === "fallback-append"
			? "The cursor position is no longer valid — the link was added at the end of the file"
			: null;
	}
}

function linkTargetPath(target: LinkTarget): string {
	return target.kind === "daily-log" ? target.path : target.snapshot.filePath;
}

// --- Adapters ------------------------------------------------------------------

/** What `tick` hands an adapter about a note its mode has chosen it for. */
export interface NoteTick<Entry> {
	path: string;
	note: TranscriptNote;
	state: DerivedState;
	mode: RecordingModeKey;
	/** The settings entry of the mode this note belongs to. */
	entry: Entry;
	now: Date;
}

/**
 * One kind of transcriber. An adapter is built with whatever ports it needs
 * (network, key store, model runner) and registered in the table below; the
 * lifecycle's own port type never grows for it.
 */
export interface TranscriberAdapter {
	readonly kind: TranscriberKind;
	/** Whether a recording stopped under this kind gets a transcript note asking for a transcript. */
	readonly requestsTranscriptNote: boolean;
	/**
	 * Why this device cannot take a waiting note forward, or `null`. Derived on
	 * the device that asks, never written into the note.
	 */
	waitingReason(
		note: TranscriptNote,
		entry: TranscriberEntry,
		device: DevicePort,
	): string | null;
	/** Called on every tick for each note whose mode has this kind. */
	tick?(item: NoteTick<TranscriberEntry>): Promise<void>;
}

/** One kind of agent; the same shape as a transcriber's adapter. */
export interface AgentAdapter {
	readonly kind: AgentKind;
	waitingReason(
		note: TranscriptNote,
		entry: AgentEntry,
		device: DevicePort,
	): string | null;
	tick?(item: NoteTick<AgentEntry>): Promise<void>;
}

export interface Adapters {
	transcribers: Partial<Record<TranscriberKind, TranscriberAdapter>>;
	agents: Partial<Record<AgentKind, AgentAdapter>>;
}

/** No transcriber: the plugin records and nothing else happens, as before. */
const NONE_TRANSCRIBER: TranscriberAdapter = {
	kind: "none",
	requestsTranscriptNote: false,
	waitingReason: () => null,
};

/** Hand-off: the plugin writes the request and watches the note; nothing else. */
const HAND_OFF_TRANSCRIBER: TranscriberAdapter = {
	kind: "hand-off",
	requestsTranscriptNote: true,
	waitingReason: () => null,
};

const NONE_AGENT: AgentAdapter = { kind: "none", waitingReason: () => null };

/**
 * The table of adapters by kind. `none` and `hand-off` are registered here;
 * `service` and `on-device` are registered in `adapter-table.ts`
 * (`pluginAdapters`), where the ports they need are at hand.
 */
export function defaultAdapters(): Adapters {
	return {
		transcribers: { none: NONE_TRANSCRIBER, "hand-off": HAND_OFF_TRANSCRIBER },
		agents: { none: NONE_AGENT, "hand-off": HAND_OFF_AGENT },
	};
}

/**
 * The mode's entry for the kind a note names: the settings' entry itself when
 * the note names none (written before the kind lines existed), the same entry under the note's
 * kind when it names another, and `undefined` when it names a word no kind
 * has, which nothing here takes. Every kind keeps its own fields in one
 * entry, so the entry carries what that kind needs.
 */
function entryForKind<K extends string, E extends { kind: K }>(entry: E, named: K | null | undefined): E | undefined {
	if (named === undefined) return entry;
	if (named === null) return undefined;
	return named === entry.kind ? entry : { ...entry, kind: named };
}

/** The mode a note was recorded in, as the settings key it; `undefined` for a mode word it does not know. */
function modeKeyOf(note: TranscriptNote): RecordingModeKey | undefined {
	const word = readString(note, "mode");
	return RECORDING_MODE_KEYS.find((key) => MODE_WORDS[key] === word);
}

/** `Recording 20261019093539.m4a` becomes `Recording 20261019093539.md`, in the transcript folder. */
function transcriptNotePath(
	settings: VaultRecorderSettings,
	audioPath: string,
): string {
	const slash = audioPath.lastIndexOf("/");
	const audioFolder = slash === -1 ? "" : audioPath.slice(0, slash);
	const name = audioPath.slice(slash + 1).replace(/\.[^.]+$/, "") + ".md";
	const configured = normalizeFolder(settings.transcriptFolder.trim());
	const folder = configured === "" ? audioFolder : configured;
	return folder === "" ? name : `${folder}/${name}`;
}

// --- Where the audio goes ------------------------------------------------------

/**
 * Decide where a new recording's audio file goes: the full vault path, its
 * folder already created. A typed audio folder wins; an empty one asks
 * Obsidian where it would save an attachment to `linkingNotePath`
 * (`decideAudioPath`, #11).
 *
 * Obsidian answers with a ` 1` suffix when the name is taken, so a second run
 * of the same stop would save the recording twice. When the unsuffixed name
 * beside the answer already holds a file of `audioBytes`, that file is this
 * recording and its path is returned instead.
 */
export async function resolveAudioPath(
	ports: Pick<LifecyclePorts, "vault" | "settings">,
	filename: string,
	linkingNotePath: string,
	audioBytes: number,
): Promise<string> {
	const { vault } = ports;
	const path = await decideAudioPath({
		filename,
		sourceNotePath: linkingNotePath,
		audioFolder: ports.settings().audioFolder,
		getAvailablePathForAttachment: (name, source) =>
			vault.availablePathForAttachment(name, source),
		ensureFolder: (folder) => vault.createFolder(folder),
	});
	const slash = path.lastIndexOf("/");
	const unsuffixed = slash < 0 ? filename : `${path.slice(0, slash)}/${filename}`;
	if (unsuffixed !== path && (await vault.fileSize(unsuffixed)) === audioBytes) {
		return unsuffixed;
	}
	return path;
}

export function normalizeFolder(folder: string): string {
	return folder.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Create the folder a file will go in, when it is not the top of the vault. */
async function ensureParentFolder(
	vault: VaultPort,
	path: string,
): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	await vault.createFolder(path.slice(0, slash));
}
