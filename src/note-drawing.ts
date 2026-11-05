/**
 * The in-place drawing: under (or, in a meeting note, beside the transcript
 * link next to) a recording's audio embed, the plugin shows where the
 * transcript stands and, once there is one, the transcript itself. A transcript
 * note shows the same state line at its top.
 *
 * Nothing is written into any note. The drawing is made of elements the plugin
 * adds to what Obsidian shows, keyed on the audio embed, so it goes away with
 * the embed, and with the plugin: where the plugin does not run, the note is as
 * Obsidian shows it.
 *
 * One renderer, two hosts. `NoteDrawing.attach` is the single function that
 * fills an element with the drawing. Live Preview (a CodeMirror editor
 * extension, below) and reading view (a Markdown post-processor, below) each
 * only decide where the element goes and then hand it to `attach`. The words
 * come from `state-line.ts`, which is pure and tested.
 */

import {
	Component,
	MarkdownRenderer,
	MarkdownView,
	TFile,
	editorInfoField,
	editorLivePreviewField,
	type App,
	type Plugin,
} from "obsidian";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import type { ClockPort, Lifecycle } from "./lifecycle";
import {
	actionsFor,
	namingOffers,
	speakersToName,
	textToDraw,
	unnamedLine,
	type DrawClock,
	type RecordingAction,
} from "./state-line";
import { deriveState, parseTranscriptNote } from "./transcript-note";
import type { VaultRecorderSettings } from "./settings-data";
import type { RemovalAction, RemovalEntry } from "./removal";
import { frontmatterText } from "./frontmatter-text";
import {
	audioFate,
	audioLine,
	deletedEmbedWords,
	fateContextFor,
	keepOffers,
	type KeepAction,
} from "./keep-time";

/** What to draw for: one audio embed in a note, or a transcript note's own top. */
export type DrawRequest =
	| { kind: "embed"; linkpath: string; sourcePath: string }
	| { kind: "top"; notePath: string };

/** A block under the embed, or a short span beside the transcript link. */
type Placement = "block" | "inline";

export interface NoteDrawingDeps {
	app: App;
	plugin: Plugin;
	lifecycle: Lifecycle;
	clock: ClockPort;
	settings: () => VaultRecorderSettings;
	/** Runs the action a button on the state line names, on the transcript note at `notePath`. */
	runAction(action: RecordingAction | KeepAction, notePath: string): void;
	/** The four removal entries for the transcript note at `notePath`, greyed where they cannot apply. */
	removalEntries(notePath: string): RemovalEntry[];
	/** Runs a removal entry on the recording whose transcript note is at `notePath`. */
	runRemoval(action: RemovalAction, notePath: string): void;
}

const CSS = "vault-recorder-drawing";

/** The drawing's elements, one per embed (or note top) currently on screen. */
export class NoteDrawing {
	private readonly hosts = new Map<HTMLElement, { request: DrawRequest; placement: Placement }>();
	private readonly generation = new WeakMap<HTMLElement, number>();
	private readonly rendered = new WeakMap<HTMLElement, Component>();

	constructor(private readonly deps: NoteDrawingDeps) {}

