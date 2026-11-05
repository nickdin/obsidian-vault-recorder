/**
 * Names the person gave while a hand-off agent was still answering.
 *
 * A hand-off program reads the transcript, works, and writes its answer later,
 * from the note it read earlier, so its `## Agent` section can say `Speaker 2`
 * for someone the person has since named. The note does not record which number
 * became which name, so the lifecycle remembers the numbered turns it saw while
 * the agent had not answered, and when the answer lands, names the labels whose
 * every remembered turn now reads the same name.
 */

import { renameSpeaker, turnsIn } from "./naming";
import type { TranscriptNote } from "./transcript-note";

/**
 * The numbered labels seen before any naming: the transcript they belong to, and
 * each turn's label by its position in the body. A position, not a start second,
 * because two turns may start in the same second (`writtenLabelAt`); naming
 * rewrites labels in place and never adds or removes a turn, so a position keeps
 * naming the same turn.
 */
export interface SeenLabels {
	transcriptAt: string;
	byTurn: Map<number, string>;
}

const NUMBERED = /^Speaker \d+$/;

/** `seen` with the numbered turns of `note` added; a turn already remembered keeps its first label. */
export function rememberNumbered(seen: SeenLabels | undefined, note: TranscriptNote, transcriptAt: string): SeenLabels {
	const kept = seen !== undefined && seen.transcriptAt === transcriptAt ? seen : { transcriptAt, byTurn: new Map<number, string>() };
	turnsIn(note.body).forEach((turn, index) => {
		if (NUMBERED.test(turn.label) && !kept.byTurn.has(index)) kept.byTurn.set(index, turn.label);
	});
	return kept;
}

/** Each numbered label whose every remembered turn now carries one and the same name, with that name. */
export function namesGiven(seen: SeenLabels, note: TranscriptNote): Map<string, string> {
	const now = turnsIn(note.body).map((turn) => turn.label);
	const names = new Map<string, Set<string>>();
	for (const [index, label] of seen.byTurn) {
		const current = now[index] ?? label;
		const found = names.get(label) ?? new Set<string>();
		found.add(NUMBERED.test(current) ? "" : current);
		names.set(label, found);
	}
	const given = new Map<string, string>();
	for (const [label, found] of names) {
		const [only] = found;
		if (found.size === 1 && only !== "") given.set(label, only);
	}
	return given;
}

/** `note` with every name the person gave since `seen` written over the numbered label in the agent's answer. */
export function withNamesGiven(note: TranscriptNote, seen: SeenLabels): TranscriptNote {
	let named = note;
	for (const [label, name] of namesGiven(seen, note)) named = renameSpeaker(named, label, name);
	return named;
}
