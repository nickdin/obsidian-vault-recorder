/**
 * What to draw for a transcript note: the state line, and the text that goes
 * with it once it exists. Pure — the notes' text in, words out — so every state
 * is tested without Obsidian; `note-drawing.ts` puts the words on screen.
 *
 * The words are the spec's: "waiting since 14:02", "being
 * transcribed, 40 %", "failed: <reason>", "done without speaker split". Times
 * are written in the reader's own zone, with the date added when it is not
 * today, so a recording that has waited since last week does not read as one
 * from this morning.
 */

import { unnamedCount } from "./naming";
import {
	parseTimestamp,
	readInteger,
	readSection,
	readString,
	type DerivedState,
	type TranscriptNote,
} from "./transcript-note";

/** What the lifecycle knows about a note (a `NoteStatus` without its path). */
export interface DrawnStatus {
	state: DerivedState;
	/** The lifecycle's per-device waiting reason, drawn exactly as given. */
	waitingReason: string | null;
}

/** The clock the words are written against. */
export interface DrawClock {
	now: Date;
	/** Minutes east of UTC at `at`, as `ClockPort.utcOffsetMinutes` gives it. */
	utcOffsetMinutes(at: Date): number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * `14:02` for a moment today, `2026-10-17 08:00` for any other day, both in
 * the clock's own zone.
 */
export function clockWords(atMs: number, clock: DrawClock): string {
	const at = new Date(atMs);
	const shifted = new Date(atMs + clock.utcOffsetMinutes(at) * 60_000);
	const today = new Date(clock.now.getTime() + clock.utcOffsetMinutes(clock.now) * 60_000);
	const date = (d: Date): string =>
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
	return date(shifted) === date(today) ? time : `${date(shifted)} ${time}`;
}

/**
 * When the note started waiting: the later of `recorded` and `transcriber-at`,
 * the same moment `deriveState` measures "overdue" from, so the two never
 * disagree about how long a recording has waited.
 */
function waitingSince(note: TranscriptNote): number | null {
	const recorded = parseTimestamp(readString(note, "recorded"));
	const answered = parseTimestamp(readString(note, "transcriber-at"));
	if (recorded === null) return answered;
	if (answered === null) return recorded;
	return Math.max(recorded, answered);
}

/** The one line that says where a recording stands. */
export function stateLine(note: TranscriptNote, status: DrawnStatus, clock: DrawClock): string {
	const { state } = status;
	let line: string;
	switch (state.transcriber) {
		case "waiting": {
			const since = waitingSince(note);
			line = since === null ? "waiting" : `waiting since ${clockWords(since, clock)}`;
			if (status.waitingReason) line += ` — ${status.waitingReason}`;
			break;
		}
		case "being-transcribed": {
			const progress = readInteger(note, "transcriber-progress");
			line =
				progress === undefined
					? "being transcribed"
					: `being transcribed, ${Math.min(100, Math.max(0, progress))} %`;
			break;
		}
		case "done":
			line = "done";
			break;
		case "done-without-speaker-split":
			line = "done without speaker split";
			break;
		case "failed": {
			const reason = readString(note, "transcriber-reason");
			line = reason ? `failed: ${reason}` : "failed";
			break;
		}
		case "cancelled":
			line = "cancelled";
			break;
		case "unknown-rule-version":
			line = "this note's rule version is not one this plugin knows";
			break;
	}
	if (state.transcriberOverdue) line += " (overdue)";
	const agent = agentWords(note, status);
	return agent === null ? line : `${line} — ${agent}`;
}

/**
 * Where the agent stands, once the transcript has arrived: nothing for no agent
 * or an agent that has answered, which the section itself shows.
 */
function agentWords(note: TranscriptNote, status: DrawnStatus): string | null {
	const { state } = status;
	if (state.transcriber !== "done" && state.transcriber !== "done-without-speaker-split") return null;
	let words: string;
	switch (state.agent) {
		case "waiting":
			words = status.waitingReason ? `agent waiting — ${status.waitingReason}` : "agent waiting";
			break;
		case "working":
			words = "agent working";
			break;
		case "failed": {
			const reason = readString(note, "agent-reason");
			words = reason ? `agent failed: ${reason}` : "agent failed";
			break;
		}
		default:
			return null;
	}
	return state.agentOverdue ? `${words} (overdue)` : words;
}

/** Everything drawn for one transcript note. */
export interface TextToDraw {
	stateLine: string;
	/** The agent section's text, once an agent has answered. */
	agent: string | null;
	/** The transcript text, once it exists. */
	transcript: string | null;
}

/** The state line, and the agent and transcript text where they exist. */
export function textToDraw(
	note: TranscriptNote,
	status: DrawnStatus,
	clock: DrawClock,
): TextToDraw {
	const section = (name: "agent" | "transcript"): string | null => {
		const text = readSection(note, name);
		return text === undefined || text.trim() === "" ? null : text;
	};
	return {
		stateLine: stateLine(note, status, clock),
		agent: section("agent"),
		transcript: section("transcript"),
	};
}

// --- Actions ------------------------------------------------------------------------

/**
 * The things a person does to a recording by hand (`lifecycle-actions.ts`): the
 * first three change the request, the last two name its speakers (`naming.ts`).
 */
export type RecordingAction =
	| "cancel"
	| "try-again"
	| "transcribe"
	| "name-speakers"
	| "leave-unnamed"
	| "run-agent"
	| "cancel-agent";

export interface ActionOffer {
	action: RecordingAction;
	label: string;
}

/**
 * What the state line offers for a note, and why "try again" is missing when
 * the audio is gone (spec #69 § 7: "Try again is not offered once the audio is
 * gone, and the note says why").
 *
 * Cancel: waiting or being transcribed. Try again: failed, done, done without
 * speaker split, or overdue (a claim nobody released "waits for try again",
 * § 5). Transcribe: a cancelled recording whose audio is still there (#84: a
 * by-hand delete cancels a waiting recording, and a request marked
 * `audio-deleted` is never transcribed).
 */
export function actionsFor(
	note: TranscriptNote,
	state: DerivedState,
): { offers: ActionOffer[]; notOffered: string | null } {
	const offers: ActionOffer[] = [];
	const t = state.transcriber;
	if (t === "waiting" || t === "being-transcribed") {
		offers.push({ action: "cancel", label: "Cancel" });
	}
	const canRetry =
		t === "failed" ||
		t === "done" ||
		t === "done-without-speaker-split" ||
		state.transcriberOverdue;
	const deleted = readString(note, "audio-deleted");
	let notOffered: string | null = null;
	if (canRetry) {
		if (deleted === undefined) offers.push({ action: "try-again", label: "Try again" });
		else notOffered = `Try again is not offered: the audio was deleted ${deleted}`;
	}
	if (t === "cancelled" && deleted === undefined) offers.push({ action: "transcribe", label: "Transcribe" });
	return { offers, notOffered };
}

// --- Naming speakers ---------------------------------------------------------------

/**
 * How many speakers are unnamed in a transcript that has arrived. A transcript
 * still to come, or being redone, is not named yet: its old text is about to be
 * replaced, so asking about its speakers would be asking about nothing.
 */
export function speakersToName(note: TranscriptNote, state: DerivedState): number {
	const arrived = state.transcriber === "done" || state.transcriber === "done-without-speaker-split";
	return arrived ? unnamedCount(note) : 0;
}

/** The line drawn at the top of the note and under the recording: "2 speakers unnamed — name them". */
export function unnamedLine(count: number): string | null {
	if (count <= 0) return null;
	return `${count} ${count === 1 ? "speaker" : "speakers"} unnamed — name them`;
}

/** The buttons that go with that line: name the first speaker, or leave the rest. */
export function namingOffers(note: TranscriptNote, state: DerivedState): ActionOffer[] {
	if (speakersToName(note, state) === 0) return [];
	return [
		{ action: "name-speakers", label: "Name speakers" },
		{ action: "leave-unnamed", label: "Leave the rest unnamed" },
	];
}

// --- The agent --------------------------------------------------------------------------

/**
 * "Cancel agent" while the agent is waiting or working, so naming by hand is
 * never stuck behind an agent that cannot answer on any device.
 *
 * "Run the agent again" is a separate offer, made once the agent has answered
 * (done or failed), was cancelled, or has gone overdue. Before any agent line there is nothing
 * to run again; the command palette's entry covers a note the plugin never asked
 * an agent about.
 */
export function agentOffers(state: DerivedState): ActionOffer[] {
	const arrived = state.transcriber === "done" || state.transcriber === "done-without-speaker-split";
	const again =
		state.agent === "done" || state.agent === "failed" || state.agent === "cancelled" || state.agentOverdue;
	const offers: ActionOffer[] = [];
	if (state.agent === "waiting" || state.agent === "working") {
		offers.push({ action: "cancel-agent", label: "Cancel agent" });
	}
	if (arrived && again) offers.push({ action: "run-agent", label: "Run agent again" });
	return offers;
}