	/**
	 * The transcript note a request is about, or `null` when the plugin knows
	 * of none. An embed is matched to its transcript note by the note's `audio`
	 * property, resolved as Obsidian resolves a link, so a recording saved
	 * under a suffixed name still finds its own note.
	 */
	transcriptFor(request: DrawRequest): TFile | null {
		const { app, lifecycle } = this.deps;
		if (request.kind === "top") {
			const note = app.vault.getAbstractFileByPath(request.notePath);
			return note instanceof TFile && lifecycle.statusOf(note.path) ? note : null;
		}
		const audio = app.metadataCache.getFirstLinkpathDest(request.linkpath, request.sourcePath);
		// A deleted recording's embed resolves to nothing: its transcript note is
		// the one whose `audio` link ends in the same file name.
		if (!audio) return this.noteOfDeletedAudio(request.linkpath);
		for (const status of lifecycle.statuses()) {
			const note = app.vault.getAbstractFileByPath(status.path);
			if (!(note instanceof TFile)) continue;
			const link: unknown = app.metadataCache.getFileCache(note)?.frontmatter?.audio;
			if (typeof link !== "string") continue;
			const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0];
			if (app.metadataCache.getFirstLinkpathDest(target, note.path)?.path === audio.path) {
				return note;
			}
		}
		return null;
	}

	private noteOfDeletedAudio(linkpath: string): TFile | null {
		const { app, lifecycle } = this.deps;
		const name = linkpath.slice(linkpath.lastIndexOf("/") + 1);
		for (const status of lifecycle.statuses()) {
			const note = app.vault.getAbstractFileByPath(status.path);
			if (!(note instanceof TFile)) continue;
			const front = app.metadataCache.getFileCache(note)?.frontmatter;
			const link: unknown = front?.audio;
			if (typeof link !== "string" || front?.["audio-deleted"] === undefined) continue;
			const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0];
			if (target.slice(target.lastIndexOf("/") + 1) === name) return note;
		}
		return null;
	}

	/**
	 * The written date when this embed's recording has been deleted, else
	 * `null`: the embed is then drawn as "Audio deleted <date>, transcript
	 * kept" in place of Obsidian's box for a file that is not there.
	 */
	deletedOn(request: DrawRequest): string | null {
		if (request.kind !== "embed") return null;
		const { app } = this.deps;
		if (app.metadataCache.getFirstLinkpathDest(request.linkpath, request.sourcePath)) return null;
		const note = this.noteOfDeletedAudio(request.linkpath);
		const date: unknown = note ? app.metadataCache.getFileCache(note)?.frontmatter?.["audio-deleted"] : undefined;
		return date === undefined ? null : frontmatterText(date);
	}

	/** Where the drawing for a request goes, or `null` when there is nothing to draw. */
	placement(request: DrawRequest): Placement | null {
		const note = this.transcriptFor(request);
		if (!note) return null;
		if (request.kind === "top") return "block";
		const mode: unknown = this.deps.app.metadataCache.getFileCache(note)?.frontmatter?.mode;
		return mode === "meeting" ? "inline" : "block";
	}

	/** Fill `container` with the drawing for `request`, and keep it current. */
	attach(container: HTMLElement, request: DrawRequest, placement: Placement): void {
		this.hosts.set(container, { request, placement });
		void this.draw(container, request, placement);
	}

	detach(container: HTMLElement): void {
		this.hosts.delete(container);
		this.releaseRendered(container);
	}

	/** Draw every element again: a state changed, or a transcript note was edited. */
	redrawAll(): void {
		for (const [container, { request, placement }] of [...this.hosts]) {
			if (!container.isConnected) {
				this.detach(container);
				continue;
			}
			void this.draw(container, request, placement);
		}
	}

	/** Take every element the reading view holds off the page. */
	removeAll(): void {
		for (const container of [...this.hosts.keys()]) {
			this.detach(container);
			container.remove();
		}
	}

	private drawRemovalLine(container: HTMLElement, notePath: string): void {
		const line = container.createDiv({ cls: `${CSS}-removal` });
		for (const entry of this.deps.removalEntries(notePath)) {
			const button = line.createEl("button", { cls: `${CSS}-action`, text: entry.label });
			button.dataset.action = entry.action;
			if (entry.greyedBecause !== null) {
				button.disabled = true;
				button.title = entry.greyedBecause;
				button.dataset.greyedBecause = entry.greyedBecause;
				continue;
			}
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.deps.runRemoval(entry.action, notePath);
			});
		}
	}

	private releaseRendered(container: HTMLElement): void {
		const previous = this.rendered.get(container);
		if (previous) this.deps.plugin.removeChild(previous);
		this.rendered.delete(container);
	}

	private async draw(
		container: HTMLElement,
		request: DrawRequest,
		placement: Placement,
	): Promise<void> {
		const { app, lifecycle, clock, settings } = this.deps;
		const mine = (this.generation.get(container) ?? 0) + 1;
		this.generation.set(container, mine);
		const stale = (): boolean => this.generation.get(container) !== mine;

		const file = this.transcriptFor(request);
		const text = file ? await app.vault.read(file) : null;
		const note = text === null ? null : parseTranscriptNote(text);
		if (stale()) return;
		this.releaseRendered(container);
		container.empty();
		container.removeClass(CSS, `${CSS}-block`, `${CSS}-inline`);
		if (!file || !note) return;

		const now = clock.now();
		const drawClock: DrawClock = { now, utcOffsetMinutes: (at) => clock.utcOffsetMinutes(at) };
		const known = lifecycle.statusOf(file.path);
		const status = {
			state: known?.state ?? deriveState(note, now, settings().overdueHours),
			waitingReason: known?.waitingReason ?? null,
		};
		const drawn = textToDraw(note, status, drawClock);

		container.addClass(CSS, `${CSS}-${placement}`);
		container.createSpan({ cls: `${CSS}-state`, text: drawn.stateLine });
		const { offers, notOffered } = actionsFor(note, status.state);
		// The date the audio will go, or the date it went. Under an embed whose
		// recording is gone the words already stand in place of the embed.
		const fate = audioFate(note, status.state, fateContextFor(note, settings()));
		const audioWords = audioLine(fate, (atMs) => clock.utcOffsetMinutes(new Date(atMs)));
		if (fate.kind === "deleted" && request.kind === "embed") {
			// Where the recording's embed stood: the box Obsidian draws for a file
			// that is not there is taken off the screen (`hideDeletedEmbeds`).
			container.createSpan({ cls: `${CSS}-deleted`, text: deletedEmbedWords(fate.date) });
		} else if (audioWords !== null) {
			container.createSpan({ cls: `${CSS}-audio`, text: audioWords });
		}
		// "2 speakers unnamed — name them" goes with the state line, at the top of
		// a transcript note and under the recording, until naming is finished.
		const unnamed = unnamedLine(speakersToName(note, status.state));
		if (unnamed !== null) {
			const line = container.createSpan({ cls: `${CSS}-unnamed`, text: unnamed });
			line.dataset.action = "name-speakers";
			line.setAttribute("role", "button");
			line.tabIndex = 0;
			const open = (): void => this.deps.runAction("name-speakers", file.path);
			line.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				open();
			});
			line.addEventListener("keydown", (event) => {
				if (event.key === "Enter") open();
			});
		}
		// The line above is itself the way to name; only "leave the rest" is a button.
		const leave = namingOffers(note, status.state).filter((offer) => offer.action === "leave-unnamed");
		// The top of a transcript note draws "Delete audio" with the other removal entries.
		const keep = request.kind === "top" ? keepOffers(note).filter((offer) => offer.action !== "delete-audio") : keepOffers(note);
		for (const offer of [...offers, ...leave, ...keep]) {
			const button = container.createEl("button", {
				cls: `${CSS}-action`,
				text: offer.label,
			});
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.deps.runAction(offer.action, file.path);
			});
		}
		if (notOffered !== null) container.createSpan({ cls: `${CSS}-why`, text: notOffered });
		// The line at the top of the transcript note: the four ways to remove the recording.
		if (request.kind === "top") this.drawRemovalLine(container, file.path);
		if (placement === "inline" || request.kind === "top") return;

		const body = container.createDiv({ cls: `${CSS}-text` });
		const component = this.deps.plugin.addChild(new Component());
		this.rendered.set(container, component);
		for (const section of [drawn.agent, drawn.transcript]) {
			if (section === null) continue;
			const piece = body.createDiv({ cls: `${CSS}-section` });
			try {
				await MarkdownRenderer.render(app, section, piece, file.path, component);
			} catch (err) {
				console.error("[vault-recorder] could not render a transcript:", err);
				piece.setText(section);
			}
			if (stale()) return;
		}
	}
}

