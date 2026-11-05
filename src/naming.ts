/**
 * Naming speakers: the rules for turning `Speaker 2` into a
 * person, in a transcript note's text.
 *
 * Pure: a note in, a note out. The list that opens on a click, the playback on
 * a time click and the drawn "N speakers unnamed" line are views over these
 * functions (`speaker-picker.ts`, `turn-clicks.ts`, `note-drawing.ts`).
 *
 * A turn is one paragraph `[00:12:34] **Speaker 1:** text`, written by
 * `formatTurn`; its label is the words between the bold marks, without the
 * colon. A label is renamed throughout the body, the agent's section and the
 * transcript alike, so a note never says `Speaker 2` in one place and `Anna` in
 * another.
 *
 * What is written for a name is exactly what the choice said. The owner and a
 * participant are taken as the note lists them, `[[Anna Svensson]]` link and
 * all; a name typed by hand is plain text. The plugin never names anyone
 * itself: every function here is called by a person's click.
 */

import {
	SECTION_HEADINGS,
	readList,
	readString,
	removeProperty,
	setProperty,
	type TranscriptNote,
} from "./transcript-note";

/** A turn's label, found at the start of a line after its time. */
const TURN = /^\[(\d{2}):(\d{2}):(\d{2})\] \*\*(.+?):\*\* /gm;

/** `**Speaker 3:**` anywhere in the body, the spec's own test for an unnamed speaker. */
const UNNAMED = /\*\*Speaker (\d+):\*\*/g;

const UNNAMED_LABEL = /^Speaker \d+$/;

/** One turn as it stands in a body. */
export interface Turn {
	/** Where the turn starts, in seconds from the start of the recording. */
	seconds: number;
	/** The label exactly as written between the bold marks, `Speaker 2` or `[[Anna Svensson]]`. */
	label: string;
}

/** The turns in a body, in the order written. */
export function turnsIn(body: string): Turn[] {
	return [...body.matchAll(TURN)].map((m) => ({
		seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
		label: m[4],
	}));
}

/** What Obsidian draws for a label in reading view: a link with a heading shows `Name > Heading`. */
function renderedAs(label: string): string {
	const link = /^\[\[([^\]|]*)\]\]$/.exec(label);
	return link ? link[1].split("#").filter((part) => part !== "").join(" > ") : displayOf(label);
}

/** What a reader sees for a label: `[[Anna Svensson]]` shows `Anna Svensson`, `[[a|b]]` shows `b`. */
export function displayOf(label: string): string {
	const link = /^\[\[([^\]]*)\]\]$/.exec(label);
	if (!link) return label;
	const inner = link[1];
	const bar = inner.indexOf("|");
	return bar === -1 ? inner.split("#")[0] : inner.slice(bar + 1);
}

/**
 * The label of the turn at `seconds` in `source` as it is written there, for a
 * click in reading view, which only knows the words Obsidian shows
 * (`Anna Svensson > Work` for `[[Anna Svensson#Work]]`). When two turns start
 * the same second the one whose words match `shown` wins; when the source has
 * none, `shown` is returned as it came.
 */
export function writtenLabelAt(source: string, seconds: number, shown: string): string {
	const at = turnsIn(source).filter((turn) => turn.seconds === seconds);
	const exact = at.find((turn) => turn.label === shown || renderedAs(turn.label) === shown || displayOf(turn.label) === shown);
	return (exact ?? at[0])?.label ?? shown;
}

// --- Unnamed speakers ---------------------------------------------------------------

/** The numbered labels still in the body, `Speaker 1`, `Speaker 2`, in the order they first appear. */
export function unnamedLabels(note: TranscriptNote): string[] {
	const seen: string[] = [];
	for (const m of note.body.matchAll(UNNAMED)) {
		const label = `Speaker ${m[1]}`;
		if (!seen.includes(label)) seen.push(label);
	}
	return seen;
}

