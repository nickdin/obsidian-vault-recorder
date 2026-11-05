/**
 * The queue panel: a side panel listing the transcript notes by group. The model (`queue-model.ts`) decides the groups and the
 * numbers; this file reads the notes through Obsidian's metadata cache, draws
 * what the model returns, and redraws when a transcript note changes.
 *
 * Nothing is written for the panel: it has no note of its own.
 */

import { ItemView, TFile, type App, type WorkspaceLeaf } from "obsidian";

import type { ClockPort, Lifecycle } from "./lifecycle";
import {
	ProgressMemory,
	buildQueue,
	timeLeftWords,
	type QueueGroup,
	type QueueNote,
	type QueueRow,
} from "./queue-model";
import { unnamedLine, type RecordingAction } from "./state-line";
import { heldWords, type KeepAction } from "./keep-time";
import { parseTranscriptNote } from "./transcript-note";
import type { VaultRecorderSettings } from "./settings-data";
import type { RemovalAction, RemovalEntry } from "./removal";

export const QUEUE_VIEW_TYPE = "vault-recorder-queue";

/** A redraw waits this long after the last change, so a burst of writes draws once. */
const REDRAW_DELAY_MS = 200;

export interface QueuePanelDeps {
	lifecycle: Lifecycle;
	clock: ClockPort;
	settings: () => VaultRecorderSettings;
	/** Runs an action a row's button names on the transcript note at `notePath`. */
	runAction(action: RecordingAction | KeepAction, notePath: string): void;
	/** The four removal entries for the transcript note at `notePath`, greyed where they cannot apply. */
	removalEntries(notePath: string): RemovalEntry[];
	/** Runs a removal entry on the recording whose transcript note is at `notePath`. */
	runRemoval(action: RemovalAction, notePath: string): void;
}

