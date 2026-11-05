/**
 * What the queue panel shows: the transcript notes sorted into groups, each
 * row with its place in line, its meter and rough time left, and the actions
 * that apply. Pure — notes and a clock in, groups out — so every group and
 * every number is tested without Obsidian; `queue-panel.ts` draws the result.
 *
 * Spec #69 § 6. The groups are one table, `GROUPS`: a later ticket (speakers
 * unnamed, the agent's groups, audio held) adds a row to it and nothing else
 * here changes. Its order is the order the panel shows them in and also the
 * order a row is tried against them: a row lands in the first group that
 * claims it, so it is shown once.
 */

import {
	actionsFor,
	agentOffers,
	namingOffers,
	speakersToName,
	stateLine,
	type ActionOffer,
	type DrawClock,
} from "./state-line";
import { audioFate, fateContextFor, keepOffers, type KeepOffer } from "./keep-time";
import type { VaultRecorderSettings } from "./settings-data";
import {
	deriveState,
	parseTimestamp,
	readInteger,
	readString,
	type DerivedState,
	type TranscriptNote,
} from "./transcript-note";

const HOUR_MS = 3_600_000;

/** The transcript is text: done, or done with a failed speaker split. */
const transcriptArrived = (row: QueueRow): boolean =>
	row.state.transcriber === "done" || row.state.transcriber === "done-without-speaker-split";

/** One transcript note as the panel is handed it. */
export interface QueueNote {
	path: string;
	note: TranscriptNote;
	/** The lifecycle's per-device waiting reason, drawn as given. */
	waitingReason: string | null;
}

/** A progress percentage and the moment it was read. */
export interface ProgressReading {
	percent: number;
	atMs: number;
}

/** Everything the panel draws for one transcript note. */
export interface QueueRow {
	path: string;
	/** The note's file name without `.md`, which is the recording's own name. */
	title: string;
	/** The one line that says where it stands, as the note itself shows it. */
	line: string;
	state: DerivedState;
	/** 1 for the next recording to be taken; `null` unless the transcriber is waiting. */
	placeInLine: number | null;
	/** 0–100 while being transcribed, else `null`. */
	percent: number | null;
	/** Rough milliseconds left, or `null` when two readings do not say. */
	timeLeftMs: number | null;
	/** Speakers still named only by number, while naming is not finished; 0 until the transcript is done. */
	unnamed: number;
	offers: Array<ActionOffer | KeepOffer>;
	/** Why "try again" is missing, when it is. */
	notOffered: string | null;
	/** When the group sorts by time: the moment that matters for the row. */
	sinceMs: number | null;
	/** Why the audio is kept past its keep time, or `null`. A hold that only waits for the transcript is not repeated here. */
	audioHeld: string | null;
}

export interface QueueGroup {
	id: string;
	title: string;
	rows: QueueRow[];
}

interface GroupDef {
	id: string;
	title: string;
	/** True for a row that belongs in this group. */
	claims(row: QueueRow, now: Date): boolean;
	/** Oldest first, or newest first. */
	order: "oldest-first" | "newest-first";
}

/** The groups, in the order shown. A later ticket adds its group here. */
export const GROUPS: readonly GroupDef[] = [
	{
		id: "waiting",
		title: "Waiting",
		claims: (row) => row.state.transcriber === "waiting" && !row.state.transcriberOverdue,
		order: "oldest-first",
	},
	{
		id: "being-transcribed",
		title: "Being transcribed",
		claims: (row) =>
			row.state.transcriber === "being-transcribed" && !row.state.transcriberOverdue,
		order: "oldest-first",
	},
	{
		id: "overdue",
		title: "Overdue",
		claims: (row) => row.state.transcriberOverdue,
		order: "oldest-first",
	},
	{
		id: "failed",
		title: "Failed",
		claims: (row) => row.state.transcriber === "failed",
		order: "newest-first",
	},
	// The agent's groups come before the groups for a finished transcript: a row
	// whose transcript is done but whose agent is working, failed or late is shown
	// by what the user can do about the agent. They claim only a row whose
	// transcript is done: one being redone or cancelled is shown by that.
	{
		id: "agent-overdue",
		title: "Agent overdue",
		claims: (row) => transcriptArrived(row) && row.state.agentOverdue,
		order: "oldest-first",
	},
	{
		id: "agent-working",
		title: "Agent working",
		claims: (row) => transcriptArrived(row) && row.state.agent === "working",
		order: "oldest-first",
	},
	{
		id: "agent-failed",
		title: "Agent failed",
		claims: (row) => transcriptArrived(row) && row.state.agent === "failed",
		order: "newest-first",
	},
	{
		id: "done-without-speaker-split",
		title: "Done without speaker split",
		// A note with a Speaker N still in it belongs to "speakers unnamed":
		// the first group that claims a row wins, and naming is what the user can do.
		claims: (row) => row.state.transcriber === "done-without-speaker-split" && row.unnamed === 0,
		order: "newest-first",
	},
	{
		id: "cancelled",
		title: "Cancelled",
		claims: (row) => row.state.transcriber === "cancelled",
		order: "newest-first",
	},
	{
		id: "speakers-unnamed",
		title: "Speakers unnamed",
		claims: (row) => row.unnamed > 0,
		order: "oldest-first",
	},
	{
		id: "finished-last-day",
		title: "Finished in the last 24 hours",
		claims: (row, now) =>
			row.state.transcriber === "done" &&
			row.sinceMs !== null &&
			now.getTime() - row.sinceMs <= 24 * HOUR_MS,
		order: "newest-first",
	},
	{
		id: "audio-held",
		title: "Audio held",
		claims: (row) => row.audioHeld !== null,
		order: "oldest-first",
	},
];