// --- Live Preview ------------------------------------------------------------------------

/** Dispatched to an editor to make it work out where the drawing goes again. */
const refreshDrawing = StateEffect.define<null>();

const EMBED = /!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Wraps `attach` for CodeMirror: the widget's element is the drawing's element. */
class DrawingWidget extends WidgetType {
	constructor(
		private readonly drawing: NoteDrawing,
		private readonly request: DrawRequest,
		private readonly placement: Placement,
	) {
		super();
	}

	private get key(): string {
		return `${this.placement}\n${JSON.stringify(this.request)}`;
	}

	eq(other: DrawingWidget): boolean {
		return other.key === this.key;
	}

	toDOM(): HTMLElement {
		const el = createEl(this.placement === "block" ? "div" : "span");
		this.drawing.attach(el, this.request, this.placement);
		return el;
	}

	destroy(dom: HTMLElement): void {
		this.drawing.detach(dom);
	}
}

function frontmatterEnd(state: EditorState): number | null {
	const doc = state.doc;
	if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return null;
	for (let n = 2; n <= doc.lines; n++) {
		if (doc.line(n).text.trimEnd() === "---") return doc.line(n).to;
	}
	return null;
}

function buildDecorations(drawing: NoteDrawing, state: EditorState): DecorationSet {
	const path = state.field(editorInfoField, false)?.file?.path;
	if (!path || !state.field(editorLivePreviewField, false)) return Decoration.none;

	const found: Range<Decoration>[] = [];
	const top: DrawRequest = { kind: "top", notePath: path };
	const end = frontmatterEnd(state);
	if (end !== null && drawing.placement(top)) {
		found.push(
			Decoration.widget({
				widget: new DrawingWidget(drawing, top, "block"),
				block: true,
				side: 1,
			}).range(end),
		);
	}
	for (let n = 1; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (!line.text.includes("![[")) continue;
		for (const match of line.text.matchAll(EMBED)) {
			const request: DrawRequest = { kind: "embed", linkpath: match[1], sourcePath: path };
			const placement = drawing.placement(request);
			if (!placement) continue;
			found.push(
				Decoration.widget({
					widget: new DrawingWidget(drawing, request, placement),
					block: placement === "block",
					side: 1,
				}).range(line.to),
			);
		}
	}
	return Decoration.set(found, true);
}