/** Whether the user said "leave the rest unnamed". */
export function isNamingFinished(note: TranscriptNote): boolean {
	return readString(note, "naming") === "finished";
}

/**
 * How many speakers are unnamed: the numbered labels left in the body, while
 * `naming` is not `finished`. The one number the note's line, the queue panel
 * and the "speakers unnamed" group all read.
 */
export function unnamedCount(note: TranscriptNote): number {
	return isNamingFinished(note) ? 0 : unnamedLabels(note).length;
}

// --- The list -------------------------------------------------------------------------

export interface SpeakerChoice {
	/** What is written in place of the label, exactly. */
	written: string;
	/** What a reader sees of it. */
	display: string;
	/** `owner`, a `participant` of the meeting note, or one of the `other` names already in this note. */
	group: "owner" | "participant" | "other";
}

/**
 * The list that opens on a click on `label`: the owner first, then the
 * participants not yet used, then the rest, which is every name already in the
 * note (a participant used, a typed name, a program's guess), so that choosing
 * one merges the two labels. A box for any name follows in the view.
 *
 * Neither the label being renamed nor any `Speaker N` is offered: neither is a
 * name. A name written the same way twice is offered once, at its first place.
 */
export function speakerChoices(note: TranscriptNote, label: string): SpeakerChoice[] {
	const renamed = labelsMatching(note, label);
	const inNote = [...new Set(turnsIn(note.body).map((turn) => turn.label))].filter(
		(candidate) => !UNNAMED_LABEL.test(candidate) && !renamed.includes(candidate),
	);

	const choices: SpeakerChoice[] = [];
	const offer = (written: string | undefined, group: SpeakerChoice["group"]): void => {
		if (written === undefined || written.trim() === "") return;
		if (renamed.includes(written) || choices.some((c) => c.written === written)) return;
		choices.push({ written, display: displayOf(written), group });
	};

	offer(readString(note, "owner"), "owner");
	const participants = readList(note, "participants") ?? [];
	for (const name of participants) if (!inNote.includes(name)) offer(name, "participant");
	for (const name of participants) if (inNote.includes(name)) offer(name, "other");
	for (const name of inNote) offer(name, "other");
	return choices;
}

/** The labels a click on `label` means: the label as written, or every label that shows the same words. */
function labelsMatching(note: TranscriptNote, label: string): string[] {
	const shown = displayOf(label);
	const found = new Set<string>();
	for (const turn of turnsIn(note.body)) {
		if (turn.label === label || displayOf(turn.label) === shown) found.add(turn.label);
	}
	if (UNNAMED_LABEL.test(label)) found.add(label);
	return [...found];
}

// --- A typed name ---------------------------------------------------------------------

export type TypedName = { ok: true; written: string } | { ok: false; reason: string };

/**
 * A name typed into the box: plain text. Blank space around it and inside it is
 * folded to single spaces. Asterisks and square brackets are refused, because
 * written into a bold label they would break it or turn a typed name into a
 * link, and a link is what choosing a participant is for. A backtick would open
 * a code span over the rest of the turn, a trailing backslash would escape the
 * label's colon, and `Speaker 3` would turn a named speaker back into an
 * unnamed one (or merge it with the real Speaker 3).
 */
export function typedName(input: string): TypedName {
	const written = input.replace(/\s+/g, " ").trim();
	if (written === "") return { ok: false, reason: "Type a name" };
	if (/[*[\]]/.test(written)) {
		return { ok: false, reason: "A typed name cannot hold * or [ ]; pick a participant from the list to link one" };
	}
	if (written.includes("`")) {
		return { ok: false, reason: "A typed name cannot hold a backtick; it would start a code span in the note" };
	}
	if (written.endsWith("\\")) {
		return { ok: false, reason: "A typed name cannot end in a backslash; it would cancel the colon after the name" };
	}
	if (UNNAMED_LABEL.test(written)) {
		return { ok: false, reason: "A typed name cannot be Speaker and a number; that is how an unnamed speaker is written" };
	}
	return { ok: true, written };
}

