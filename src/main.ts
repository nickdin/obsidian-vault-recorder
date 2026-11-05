import {
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TFile,
	type Editor,
	type Menu,
	type MarkdownFileInfo,
} from "obsidian";

import type { RecordingModeKey, VaultRecorderSettings } from "./settings-data";
import { VaultRecorderSettingTab } from "./settings";
import {
	SystemAudioUnavailableError,
	detectCodec,
	getPeakLevel,
	mapLevelToDisplay,
	readLevel,
	startMeetingRecording,
	startRecording,
	stopRecording,
	type RecordingSession,
} from "./recorder";
import {
	snapshotCursor,
	type ActiveEditorAdapter,
	type CursorSnapshot,
} from "./cursor-snapshot";
import {
	dailyLogConfigFor,
	readDailyNotesOptions,
	resolveDailyLog,
	type DailyNotesOptions,
	type InternalPluginsPort,
} from "./daily-log";
import {
	LEGACY_SETTING_KEYS,
	mergeSavedSettings,
} from "./settings-migration";
import {
	OLD_PLUGIN_ID,
	loadSavedSettings,
	oldSettingsPath,
} from "./settings-carry-over";
import { generateFilename } from "./filename";
import { WakeLockManager } from "./wake-lock";
import { Lifecycle, type LinkTarget } from "./lifecycle";
import { pluginAdapters } from "./adapter-table";
import { releaseLostSends } from "./screen-return";
import type { ModelStore } from "./model-store";
import { createModelStore } from "./settings-models";
import { createObsidianModelRunner } from "./model-runner-obsidian";
import { createServiceAdapterPorts, createVaultNoteReader } from "./service-ports";
import { registerNoteDrawing, type NoteDrawing } from "./note-drawing";
import { isAudioPath } from "./audio-file";
import { RecordingActions, type ActionResult } from "./lifecycle-actions";
import { RecordingPlayer } from "./audio-player";
import { pickSpeaker } from "./speaker-picker";
import { registerTurnClicks, type TurnHandlers } from "./turn-clicks";
import { displayOf, speakerChoices } from "./naming";
import { formatTimestamp, parseTranscriptNote } from "./transcript-note";
import { confirmInModal } from "./confirm-modal";
import {
	KeepActions,
	KeepTime,
	keepTimeNeedsQuestion,
	keepTimeQuestion,
	type KeepAction,
} from "./keep-time";
import {
	Removal,
	linkHomeOf,
	removalEntries,
	smallestEdit,
	type RemovalAction,
	type RemovalEntry,
} from "./removal";
import { QUEUE_VIEW_TYPE, QueuePanelView, openQueuePanel } from "./queue-panel";
import type { RecordingAction } from "./state-line";
import { frontmatterText } from "./frontmatter-text";
import {
	createClockPort,
	createDevicePort,
	createNotePropertiesPort,
	createVaultPort,
} from "./obsidian-ports";

type Owner = "daily" | "cursor" | "meeting";

/** The recording mode the settings key each owner's transcriber and agent under. */
const MODE_KEY_OF_OWNER: Record<Owner, RecordingModeKey> = {
	daily: "dailyLog",
	cursor: "cursor",
	meeting: "meeting",
};

/**
 * The recording in progress. One at a time, globally, across all three modes.
 * `owner` decides which ribbon icon carries the in-progress marker and which
 * toggle stops it. `dailyLogPath` and `cursorSnapshot` are set at start
 * depending on the owner, so the destination is fixed from start to stop.
 */
interface ActiveCapture {
	owner: Owner;
	session: RecordingSession;
	startedAt: Date;
	filename: string;
	dailyLogPath?: string;
	cursorSnapshot?: CursorSnapshot;
	startRibbonEl: HTMLElement;
	rafHandle: number;
	lastLevelUpdate: number;
	lastLevelText: string;
}

/** How often the lifecycle looks at every transcript note (waiting, overdue, claims). */
const LIFECYCLE_TICK_INTERVAL_MS = 30_000;

/** Shortest gap between two RAF-driven CSS updates (~20 Hz). */
const LEVEL_UPDATE_INTERVAL_MS = 50;

interface AppWithInternalPlugins {
	internalPlugins?: InternalPluginsPort;
}

export default class VaultRecorderPlugin extends Plugin {
	settings!: VaultRecorderSettings;