/**
 * The Live Preview host. Block decorations may only come from a state field,
 * so this is one; it works out the widgets again when the text changes or an
 * editor is told to with `refreshDrawing`.
 */
function livePreviewExtension(drawing: NoteDrawing): Extension {
	return StateField.define<DecorationSet>({
		create: (state) => buildDecorations(drawing, state),
		update(value, transaction) {
			const refresh = transaction.effects.some((effect) => effect.is(refreshDrawing));
			if (!transaction.docChanged && !transaction.reconfigured && !refresh) return value;
			return buildDecorations(drawing, transaction.state);
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

// --- Reading view ------------------------------------------------------------------------

function drawInReadingView(drawing: NoteDrawing, el: HTMLElement, sourcePath: string): void {
	for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed[src]"))) {
		if (embed.dataset.vaultRecorderDrawn) continue;
		const linkpath = (embed.getAttribute("src") ?? "").split("#")[0];
		const request: DrawRequest = { kind: "embed", linkpath, sourcePath };
		const placement = drawing.placement(request);
		if (!placement) continue;
		embed.dataset.vaultRecorderDrawn = "1";
		// Obsidian's box for a file that is not there gives way to the words the
		// drawing puts first in its own element.
		if (drawing.deletedOn(request) !== null) embed.addClass(`${CSS}-gone`);
		const container = createEl(placement === "block" ? "div" : "span");
		if (placement === "block") {
			(embed.closest("p") ?? embed).insertAdjacentElement("afterend", container);
		} else {
			// Beside the transcript link that follows the embed on its line.
			const link = embed.parentElement?.querySelector<HTMLElement>("a.internal-link");
			(link ?? embed).insertAdjacentElement("afterend", container);
		}
		drawing.attach(container, request, placement);
	}
}

/**
 * Obsidian draws a box saying "could not be found" for the embed of a deleted
 * recording, in Live Preview and in reading view. Where the plugin draws "Audio
 * deleted …, transcript kept" in its place, the box is taken off the screen
 * (a class, so nothing is written to the note). Obsidian may build the box
 * again at any time, so this runs on the same look as the top lines.
 */
function hideDeletedEmbeds(app: App, drawing: NoteDrawing): void {
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) return;
		for (const embed of Array.from(view.containerEl.querySelectorAll<HTMLElement>(".internal-embed[src]"))) {
			if (embed.hasClass(`${CSS}-gone`)) continue;
			const linkpath = (embed.getAttribute("src") ?? "").split("#")[0];
			if (drawing.deletedOn({ kind: "embed", linkpath, sourcePath: view.file.path }) !== null) {
				embed.addClass(`${CSS}-gone`);
			}
		}
	});
}