// --- Writing ---------------------------------------------------------------------------

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace a speaker's label throughout the body, with `written` exactly.
 *
 * Every turn label (and every `**Speaker N:**` anywhere) that is `label`, or
 * shows the same words as it, is replaced; so is a bare `Speaker N` in the
 * agent's section, which a summary writes in running text. Nowhere else: what
 * somebody said in a turn ("Speaker 1 is muted") is the transcript's own words.
 * A name is replaced only as a label: a program's guess `Anna` changes in
 * `**Anna:**` and never in a sentence somebody spoke. Giving two labels one name is two calls with the
 * same `written`, and merges them.
 *
 * Returns the note unchanged when the label is not in it.
 */
export function renameSpeaker(
	note: TranscriptNote,
	label: string,
	written: string,
): TranscriptNote {
	const matched = labelsMatching(note, label);
	if (matched.length === 0) return note;

	const bold = new RegExp(matched.map((l) => `\\*\\*${escapeRegex(l)}:\\*\\*`).join("|"), "g");
	let body = note.body.replace(bold, () => `**${written}:**`);

	const numbered = matched.filter((l) => UNNAMED_LABEL.test(l));
	if (numbered.length > 0) {
		const bare = new RegExp(numbered.map((l) => `(?<!\\w)${escapeRegex(l)}(?!\\w)`).join("|"), "g");
		body = mapAgentSection(body, (text) => replaceInProse(text, bare, written));
	}
	return body === note.body ? note : { ...note, body };
}

/**
 * Text that is not prose: a wikilink, a markdown link's URL, a code span. A bare
 * `Speaker N` inside one of these is a target or code, not a mention.
 */
const NOT_PROSE = /\[\[[^\]]*\]\]|\]\([^)]*\)|(`+)[^]*?\1(?!`)/g;

/** Replace each match of `pattern` in `text` with `written`, except inside links and code. */
function replaceInProse(text: string, pattern: RegExp, written: string): string {
	let out = "";
	let from = 0;
	for (const skip of text.matchAll(NOT_PROSE)) {
		out += text.slice(from, skip.index).replace(pattern, () => written) + skip[0];
		from = skip.index + skip[0].length;
	}
	return out + text.slice(from).replace(pattern, () => written);
}

/** Apply `change` to the agent's section of a body, heading excluded, and leave every other line as it was. */
function mapAgentSection(body: string, change: (text: string) => string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => l.trimEnd() === SECTION_HEADINGS.agent);
	if (start === -1) return body;
	const after = lines.findIndex((l, i) => i > start && l.trimEnd() === SECTION_HEADINGS.transcript);
	const end = after === -1 ? lines.length : after;
	const changed = change(lines.slice(start + 1, end).join("\n"));
	return [...lines.slice(0, start + 1), changed, ...lines.slice(end)].join("\n");
}

/** "Leave the rest unnamed": `naming: finished`, written by the plugin. */
export function leaveRestUnnamed(note: TranscriptNote): TranscriptNote {
	return setProperty(note, "naming", "finished");
}

/** Try again: the property goes, so the new transcript's speakers are asked about afresh. */
export function clearNaming(note: TranscriptNote): TranscriptNote {
	return removeProperty(note, "naming");
}

/** Whether any turn is labelled with something other than `Speaker N`: a name from the user or one the transcriber wrote. */
export function hasNamedSpeakers(note: TranscriptNote): boolean {
	return turnsIn(note.body).some((turn) => !UNNAMED_LABEL.test(turn.label));
}

/**
 * Whether a new transcript would undo naming: a named label (whoever wrote it,
 * the note does not record that) or a "leave the rest unnamed" already said.
 */
export function hasGivenNames(note: TranscriptNote): boolean {
	return isNamingFinished(note) || hasNamedSpeakers(note);
}