	private dailyRibbonEl!: HTMLElement;
	private cursorRibbonEl!: HTMLElement;
	private meetingRibbonEl!: HTMLElement;
	private levelRibbonEl!: HTMLElement;
	private activeCapture: ActiveCapture | null = null;
	private isStarting = false;
	private wakeLock!: WakeLockManager;
	private lifecycle!: Lifecycle;
	private actions!: RecordingActions;
	private keepTime!: KeepTime;
	private keepActions!: KeepActions;
	private removal!: Removal;
	/** Notes whose audio could not be deleted and that the user has been told about this session. */
	private readonly keepFailureShown = new Set<string>();
	private drawing!: NoteDrawing;
	/** Plays a recording from a turn's time; read by the drive for its position. */
	player!: RecordingPlayer;
	/** The speech models on this device; the settings page draws them. */
	models!: ModelStore;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Everything that happens to a recording once it stops lives in the
		// lifecycle; it reaches the vault only through these ports.
		const lifecyclePorts = {
			vault: createVaultPort(this.app),
			clock: createClockPort(),
			device: createDevicePort(this.app),
			noteProperties: createNotePropertiesPort(this.app),
			settings: () => this.settings,
		};
		this.models = createModelStore(this.app, lifecyclePorts.vault, () => this.settings.modelFolder);
		void this.models.refreshAll();
		// Each transcriber kind is an adapter built with its own ports: the
		// service on Obsidian's network call and Keychain, on-device on the
		// model folder.
		this.lifecycle = new Lifecycle(
			lifecyclePorts,
			pluginAdapters(
				createServiceAdapterPorts(this.app, lifecyclePorts),
				this.models,
				createObsidianModelRunner(this.app, {
					folderOf: (model) => this.models.folderOf(model),
					onRan: (model, ran) =>
						console.debug(`[vault-recorder] on-device run with ${model.id}`, ran),
				}),
				createVaultNoteReader(this.app),
			),
		);

		// What the lifecycle knows is drawn in the notes themselves: under a
		// recording's embed, and at the top of a transcript note.
		const clock = createClockPort();
		// Cancel, try again and transcribe by hand: the commands below and the
		// buttons on the drawn state line both go through these.
		this.actions = new RecordingActions({
			vault: lifecyclePorts.vault,
			clock,
			settings: () => this.settings,
			exclusively: (path, step) => this.lifecycle.exclusively(path, step),
			noteProperties: lifecyclePorts.noteProperties,
			notesEmbedding: (audioPath) =>
				Object.entries(this.app.metadataCache.resolvedLinks)
					.filter(([, targets]) => (targets[audioPath] ?? 0) > 0)
					.map(([source]) => source),
			dailyNotes: () => this.readDailyNotesOptions(),
			confirm: (question) => confirmInModal(this.app, question),
			// Redraw the note at once; its transcription starts on the next tick,
			// started here but not waited for, so the action's notice comes first.
			refresh: async (notePath) => {
				await this.lifecycle.look(notePath, new Date());
				void this.lifecycle.tick(new Date());
			},
		});
		// The keep time: audio is deleted on the lifecycle's tick (below), and
		// "Keep audio" / "Delete audio" on one recording go through these.
		const resolveFile = (target: string, fromPath: string): string | null =>
			this.app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? null;
		this.keepTime = new KeepTime({
			vault: lifecyclePorts.vault,
			clock,
			device: lifecyclePorts.device,
			settings: () => this.settings,
			resolveFile,
			exclusively: (path, step) => this.lifecycle.exclusively(path, step),
		});
		this.keepActions = new KeepActions({
			vault: lifecyclePorts.vault,
			clock,
			settings: () => this.settings,
			resolveFile,
			exclusively: (path, step) => this.lifecycle.exclusively(path, step),
			whenFree: (path, run) => this.lifecycle.whenFree(path, run),
			tell: (message) => void new Notice(message),
			confirm: (question) => confirmInModal(this.app, question),
			refresh: async (notePath) => {
				await this.lifecycle.look(notePath, new Date());
			},
			notesLinkingTo: (audioPath, exceptPath) =>
				Object.entries(this.app.metadataCache.resolvedLinks)
					.filter(([source, targets]) => source !== exceptPath && audioPath in targets)
					.map(([source]) => source),
		});
		// Removing a recording: the four entries on the note's menu, the queue
		// panel's row and the top of the transcript note all end up in `removal`.
		const notesLinking = (path: string, exceptPath: string | null): string[] => {
			const name = path.slice(path.lastIndexOf("/") + 1);
			const found = new Set<string>();
			const { resolvedLinks, unresolvedLinks } = this.app.metadataCache;
			for (const [source, targets] of Object.entries(resolvedLinks)) {
				if (source !== exceptPath && path in targets) found.add(source);
			}
			// A deleted recording's embed no longer resolves, but still names the file.
			for (const [source, targets] of Object.entries(unresolvedLinks)) {
				if (source !== exceptPath && (path in targets || name in targets)) found.add(source);
			}
			return [...found].sort();
		};
		this.notesLinkingTo = notesLinking;
		const keepWithoutQuestion = new KeepActions({
			vault: lifecyclePorts.vault,
			clock,
			settings: () => this.settings,
			resolveFile,
			exclusively: (path, step) => this.lifecycle.exclusively(path, step),
			whenFree: (path, run) => this.lifecycle.whenFree(path, run),
			tell: (message) => void new Notice(message),
			// Removal asks its question before it gets here, for every entry that deletes the audio.
			confirm: async () => true,
			refresh: async (notePath) => {
				await this.lifecycle.look(notePath, new Date());
			},
			notesLinkingTo: notesLinking,
		});
		this.removal = new Removal({
			vault: lifecyclePorts.vault,
			clock,
			settings: () => this.settings,
			resolveFile,
			confirm: (question) => confirmInModal(this.app, question),
			notesLinking,
			editNote: (path, change) => this.editNote(path, change),
			openInEditor: (path) => this.editorOf(path) !== null,
			// Removal holds the note's guard for the whole removal, and the guard cannot be taken
			// twice: `cancel` would find the note held by Removal (not the work it cancels) and
			// refuse, so Removal gets `cancelHoldingGuard`, the variant that does not take it.
			cancel: (notePath) => this.actions.cancelHoldingGuard(notePath),
			deleteAudioKeepNote: (notePath) => keepWithoutQuestion.deleteAudio(notePath),
			exclusively: (path, step) => this.lifecycle.exclusively(path, step),
			refresh: async (notePath) => {
				await this.lifecycle.look(notePath, new Date());
			},
		});
		// A click on a turn: its time plays the recording from there, its speaker
		// label opens the naming list. The same two handlers serve the transcript
		// note (Live Preview and reading view); the text drawn in place is rendered
		// through Obsidian, so reading view's post-processor wires it too.
		this.player = new RecordingPlayer(this.app);
		const turns: TurnHandlers = {
			pick: (notePath, label) => void this.nameSpeaker(notePath, label),
			play: (notePath, seconds) => void this.playFrom(notePath, seconds),
		};
		registerTurnClicks({ app: this.app, plugin: this, handlers: turns });
		this.drawing = registerNoteDrawing({
			app: this.app,
			plugin: this,
			lifecycle: this.lifecycle,
			clock,
			settings: () => this.settings,
			runAction: (action, notePath) => void this.runAction(action, notePath),
			removalEntries: (notePath) => this.removalEntriesOf(notePath),
			runRemoval: (action, notePath) => void this.runRemoval(action, notePath, null, null),
		});

