/**
 * Making a turn's time and speaker label clickable: a click on
 * `Speaker 2` opens the naming list, a click on `[00:12:34]` plays the
 * recording from there.
 *
 * Three places show a turn and each needs its own way in, all handing the same
 * two handlers the click:
 * - reading view of a transcript note, and the transcript drawn in place under a
 *   recording's embed: both are rendered DOM, so `enhanceTurns` finds the bold
 *   label that follows a `[hh:mm:ss]` and wires it;
 * - Live Preview of a transcript note: the editor draws the text itself, so a
 *   CodeMirror mouse handler reads the line under the click.
 *
 * Nothing is written into the note for any of it. In source mode a click is an
 * ordinary click: the text is there to edit.
 */

import { editorInfoField, editorLivePreviewField, type App, type Plugin } from "obsidian";
import { ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { writtenLabelAt } from "./naming";
import { turnTargetAt } from "./turn-line";

/** What a click on a turn does; both take the transcript note the turn is in. */
export interface TurnHandlers {
	/** Open the naming list for `label`, as the note writes it (in text drawn in place, where the source is not at hand, as a reader sees it). */
	pick(notePath: string, label: string): void;
	/** Play the note's recording from `seconds`. */
	play(notePath: string, seconds: number): void;
}

const CSS = "vault-recorder-turn";
const TIME_AT_END = /\[(\d{2}):(\d{2}):(\d{2})\] $/;

const secondsOf = (h: string, m: string, s: string): number => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** Wire `target` to run `act` on a click or on Enter, without the note's own link handling taking it. */
function onActivate(target: HTMLElement, act: () => void): void {
	target.setAttribute("role", "button");
	target.tabIndex = 0;
	target.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		act();
	});
	target.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		act();
	});
}

/**
 * Wire every turn in rendered `root`: the time before a bold label plays, the
 * label opens the list. Safe to run twice on the same element.
 */
export function enhanceTurns(
	root: HTMLElement,
	notePath: string,
	handlers: TurnHandlers,
	source?: () => string | null,
): void {
	let written: string | null | undefined;
	for (const strong of Array.from(root.querySelectorAll<HTMLElement>("strong"))) {
		if (strong.dataset.vaultRecorderTurn) continue;
		const shown = strong.textContent ?? "";
		const before = strong.previousSibling;
		if (!shown.endsWith(":") || !(before instanceof Text)) continue;
		const time = TIME_AT_END.exec(before.data);
		if (!time) continue;

		strong.dataset.vaultRecorderTurn = "1";
		// A click carries the label as the note writes it: what Obsidian shows for
		// `[[Anna Svensson#Work]]` is `Anna Svensson > Work`, which names no label.
		// Without the source (the text drawn in place) the shown words are all there is.
		if (written === undefined) written = source?.() ?? null;
		const label =
			written === null
				? shown.slice(0, -1)
				: writtenLabelAt(written, secondsOf(time[1], time[2], time[3]), shown.slice(0, -1));
		strong.addClass(`${CSS}-speaker`);
		strong.setAttribute("title", "Name this speaker");
		onActivate(strong, () => handlers.pick(notePath, label));

		// `[00:12:34] ` is split off the text before the label and its brackets
		// and digits put in a span of their own, the space left where it was.
		const clock = before.splitText(time.index);
		clock.splitText(time[0].length - 1);
		const span = createSpan();
		span.className = `${CSS}-time`;
		span.textContent = clock.data;
		span.setAttribute("title", "Play from here");
		onActivate(span, () => handlers.play(notePath, secondsOf(time[1], time[2], time[3])));
		clock.replaceWith(span);
	}
}

// --- Live Preview ------------------------------------------------------------------------

/**
 * A mouse press in a transcript note's Live Preview: on a turn's time it plays,
 * on its label it opens the list, anywhere else it is an ordinary click.
 *
 * A label that is a link (`**[[Anna Svensson]]:**`, which is what picking a
 * participant writes) is drawn with its own handlers that open the note, and a
 * press on it never reaches the editor's handlers (#147, seen in TestVault). So
 * this listens on the editor's content in the capture phase, before anything
 * under it, and takes the press, the release and the click that follow it.
 */
function livePreviewClicks(isTranscript: (path: string) => boolean, handlers: TurnHandlers): Extension {
	return ViewPlugin.define((view) => {
		let taken = false;

		const press = (event: MouseEvent): void => {
			taken = false;
			if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
			if (!view.state.field(editorLivePreviewField, false)) return;
			const path = view.state.field(editorInfoField, false)?.file?.path;
			if (!path || !isTranscript(path)) return;
			const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (at === null) return;
			const line = view.state.doc.lineAt(at);
			const target = turnTargetAt(line.text, at - line.from);
			if (target === null) return;
			taken = true;
			swallow(event);
			if (target.kind === "time") handlers.play(path, target.seconds);
			else handlers.pick(path, target.label);
		};
		const follow = (event: MouseEvent): void => {
			if (taken) swallow(event);
		};
		const click = (event: MouseEvent): void => {
			follow(event);
			taken = false;
		};

		view.contentDOM.addEventListener("mousedown", press, true);
		view.contentDOM.addEventListener("mouseup", follow, true);
		view.contentDOM.addEventListener("click", click, true);
		return {
			destroy(): void {
				view.contentDOM.removeEventListener("mousedown", press, true);
				view.contentDOM.removeEventListener("mouseup", follow, true);
				view.contentDOM.removeEventListener("click", click, true);
			},
		};
	});
}

/** Keep an event from the editor and from the link under it. */
function swallow(event: MouseEvent): void {
	event.preventDefault();
	event.stopImmediatePropagation();
}

// --- Wiring --------------------------------------------------------------------------------

export interface TurnClickDeps {
	app: App;
	plugin: Plugin;
	handlers: TurnHandlers;
}

/** Whether `path` is one of the plugin's transcript notes: it has a `rule-version` property. */
export function isTranscriptNote(app: App, path: string): boolean {
	const file = app.vault.getFileByPath(path);
	return file !== null && app.metadataCache.getFileCache(file)?.frontmatter?.["rule-version"] !== undefined;
}

/** Switch the clicks on: Live Preview and reading view of every transcript note. */
export function registerTurnClicks(deps: TurnClickDeps): void {
	const { app, plugin, handlers } = deps;
	plugin.registerEditorExtension(livePreviewClicks((path) => isTranscriptNote(app, path), handlers));
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		if (!isTranscriptNote(app, ctx.sourcePath)) return;
		const sourceOf = (): string | null => {
			const info = ctx.getSectionInfo(el);
			return info === null ? null : info.text.split("\n").slice(info.lineStart, info.lineEnd + 1).join("\n");
		};
		enhanceTurns(el, ctx.sourcePath, handlers, sourceOf);
	});
}