/** The state line at the top of an open transcript note's reading view. */
function drawTopOfTranscriptNotes(app: App, drawing: NoteDrawing): void {
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.getMode() !== "preview" || !view.file) return;
		const sizer = view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer");
		if (!sizer) return;
		const request: DrawRequest = { kind: "top", notePath: view.file.path };
		const existing = sizer.querySelector<HTMLElement>(":scope > [data-vault-recorder-top]");
		if (!drawing.placement(request)) {
			existing?.remove();
			return;
		}
		if (existing) return;
		const container = createDiv();
		container.dataset.vaultRecorderTop = "1";
		container.addClass(`${CSS}-top`);
		sizer.prepend(container);
		drawing.attach(container, request, "block");
	});
}

// --- Wiring ------------------------------------------------------------------------------

/**
 * Switch the drawing on: the Live Preview extension, the reading-view
 * post-processor, and the events that keep both current. Everything is
 * registered on `plugin`, so unloading the plugin takes it all away.
 */
export function registerNoteDrawing(deps: NoteDrawingDeps): NoteDrawing {
	const { app, plugin, lifecycle } = deps;
	const drawing = new NoteDrawing(deps);

	// A transcript note with nothing under its properties has no section for the
	// post-processor to run on, so its top line is put in when a view opens or
	// switches mode. The reading view builds its page a moment after the event,
	// and builds it again whenever the note is written (naming a speaker is such
	// a write), so the top line is put back after every render too.
	const topLater = (): void => {
		for (const wait of [0, 250]) {
			window.setTimeout(() => {
				drawTopOfTranscriptNotes(app, drawing);
				hideDeletedEmbeds(app, drawing);
			}, wait);
		}
	};

	plugin.registerEditorExtension(livePreviewExtension(drawing));
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		drawInReadingView(drawing, el, ctx.sourcePath);
		topLater();
	});

	// A note appearing or going changes where drawings belong: work them out
	// again in every open editor and reading view. A state change only needs
	// the words redrawn.
	let scheduled = false;
	const placementsChanged = (): void => {
		if (scheduled) return;
		scheduled = true;
		window.setTimeout(() => {
			scheduled = false;
			app.workspace.iterateAllLeaves((leaf) => {
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) return;
				const cm = (view.editor as unknown as { cm?: EditorView }).cm;
				cm?.dispatch({ effects: refreshDrawing.of(null) });
				if (view.getMode() === "preview") view.previewMode.rerender(true);
			});
			drawTopOfTranscriptNotes(app, drawing);
			drawing.redrawAll();
		}, 0);
	};
	plugin.register(
		lifecycle.onNoteStateChanged((change) => {
			if (!change.previous || !change.current) placementsChanged();
			else drawing.redrawAll();
		}),
	);
	plugin.registerEvent(
		app.vault.on("modify", (file) => {
			if (!lifecycle.statusOf(file.path)) return;
			void lifecycle.lookAgain(file.path, deps.clock.now()).then(() => drawing.redrawAll());
		}),
	);
	plugin.registerEvent(
		app.metadataCache.on("changed", (file) => {
			if (lifecycle.statusOf(file.path)) placementsChanged();
		}),
	);
	plugin.registerEvent(
		app.workspace.on("layout-change", () => {
			placementsChanged();
			topLater();
		}),
	);
	// Obsidian swaps a re-rendered page into the sizer after the post-processors
	// ran, which can take the top line with it, and no event says when it is
	// done. So once a second every open reading view is looked at (a note that is
	// not a transcript note is skipped by `placement`), and the line is put back
	// where it is missing. Measured 2026-10-22 in the test Obsidian, five writes to
	// an open transcript note: the line was gone 41–61 ms after the write and back
	// 161–281 ms after it, sooner than a once-a-second look alone would manage, so
	// what restored it that fast was not identified; this look is the backstop.
	plugin.registerInterval(
		window.setInterval(() => {
			drawTopOfTranscriptNotes(app, drawing);
			hideDeletedEmbeds(app, drawing);
		}, 1000),
	);
	plugin.registerEvent(app.workspace.on("active-leaf-change", topLater));
	plugin.registerEvent(app.workspace.on("file-open", topLater));
	plugin.register(() => drawing.removeAll());
	return drawing;
}