// --- Time left ---------------------------------------------------------------------

/**
 * Rough milliseconds left, from how fast the percentage moved between two
 * readings. `null` when the readings cannot say: no time passed, the
 * percentage did not rise, or it is already 100.
 */
export function timeLeftMs(earlier: ProgressReading, later: ProgressReading): number | null {
	const gained = later.percent - earlier.percent;
	const elapsed = later.atMs - earlier.atMs;
	if (gained <= 0 || elapsed <= 0 || later.percent >= 100) return null;
	return Math.round(((100 - later.percent) * elapsed) / gained);
}

/** "about 12 min left", "about 2 h 5 min left", "less than a minute left". */
export function timeLeftWords(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "less than a minute left";
	if (minutes < 60) return `about ${minutes} min left`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `about ${hours} h left` : `about ${hours} h ${rest} min left`;
}

/**
 * What the panel has seen of each note being transcribed, so a second reading
 * exists. The first reading is 0 % at the moment the note was taken
 * (`transcriber-at`); the second is the percentage the note shows, at the time
 * the panel first saw that percentage, since a progress write does not move
 * `transcriber-at`. A new take (a different `transcriber-at`) or a falling
 * percentage starts over.
 */
export class ProgressMemory {
	private readonly seen = new Map<
		string,
		{ takenAtMs: number; first: ProgressReading; latest: ProgressReading }
	>();

	/** Record what the note shows at `nowMs`; returns the estimate it allows. */
	observe(path: string, takenAtMs: number, percent: number, nowMs: number): number | null {
		const known = this.seen.get(path);
		if (!known || known.takenAtMs !== takenAtMs || percent < known.latest.percent) {
			const first = { percent: 0, atMs: takenAtMs };
			const latest = { percent, atMs: nowMs };
			this.seen.set(path, { takenAtMs, first, latest });
			return timeLeftMs(first, latest);
		}
		if (percent !== known.latest.percent) known.latest = { percent, atMs: nowMs };
		return timeLeftMs(known.first, known.latest);
	}

	/** Forget notes that are no longer being transcribed. */
	keepOnly(paths: ReadonlySet<string>): void {
		for (const path of [...this.seen.keys()]) if (!paths.has(path)) this.seen.delete(path);
	}
}

// --- Building the groups -----------------------------------------------------------

export interface QueueInput {
	notes: readonly QueueNote[];
	clock: DrawClock;
	overdueHours: number;
	progress: ProgressMemory;
	/** The live settings: the keep time and each mode's transcriber decide whether audio is held. */
	settings: VaultRecorderSettings;
}

/** When a waiting note started waiting: the later of `recorded` and `transcriber-at`. */
function waitingSinceMs(note: TranscriptNote): number | null {
	const recorded = parseTimestamp(readString(note, "recorded"));
	const answered = parseTimestamp(readString(note, "transcriber-at"));
	if (recorded === null) return answered;
	if (answered === null) return recorded;
	return Math.max(recorded, answered);
}

/** The moment that orders a row inside its group. */
function sinceOf(note: TranscriptNote, state: DerivedState): number | null {
	if (state.transcriber === "waiting") return waitingSinceMs(note);
	return (
		parseTimestamp(readString(note, "transcriber-at")) ??
		parseTimestamp(readString(note, "recorded"))
	);
}

const titleOf = (path: string): string =>
	path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/** Sort the notes into the groups; groups with no rows are left out. */
export function buildQueue(input: QueueInput): QueueGroup[] {
	const { clock, overdueHours, progress, settings } = input;
	const now = clock.now;

	const rows: QueueRow[] = input.notes.map(({ path, note, waitingReason }) => {
		const state = deriveState(note, now, overdueHours);
		const { offers, notOffered } = actionsFor(note, state);
		const fate = audioFate(note, state, fateContextFor(note, settings));
		let percent: number | null = null;
		let left: number | null = null;
		if (state.transcriber === "being-transcribed") {
			const reported = readInteger(note, "transcriber-progress");
			percent = reported === undefined ? 0 : Math.min(100, Math.max(0, reported));
			const takenAt = parseTimestamp(readString(note, "transcriber-at"));
			if (takenAt !== null) left = progress.observe(path, takenAt, percent, now.getTime());
		}
		return {
			path,
			title: titleOf(path),
			line: stateLine(note, { state, waitingReason }, clock),
			state,
			placeInLine: null,
			percent,
			timeLeftMs: left,
			unnamed: speakersToName(note, state),
			offers: [...offers, ...namingOffers(note, state), ...agentOffers(state), ...keepOffers(note)],
			notOffered,
			sinceMs: sinceOf(note, state),
			audioHeld: fate.kind === "held" && !fate.pending ? fate.reason : null,
		};
	});
	progress.keepOnly(new Set(rows.filter((r) => r.percent !== null).map((r) => r.path)));

	// Place in line counts every recording the transcriber has not yet taken,
	// overdue ones included, oldest first.
	const byAge = (a: QueueRow, b: QueueRow): number =>
		(a.sinceMs ?? Infinity) - (b.sinceMs ?? Infinity) || a.path.localeCompare(b.path);
	rows
		.filter((row) => row.state.transcriber === "waiting")
		.sort(byAge)
		.forEach((row, index) => {
			row.placeInLine = index + 1;
		});

	return GROUPS.flatMap((group) => {
		const claimed = rows.filter(
			(row) => GROUPS.find((candidate) => candidate.claims(row, now)) === group,
		);
		if (claimed.length === 0) return [];
		claimed.sort((a, b) => (group.order === "oldest-first" ? byAge(a, b) : byAge(b, a)));
		return [{ id: group.id, title: group.title, rows: claimed }];
	});
}