export class QueuePanelView extends ItemView {
	private readonly progress = new ProgressMemory();
	private redrawTimer: number | null = null;
	/** Bumped on every redraw so a slow read cannot draw over a newer one. */
	private generation = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: QueuePanelDeps,
	) {
		super(leaf);
	}

	getViewType(): string {
		return QUEUE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Transcription queue";
	}

	getIcon(): string {
		return "list-music";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("vault-recorder-queue");
		// A note's properties change: the metadata cache says so for every
		// write, a progress percentage included. A state the lifecycle derives
		// (overdue, a waiting reason) can change without a write.
		this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRedraw()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRedraw()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRedraw()));
		const stopListening = this.deps.lifecycle.onNoteStateChanged(() => this.scheduleRedraw());
		this.register(stopListening);
		this.registerInterval(window.setInterval(() => this.scheduleRedraw(), 60_000));
		await this.redraw();
	}

	async onClose(): Promise<void> {
		if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
		this.redrawTimer = null;
		this.generation++;
	}

	private scheduleRedraw(): void {
		if (this.redrawTimer !== null) return;
		this.redrawTimer = window.setTimeout(() => {
			this.redrawTimer = null;
			void this.redraw();
		}, REDRAW_DELAY_MS);
	}

	private async redraw(): Promise<void> {
		const mine = ++this.generation;
		const notes = await readTranscriptNotes(this.app, this.deps.lifecycle);
		if (mine !== this.generation) return;
		const settings = this.deps.settings();
		const now = this.deps.clock.now();
		const groups = buildQueue({
			notes,
			clock: { now, utcOffsetMinutes: (at) => this.deps.clock.utcOffsetMinutes(at) },
			overdueHours: settings.overdueHours,
			progress: this.progress,
			settings,
		});
		this.draw(groups);
	}

	private draw(groups: QueueGroup[]): void {
		const el = this.contentEl;
		el.empty();
		if (groups.length === 0) {
			el.createDiv({ cls: "vault-recorder-queue-empty", text: "Nothing in the queue" });
			return;
		}
		for (const group of groups) {
			const section = el.createDiv({ cls: "vault-recorder-queue-group" });
			section.dataset.group = group.id;
			section.createEl("h4", { text: `${group.title} (${group.rows.length})` });
			for (const row of group.rows) this.drawRow(section, row);
		}
	}

	private drawRow(parent: HTMLElement, row: QueueRow): void {
		const el = parent.createDiv({ cls: "vault-recorder-queue-row" });
		el.dataset.path = row.path;
		const title = el.createEl("a", { cls: "vault-recorder-queue-title", text: row.title });
		title.addEventListener("click", (event) => {
			event.preventDefault();
			void this.openNote(row.path, event.ctrlKey || event.metaKey);
		});
		const state = el.createDiv({ cls: "vault-recorder-queue-state" });
		state.createSpan({ text: row.line });
		if (row.placeInLine !== null) {
			state.createSpan({
				cls: "vault-recorder-queue-place",
				text: ` — place ${row.placeInLine} in line`,
			});
		}
		if (row.percent !== null) {
			const meter = el.createEl("progress", { cls: "vault-recorder-queue-meter" });
			meter.max = 100;
			meter.value = row.percent;
			el.createDiv({
				cls: "vault-recorder-queue-left",
				text: row.timeLeftMs === null ? "time left not known yet" : timeLeftWords(row.timeLeftMs),
			});
		}
		const unnamed = unnamedLine(row.unnamed);
		if (unnamed !== null) el.createDiv({ cls: "vault-recorder-queue-unnamed", text: unnamed });
		if (row.audioHeld !== null) el.createDiv({ cls: "vault-recorder-queue-audio-held", text: heldWords(row.audioHeld) });
		if (row.notOffered) el.createDiv({ cls: "vault-recorder-queue-why", text: row.notOffered });
		// "Delete audio" is one of the four removal entries drawn below.
		const offers = row.offers.filter((offer) => offer.action !== "delete-audio");
		if (offers.length > 0) {
			const buttons = el.createDiv({ cls: "vault-recorder-queue-actions" });
			for (const offer of offers) {
				const button = buttons.createEl("button", { text: offer.label });
				button.dataset.action = offer.action;
				button.addEventListener("click", () => this.deps.runAction(offer.action, row.path));
			}
		}
		this.drawRemoval(el, row.path);
	}

	/** The four ways to remove a recording, on every row; the ones that cannot apply are greyed with the reason. */
	private drawRemoval(el: HTMLElement, path: string): void {
		const buttons = el.createDiv({ cls: "vault-recorder-queue-actions vault-recorder-queue-removal" });
		for (const entry of this.deps.removalEntries(path)) {
			const button = buttons.createEl("button", { text: entry.label });
			button.dataset.action = entry.action;
			if (entry.greyedBecause !== null) {
				button.disabled = true;
				button.title = entry.greyedBecause;
				button.dataset.greyedBecause = entry.greyedBecause;
				continue;
			}
			button.addEventListener("click", () => this.deps.runRemoval(entry.action, path));
		}
	}

	private async openNote(path: string, newTab: boolean): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf(newTab).openFile(file);
	}
}

/**
 * Every transcript note, found through the metadata cache (a note with a
 * `rule-version` property) and read as the plugin writes them. A note that
 * does not parse is not the plugin's and is left out.
 */
async function readTranscriptNotes(app: App, lifecycle: Lifecycle): Promise<QueueNote[]> {
	const found: QueueNote[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (app.metadataCache.getFileCache(file)?.frontmatter?.["rule-version"] === undefined) continue;
		const note = parseTranscriptNote(await app.vault.cachedRead(file));
		if (note === null) continue;
		found.push({ path: file.path, note, waitingReason: lifecycle.statusOf(file.path)?.waitingReason ?? null });
	}
	return found;
}

/** Open the panel in the right sidebar, or bring the one already open forward. */
export async function openQueuePanel(app: App): Promise<void> {
	const { workspace } = app;
	let leaf = workspace.getLeavesOfType(QUEUE_VIEW_TYPE)[0];
	if (!leaf) {
		const created = workspace.getRightLeaf(false);
		if (!created) return;
		leaf = created;
		await leaf.setViewState({ type: QUEUE_VIEW_TYPE, active: true });
	}
	await workspace.revealLeaf(leaf);
}
