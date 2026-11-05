/**
 * What a press at one column of a turn's source line means: on
 * the time it plays, on the bold label it names. Pure, so Live Preview's
 * handler in `turn-clicks.ts` is only the mouse around it.
 */

const TURN_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\] \*\*(.+?):\*\* /;
const TIME_WIDTH = "[00:00:00]".length;

export type TurnTarget = { kind: "time"; seconds: number } | { kind: "label"; label: string };

/** The target at `column` of `line`, or `null` for the spoken text and for a line that is no turn. */
export function turnTargetAt(line: string, column: number): TurnTarget | null {
	const turn = TURN_LINE.exec(line);
	if (!turn) return null;
	if (column <= TIME_WIDTH) {
		return { kind: "time", seconds: Number(turn[1]) * 3600 + Number(turn[2]) * 60 + Number(turn[3]) };
	}
	const labelStart = TIME_WIDTH + 1;
	const labelEnd = labelStart + `**${turn[4]}:**`.length;
	return column >= labelStart && column < labelEnd ? { kind: "label", label: turn[4] } : null;
}