		// The queue panel: every transcript note by group, opened from a ribbon
		// icon and a command, redrawn when a transcript note changes.
		this.registerView(
			QUEUE_VIEW_TYPE,
			(leaf) =>
				new QueuePanelView(leaf, {
					lifecycle: this.lifecycle,
					clock,
					settings: () => this.settings,
					runAction: (action, notePath) => void this.runAction(action, notePath),
					removalEntries: (notePath) => this.removalEntriesOf(notePath),
					runRemoval: (action, notePath) => void this.runRemoval(action, notePath, null, null),
				}),
		);
		// The editor's menu does not say what was clicked, and a right-click on
		// an audio embed does not move the cursor onto it: remember the target.
		this.registerDomEvent(
			document,
			"contextmenu",
			(event) => {
				this.lastContextTarget = event.target instanceof Element ? event.target : null;
			},
			true,
		);
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => this.addRemovalToEditorMenu(menu, editor, info)),
		);
		this.addRibbonIcon("list-music", "Open the transcription queue", () => {
			void openQueuePanel(this.app);
		});
		this.addCommand({
			id: "open-transcription-queue",
			name: "Open the transcription queue",
			callback: () => {
				void openQueuePanel(this.app);
			},
		});

		// A device lets go of its own unanswered sends (spec § 5) when Obsidian
		// starts and each time it is shown again: a phone may have suspended it
		// mid-send or killed it. The handler runs on every platform, desktop
		// included. A send still pending is let go of only on a phone, and only if
		// it began before the window was hidden. It is registered before the
		// first tick, so a stale claim is let go of first.
		releaseLostSends(
			this.lifecycle,
			{
				isHidden: () => document.hidden,
				onVisibilityChange: (callback) =>
					this.registerDomEvent(document, "visibilitychange", callback),
				whenReady: (callback) => this.app.workspace.onLayoutReady(callback),
			},
			() => new Date(),
		);

		// The lifecycle watches transcript notes on an interval. Obsidian's
		// metadata cache is empty until the layout is ready, so the first look
		// waits for that too.
		const tick = (): void =>
			void (async () => {
				const now = new Date();
				await this.lifecycle.tick(now);
				await this.deleteExpiredAudio(now);
			})();
		this.registerInterval(window.setInterval(tick, LIFECYCLE_TICK_INTERVAL_MS));
		this.app.workspace.onLayoutReady(tick);

		// The wake-lock manager reads keepAwake live from settings on every
		// acquire. It is constructed after loadSettings so the toggle always
		// exists by the time the first recording starts.
		this.wakeLock = new WakeLockManager(() => this.settings.keepAwake, {
			isDesktop: () => Platform.isDesktopApp,
			isMobile: () => Platform.isMobileApp,
		});

		// The codec is chosen once, at load. If no codec is supported that is a
		// hard failure — show a notice, but let the plugin load anyway so the
		// settings tab can still be reached.
		try {
			const codec = detectCodec();
			this.settings.codecMimeType = codec.mimeType;
			this.settings.codecExtension = codec.extension;
			await this.saveSettings();
		} catch (err) {
			new Notice(
				`Could not detect an audio codec: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Ribbons: quick capture into the daily log, recording at the cursor,
		// and the level meter.
		this.dailyRibbonEl = this.addRibbonIcon(
			"microphone",
			"Record a thought into the daily log",
			() => {
				void this.toggleDaily();
			},
		);
		this.cursorRibbonEl = this.addRibbonIcon(
			"file-audio",
			"Record at the cursor in the active note",
			() => {
				void this.toggleCursor();
			},
		);
		this.levelRibbonEl = this.addRibbonIcon(
			"activity",
			"Level meter",
			() => {
				/* the level meter is passive; clicking it does nothing */
			},
		);
		this.levelRibbonEl.addClass("vault-recorder-level-ribbon");
		// Hidden by default through a CSS class rather than an inline display
		// property — the class survives Obsidian's layout re-rendering better,
		// and it is the signal that actually holds at onload.
		this.levelRibbonEl.addClass("vault-recorder-level-hidden");

		// Meeting ribbon and command — desktop only. System-audio loopback goes
		// through Electron's `chromeMediaSource:'desktop'` constraint, which
		// does not exist in Obsidian's mobile WebView. Never registered on
		// mobile, so no dead ribbon or command appears there.
		if (Platform.isDesktopApp) {
			this.meetingRibbonEl = this.addRibbonIcon(
				"monitor-play",
				"Record a meeting with system audio",
				() => {
					void this.toggleMeeting();
				},
			);

			this.addCommand({
				id: "start-meeting-capture",
				name: "Record a meeting with system audio",
				callback: () => {
					void this.toggleMeeting();
				},
			});
		}

		// Commands for the two microphone modes. No default hotkey — that is
		// the Obsidian convention.
		this.addCommand({
			id: "start-daily-capture",
			name: "Record a thought into the daily log",
			callback: () => {
				void this.toggleDaily();
			},
		});
		this.addCommand({
			id: "start-cursor-capture",
			name: "Record at the cursor in the active note",
			callback: () => {
				void this.toggleCursor();
			},
		});

		this.addActionCommands();

		this.addSettingTab(new VaultRecorderSettingTab(this.app, this));
	}

	/**
	 * Delete the audio whose keep time has passed. A failure is logged each
	 * time and shown once per note per session: the tick would otherwise repeat
	 * the same notice every thirty seconds.
	 */
	private async deleteExpiredAudio(now: Date): Promise<void> {
		try {
			const result = await this.keepTime.tick(now);
			for (const failure of result.failed) {
				console.error(`[vault-recorder] audio not deleted for '${failure.path}': ${failure.message}`);
				if (this.keepFailureShown.has(failure.path)) continue;
				this.keepFailureShown.add(failure.path);
				new Notice(`Could not delete the audio of ${failure.path}: ${failure.message}`);
			}
		} catch (err) {
			console.error("[vault-recorder] the keep time check failed:", err);
		}
	}

	/**
	 * Settings asks before a keep time that is turned on or shortened takes
	 * effect, naming how many recordings lose their audio now. `true` means go
	 * ahead; a no leaves the setting as it was.
	 */
	async confirmKeepTime(before: number | null, after: number | null): Promise<boolean> {
		if (after === null || !keepTimeNeedsQuestion(before, after)) return true;
		const count = await this.keepTime.countLosingAudioNow(after, new Date());
		if (count === 0) return true;
		return confirmInModal(this.app, keepTimeQuestion(after, count));
	}

	private lastContextTarget: Element | null = null;
	private notesLinkingTo!: (path: string, exceptPath: string | null) => string[];

	/**
	 * Change a note's text the way an edit would. A note open in an editor is
	 * changed through that editor, in one small replacement, so Ctrl+Z undoes
	 * just that; any other note is rewritten in the vault.
	 */
	private async editNote(path: string, change: (text: string) => string): Promise<boolean> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return false;
		const view = this.editorOf(path);
		if (view !== null) {
			const before = view.editor.getValue();
			const after = change(before);
			if (after === before) return true;
			const edit = smallestEdit(before, after);
			view.editor.replaceRange(edit.insert, view.editor.offsetToPos(edit.from), view.editor.offsetToPos(edit.to));
			return true;
		}
		await this.app.vault.process(file, change);
		return true;
	}

	/** The editor the note at `path` is open in, or `null` when no tab holds it. */
	private editorOf(path: string): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return view;
		}
		return null;
	}

	/**
	 * The four removal entries for a recording, worked out from the metadata
	 * cache so a menu can show them the moment it opens. `transcriptPath` is
	 * the recording's transcript note (`null` for none), `audioPath` its audio
	 * when the entrance knows it, `fromNote` the note whose menu it is.
	 */
	private removalEntriesFor(transcriptPath: string | null, audioPath: string | null, fromNote: string | null): RemovalEntry[] {
		const front = transcriptPath === null ? undefined : this.app.metadataCache.getCache(transcriptPath)?.frontmatter;
		const link: unknown = front?.audio;
		const named = typeof link === "string" ? link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0] : null;
		const deleted: unknown = front?.["audio-deleted"];
		const audioDeleted = deleted === undefined ? null : frontmatterText(deleted);
		const audio =
			audioDeleted !== null
				? null
				: audioPath ?? (named !== null && transcriptPath !== null ? this.app.metadataCache.getFirstLinkpathDest(named, transcriptPath)?.path ?? null : null);
		const name = named ?? audioPath ?? "";
		const linkers = this.notesLinkingTo(audio ?? name, null);
		return removalEntries(
			{ audioPath: audio, audioName: name.slice(name.lastIndexOf("/") + 1), transcriptPath, fromNote, audioDeleted },
			linkHomeOf(fromNote, transcriptPath, linkers),
		);
	}

	/** The entries for a transcript note, as its queue row and its top line show them. */
	private removalEntriesOf(notePath: string): RemovalEntry[] {
		return this.removalEntriesFor(notePath, null, null);
	}

	/** Run one removal entry and say what it did. */
	private async runRemoval(
		action: RemovalAction,
		transcriptPath: string | null,
		audioPath: string | null,
		fromNote: string | null,
	): Promise<void> {
		try {
			new Notice((await this.removal.run(action, transcriptPath, audioPath, fromNote)).message);
		} catch (err) {
			new Notice(`Could not remove: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * The editor's right-click menu: when the click lands on a line holding an
	 * audio embed, offer the four entries for that recording. The embed is the
	 * one that was clicked (its drawn box), else the one on the cursor's line.
	 */
	private addRemovalToEditorMenu(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		const file = info.file;
		if (!file) return;
		const clicked = this.lastContextTarget?.closest(".internal-embed")?.getAttribute("src") ?? null;
		this.lastContextTarget = null;
		const line = editor.getLine(editor.getCursor().line);
		const onLine = /!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(line);
		const linkpath = clicked !== null ? clicked.split("#")[0] : onLine ? onLine[1] : null;
		if (linkpath === null) return;
		const audio = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
		// A deleted recording's embed resolves to nothing; its transcript note names it.
		const request = { kind: "embed", linkpath, sourcePath: file.path } as const;
		const note = this.drawing.transcriptFor(request);
		if (!(audio && isAudioPath(audio.path)) && !note) return;
		const entries = this.removalEntriesFor(note?.path ?? null, audio?.path ?? null, file.path);
		menu.addSeparator();
		for (const entry of entries) {
			menu.addItem((item) =>
				item
					.setTitle(entry.greyedBecause === null ? entry.label : `${entry.label} (${entry.greyedBecause})`)
					.setIcon(entry.action === "remove-link" ? "unlink" : "trash-2")
					.setDisabled(entry.greyedBecause !== null)
					.onClick(() => void this.runRemoval(entry.action, note?.path ?? null, audio?.path ?? null, file.path)),
			);
		}
	}

	/** Run one action on a transcript note and say what it did. */
	private async runAction(action: RecordingAction | KeepAction, notePath: string): Promise<void> {
		try {
			if (action === "delete-audio") {
				// One route for "Delete audio", whichever button it is: removal's question, guard and cancel.
				await this.runRemoval("delete-audio", notePath, null, null);
				return;
			}
			if (action === "keep-audio" || action === "release-audio") {
				new Notice((await this.keepActions.setKeepAudio(notePath, action === "keep-audio")).message);
				return;
			}
			if (action === "name-speakers") {
				const first = await this.actions.firstUnnamed(notePath);
				if ("notice" in first) new Notice(first.notice);
				else await this.nameSpeaker(notePath, first.label);
				return;
			}
			const result: ActionResult =
				action === "cancel"
					? await this.actions.cancel(notePath)
					: action === "run-agent"
						? await this.actions.runAgentAgain(notePath)
					: action === "cancel-agent"
						? await this.actions.cancelAgent(notePath)
					: action === "try-again"
						? await this.actions.tryAgain(notePath)
						: action === "leave-unnamed"
							? await this.actions.leaveUnnamed(notePath)
							: await this.actions.requestAgain(notePath);
			new Notice(result.message);
		} catch (err) {
			new Notice(`Could not ${action.replace("-", " ")}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Open the naming list for `label` in the transcript note at `notePath` and
	 * write the choice throughout the note. The note is read for the list and
	 * read again when the choice is written, so a correction made while the list
	 * was open is kept.
	 */
	private async nameSpeaker(notePath: string, label: string): Promise<void> {
		try {
			const waiting = await this.actions.whyNotNaming(notePath);
			if (waiting !== null) {
				new Notice(waiting);
				return;
			}
			const file = this.app.vault.getFileByPath(notePath);
			const note = file ? parseTranscriptNote(await this.app.vault.read(file)) : null;
			if (note === null) {
				new Notice("This note is not a transcript note this plugin wrote");
				return;
			}
			const written = await pickSpeaker(this.app, {
				label: displayOf(label),
				choices: speakerChoices(note, label),
			});
			if (written === null) return;
			new Notice((await this.actions.nameSpeaker(notePath, label, written)).message);
		} catch (err) {
			new Notice(`Could not name the speaker: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Play a transcript note's recording from `seconds`, and say why when it cannot. */
	private async playFrom(notePath: string, seconds: number): Promise<void> {
		try {
			const result = await this.player.playFrom(notePath, seconds);
			if (result.problem !== null) new Notice(result.problem);
		} catch (err) {
			new Notice(`Could not play the recording: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * The recording the user means: the active file when it is a transcript
	 * note, otherwise the audio embed on the cursor's line. `null` when neither.
	 */
	private recordingInFocus(): { notePath: string | null; audioPath: string | null; sourcePath: string } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		if (this.lifecycle.statusOf(file.path)) {
			return { notePath: file.path, audioPath: null, sourcePath: file.path };
		}
		const editor = this.app.workspace.activeEditor?.editor;
		const line = editor ? editor.getLine(editor.getCursor().line) : "";
		const embed = /!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(line);
		if (embed) {
			const audio = this.app.metadataCache.getFirstLinkpathDest(embed[1], file.path);
			if (audio && isAudioPath(audio.path)) {
				const request = { kind: "embed", linkpath: embed[1], sourcePath: file.path } as const;
				const note = this.drawing.transcriptFor(request);
				return { notePath: note?.path ?? null, audioPath: audio.path, sourcePath: file.path };
			}
		}
		if (isAudioPath(file.path)) return { notePath: null, audioPath: file.path, sourcePath: file.path };
		return null;
	}

	private addActionCommands(): void {
		const forNote = (id: string, name: string, action: RecordingAction): void => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const target = this.recordingInFocus();
					if (!target?.notePath) return false;
					if (!checking) void this.runAction(action, target.notePath);
					return true;
				},
			});
		};
		forNote("cancel-transcription", "Cancel this recording's transcription", "cancel");
		forNote("try-transcription-again", "Try this recording's transcription again", "try-again");
		forNote("cancel-agent", "Cancel this recording's agent", "cancel-agent");
		forNote("run-agent-again", "Run this recording's agent again", "run-agent");
		this.addCommand({
			id: "transcribe-recording",
			name: "Transcribe this recording",
			checkCallback: (checking) => {
				const target = this.recordingInFocus();
				if (!target) return false;
				if (!target.notePath && !target.audioPath) return false;
				if (checking) return true;
				void (async () => {
					try {
						const result = target.notePath
							? await this.actions.requestAgain(target.notePath)
							: await this.actions.transcribe(target.audioPath!, {
									linkedFrom: target.sourcePath === target.audioPath ? undefined : target.sourcePath,
								});
						new Notice(result.message);
					} catch (err) {
						new Notice(`Could not transcribe: ${err instanceof Error ? err.message : String(err)}`);
					}
				})();
				return true;
			},
		});
	}

	// Obsidian calls onunload without waiting for it, so the async part runs
	// on its own; it runs synchronously up to its first await, as before.
	onunload(): void {
		void this.releaseOnUnload();
	}

	private async releaseOnUnload(): Promise<void> {
		this.player?.dispose();
		// Accept-loss: abandon any recording in progress silently. No disk
		// write, no recovery, no notice.
		if (this.activeCapture) {
			try {
				window.cancelAnimationFrame(this.activeCapture.rafHandle);
			} catch {
				/* noop */
			}
			try {
				await stopRecording(this.activeCapture.session);
			} catch {
				/* noop — the tracks may already be closed */
			}
			this.activeCapture = null;
		}
		// Best-effort wake-lock release at unload. Not awaited: onunload should
		// not block, and if wakeLock never got constructed (load failed early)
		// it is undefined.
		if (this.wakeLock) {
			void this.wakeLock.release();
		}
	}

	/**
	 * Read saved settings, carrying the pre-rename keys across on the way.
	 *
	 * Two steps, each tested without Obsidian: `loadSavedSettings` chooses the
	 * plugin's own file or, on first load, the old plugin id's; `mergeSavedSettings`
	 * renames the Swedish keys and applies the upgrade rules. This method is the
	 * I/O around them and the announcement — they say what they moved from here
	 * rather than from inside, so they stay silent under test.
	 *
	 * Settings carried from the old plugin id are saved at once. From then on the
	 * plugin has a file of its own, which wins, and the old folder is never
	 * touched.
	 */
	async loadSettings(): Promise<void> {
		const saved = await loadSavedSettings(
			await this.loadData(),
			this.app.vault.configDir,
			this.app.vault.adapter,
		);
		const loadedAt = new Date();
		const { settings, migrated, upgraded, stamped } = mergeSavedSettings(
			saved.raw,
			formatTimestamp(loadedAt, -loadedAt.getTimezoneOffset()),
		);

		// What the upgrade carried or filled in is a record for someone looking
		// into a settings question, not news: at debug level it stays out of
		// the console's default view, which Obsidian's guidelines ask for.
		if (saved.source === "old-plugin") {
			console.debug(
				`[vault-recorder] settings migration: carried the settings of ` +
					`'${OLD_PLUGIN_ID}' across (${oldSettingsPath(this.app.vault.configDir)}, left in place).`,
			);
		}
		if (migrated.length > 0) {
			console.debug(
				`[vault-recorder] settings migration: carried ${migrated.join(", ")} ` +
					`across from the pre-rename key names (${LEGACY_SETTING_KEYS.join(", ")}).`,
			);
		}
		if (upgraded.length > 0) {
			console.debug(
				`[vault-recorder] settings migration: filled in ${upgraded.join(", ")} ` +
					`for a settings file written before these settings existed.`,
			);
		}

		this.settings = settings;
		// A stamped moment is lost on a restart unless it is saved now.
		if (saved.source === "old-plugin" || stamped.length > 0) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- Toggle handlers -----------------------------------------------------

	private async toggleDaily(): Promise<void> {
		if (this.activeCapture?.owner === "daily") {
			await this.stopCapture();
			return;
		}
		await this.startDailyIfIdle();
	}

	/**
	 * Start a daily-log recording if nothing is recording or starting. Called
	 * from `toggleDaily`, which the ribbon and the command share.
	 */
	private async startDailyIfIdle(): Promise<void> {
		if (this.activeCapture || this.isStarting) {
			new Notice("A recording is already in progress");
			return;
		}
		this.isStarting = true;
		try {
			await this.startCapture("daily");
		} finally {
			this.isStarting = false;
		}
	}

	private async toggleCursor(): Promise<void> {
		if (this.activeCapture?.owner === "cursor") {
			await this.stopCapture();
			return;
		}
		if (this.activeCapture || this.isStarting) {
			new Notice("A recording is already in progress");
			return;
		}
		this.isStarting = true;
		try {
			await this.startCapture("cursor");
		} finally {
			this.isStarting = false;
		}
	}

	/**
	 * Toggle the meeting mode (desktop only). Shares the `activeCapture`
	 * singleton and the race guard with the other modes — one recording
	 * globally at a time. Mirrors `toggleCursor`'s structure exactly.
	 */
	private async toggleMeeting(): Promise<void> {
		if (this.activeCapture?.owner === "meeting") {
			await this.stopCapture();
			return;
		}
		if (this.activeCapture || this.isStarting) {
			new Notice("A recording is already in progress");
			return;
		}
		this.isStarting = true;
		try {
			await this.startCapture("meeting");
		} finally {
			this.isStarting = false;
		}
	}

	// --- Start and stop ------------------------------------------------------

	private async startCapture(owner: Owner): Promise<void> {
		const now = new Date();
		const filename = generateFilename(now, this.settings.codecExtension);

		// 1) Resolve the destination and validate it before opening the
		//    microphone, so the microphone is never held for nothing.
		let dailyLogPath: string | undefined;
		let cursorSnapshot: CursorSnapshot | undefined;

		if (owner === "daily") {
			dailyLogPath = resolveDailyLog(
				now,
				dailyLogConfigFor(this.settings, this.readDailyNotesOptions()),
			);
			const file = this.app.vault.getAbstractFileByPath(dailyLogPath);
			if (!(file instanceof TFile)) {
				new Notice("Today's daily log is missing — create it first");
				return;
			}
		} else {
			// The cursor and meeting modes both insert their link at the cursor
			// position. The snapshot is taken at start rather than at stop, so
			// the link lands where the user was when they pressed the button,
			// wherever the cursor moves afterwards.
			const adapter = this.createActiveEditorAdapter();
			const snapshot = snapshotCursor(adapter);
			if (!snapshot) {
				new Notice("No active note — open a file first");
				return;
			}
			cursorSnapshot = snapshot;
		}

		// 2) Start the MediaRecorder. The meeting mode calls
		//    startMeetingRecording, which mixes microphone and system audio;
		//    the other modes call startRecording (microphone only).
		//    SystemAudioUnavailableError is caught separately: it means the
		//    system-audio loopback was blocked by the OS or by policy, so the
		//    audio track was missing. It returns without setting activeCapture
		//    — no file, no wake lock.
		let session: RecordingSession;
		try {
			session = await (owner === "meeting"
				? startMeetingRecording(
						this.settings.codecMimeType,
						() => void this.handleSystemAudioEnded(),
					)
				: startRecording(this.settings.codecMimeType));
		} catch (err) {
			if (err instanceof SystemAudioUnavailableError) {
				new Notice(
					'System audio could not be captured — use "Record at the cursor in the active note" instead.',
				);
				return;
			}
			new Notice(
				`Could not start the recording: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// 2b) Take the wake lock. A failure here is swallowed and shown as a
		//     notice — the recording carries on regardless.
		try {
			await this.wakeLock.acquire();
		} catch (err) {
			console.warn("Wake-lock acquire failed:", err);
			new Notice(
				"Could not keep the screen awake — it may go dark during the recording",
			);
		}

		// 3) Update the ribbon state. The meeting ribbon pulses exactly like
		//    the others — it reuses the same CSS class.
		const startRibbonEl =
			owner === "daily"
				? this.dailyRibbonEl
				: owner === "meeting"
					? this.meetingRibbonEl
					: this.cursorRibbonEl;
		startRibbonEl.addClass("vault-recorder-recording");
		this.levelRibbonEl.removeClass("vault-recorder-level-hidden");
		this.levelRibbonEl.setCssProps({ "--vr-level": "0" });

		this.activeCapture = {
			owner,
			session,
			startedAt: now,
			filename,
			dailyLogPath,
			cursorSnapshot,
			startRibbonEl,
			rafHandle: 0,
			lastLevelUpdate: 0,
			lastLevelText: "0",
		};

		// 4) Start the level loop.
		this.startLevelLoop();

		new Notice("Recording started");
	}

	private async stopCapture(): Promise<void> {
		const capture = this.activeCapture;
		if (!capture) return;

		// Clear the state immediately so a second click cannot start a parallel
		// stop.
		this.activeCapture = null;
		window.cancelAnimationFrame(capture.rafHandle);

		try {
			// Read the peak RMS BEFORE stopRecording closes the audio graph.
			// The value is already stored in session.peakLevel, so getPeakLevel
			// never touches the AnalyserNode, but doing it in this order keeps
			// the dependency obvious.
			const peak = getPeakLevel(capture.session);

			const blob = await stopRecording(capture.session);

			const result = await this.lifecycle.recordingStopped({
				mode: MODE_KEY_OF_OWNER[capture.owner],
				filename: capture.filename,
				peak,
				audio: await blob.arrayBuffer(),
				linkTarget: this.linkTargetOf(capture),
			});
			for (const message of result.messages) new Notice(message);
			// The new transcript note's transcriber meets it now, not at the next interval.
			void this.lifecycle.tick(new Date());
		} catch (err) {
			new Notice(
				`Could not save the recording: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			// Clean up the ribbon state whatever the outcome.
			capture.startRibbonEl.removeClass("vault-recorder-recording");
			this.levelRibbonEl.addClass("vault-recorder-level-hidden");
			this.levelRibbonEl.setCssProps({ "--vr-level": "0" });
			// Release the wake lock deterministically on every stop path.
			// Idempotent — safe even if the acquire never succeeded.
			try {
				await this.wakeLock.release();
			} catch {
				// Best effort — release must not throw out of stopCapture.
			}
		}
	}

	/**
	 * Called by the onSystemAudioEnded callback in startMeetingRecording when
	 * the system-audio (loopback) track ends part-way through a meeting
	 * recording.
	 *
	 * Re-entrancy: stopCapture clears this.activeCapture synchronously at the
	 * top. On a normal stop (toggle or ribbon), activeCapture is already null
	 * by the time the tracks are stopped and "ended" can fire — so the owner
	 * check below is false and this method is a no-op. No double stop, no
	 * double notice.
	 */
	private async handleSystemAudioEnded(): Promise<void> {
		if (this.activeCapture?.owner !== "meeting") return;
		new Notice(
			"System-audio capture ended — the meeting recording was stopped and saved.",
		);
		await this.stopCapture();
	}

	// --- Level loop ----------------------------------------------------------

	private startLevelLoop(): void {
		const tick = (timestamp: number): void => {
			const capture = this.activeCapture;
			if (!capture) return;

			if (
				timestamp - capture.lastLevelUpdate >=
				LEVEL_UPDATE_INTERVAL_MS
			) {
				// readLevel MUST be called for its side effect: the monotonic
				// update of session.peakLevel (linear RMS), which stopCapture
				// reads for the silent-microphone guard. The scaling to a
				// display value happens only on the returned number, never
				// inside the recorder module.
				const rms = readLevel(capture.session);
				const text = mapLevelToDisplay(rms).toFixed(3);
				if (text !== capture.lastLevelText) {
					this.levelRibbonEl.setCssProps({ "--vr-level": text });
					capture.lastLevelText = text;
				}
				capture.lastLevelUpdate = timestamp;
			}

			capture.rafHandle = window.requestAnimationFrame(tick);
		};
		if (this.activeCapture) {
			this.activeCapture.rafHandle = window.requestAnimationFrame(tick);
		}
	}

	// --- Helpers -------------------------------------------------------------

	/** Where this capture's link goes: fixed at start, so it is the note the user was in then. */
	private linkTargetOf(capture: ActiveCapture): LinkTarget {
		if (capture.owner === "daily" && capture.dailyLogPath) {
			return { kind: "daily-log", path: capture.dailyLogPath };
		}
		if (capture.cursorSnapshot) {
			return { kind: "cursor", snapshot: capture.cursorSnapshot };
		}
		throw new Error("The recording has no note to link from");
	}

	private createActiveEditorAdapter(): ActiveEditorAdapter {
		const activeEditor: MarkdownFileInfo | null =
			this.app.workspace.activeEditor;
		return {
			getActiveFilePath: () => activeEditor?.file?.path ?? null,
			getCursor: () => {
				const editor = activeEditor?.editor;
				if (!editor) return null;
				const pos = editor.getCursor();
				return { line: pos.line, ch: pos.ch };
			},
		};
	}

	/** The Daily Notes core plugin's folder and format, or `undefined` when it is off. */
	private readDailyNotesOptions(): DailyNotesOptions | undefined {
		const appX = this.app as unknown as AppWithInternalPlugins;
		return readDailyNotesOptions(appX.internalPlugins);
	}
}
