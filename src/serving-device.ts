/**
 * The serving device's rules.
 *
 * A vault may name one device its serving device: a desktop or server that is
 * left running and takes over what the device that recorded did not finish.
 * The rules here are pure; `lifecycle.ts` applies them and the adapters do the
 * work.
 *
 * - **The grace period:** a serving device leaves a waiting recording to the
 *   device that made it for three minutes. For the transcriber step the time
 *   counts from `recorded`; for the agent step (#82 reuses this) from the
 *   moment the transcript was done, which is the last `transcriber-at`. It is
 *   a separate wait from the hand-off rule's two minutes, which come after the
 *   claim is written (`CLAIM_SETTLE_MS`): three minutes before a serving
 *   device starts, two more before it sends.
 * - **The claim:** after the grace period the serving device hands the note to
 *   its adapter like any device would. The adapter writes the transcriber (or
 *   agent) lines in the device's own name. Whoever writes first does the work:
 *   an adapter refuses a note already claimed for the attempt, and a serving
 *   device that wrote its claim waits two minutes, reads the note again and
 *   backs off if another device's claim is there.
 *   The request is taken as written: the mode's kind, address and model come
 *   from the vault's settings and only the key or the model files are this
 *   device's own.
 * - **Never a hand-off:** only `service` and `on-device` (for the agent step,
 *   `service`) are the serving device's to take. A hand-off request belongs to
 *   a program outside the plugin.
 * - **Letting go:** only the device that holds a claim lets it go. A device
 *   that finds its own send unanswered removes its own transcriber lines and
 *   raises `attempt` by one. No device releases another's claim.
 *
 * One serving device per vault is a line in the README (§ Devices and who does the work), not policed here.
 */

import type { DevicePort } from "./lifecycle";
import {
	markTaken,
	parseTimestamp,
	readInteger,
	readString,
	removeProperty,
	setProperty,
	type DerivedState,
	type TranscriptNote,
} from "./transcript-note";

/** Three minutes (spec's pick): how long the device that recorded goes first. */
export const SERVING_GRACE_MS = 3 * 60_000;

/**
 * How long a serving device waits after writing its claim before it reads the
 * note again (hand-off rule: "wait two minutes and read the note again"). The
 * vault is synced between devices and two claims can cross; the wait lets the
 * other's reach this device, and the one whose name is no longer on the note
 * backs off. This is on top of the three-minute grace period, which only keeps
 * a serving device from starting before the recording device had its turn.
 */
export const CLAIM_SETTLE_MS = 2 * 60_000;

/** Wait for `ms` milliseconds: what a serving device does between its claim and its second read. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The two steps of a recording a serving device can take. */
export type ClaimStep = "transcriber" | "agent";

/** The kinds a serving device may take, by step. Hand-off is never among them. */
const SERVED_KINDS: Record<ClaimStep, readonly string[]> = {
	transcriber: ["service", "on-device"],
	agent: ["service"],
};

/** Whether a request of this kind is one a serving device may take at all. */
export function isServedKind(step: ClaimStep, kind: string): boolean {
	return SERVED_KINDS[step].includes(kind);
}

/**
 * When the grace period for this step began, or `null` when the note does not
 * say (a timestamp that cannot be read is never held back by the grace
 * period). The transcriber's counts from `recorded`; the agent's from the
 * transcript's done time.
 */
export function graceStartedAt(note: TranscriptNote, step: ClaimStep): number | null {
	if (step === "transcriber") return parseTimestamp(readString(note, "recorded"));
	return parseTimestamp(readString(note, "transcriber-at"));
}

/** What the lifecycle knows when it asks whether to hold a step back. */
export interface ClaimQuestion {
	step: ClaimStep;
	kind: string;
	/** The step's derived state; only a waiting step is ever claimed. */
	state: DerivedState;
	note: TranscriptNote;
	now: Date;
	/** Whether this device is the vault's serving device. */
	serving: boolean;
	/** Whether this device made the recording itself, and so goes first. */
	madeHere: boolean;
}

/**
 * Whether a serving device must leave this step alone for now: it is a step
 * the device would take, it is still inside the grace period, and the device
 * did not make the recording itself. Everything else is not held back — the
 * device that recorded goes first, and an ordinary device behaves as it did.
 */
export function inGracePeriod(q: ClaimQuestion): boolean {
	if (!q.serving || q.madeHere) return false;
	if (!isServedKind(q.step, q.kind)) return false;
	const waiting = q.step === "transcriber" ? q.state.transcriber : q.state.agent;
	if (waiting !== "waiting") return false;
	const since = graceStartedAt(q.note, q.step);
	if (since === null) return false;
	return q.now.getTime() - since < SERVING_GRACE_MS;
}

/** The line that names the device that took a note, beside `transcriber`, which names it for people. */
export const CLAIM_DEVICE_LINE = "transcriber-device";

/** The properties a transcriber writes, taken off again when a claim is let go. */
export const TRANSCRIBER_LINES = [
	"transcriber",
	"transcriber-state",
	"transcriber-at",
	"transcriber-attempt",
	"transcriber-progress",
	"transcriber-reason",
	"transcriber-seconds",
	CLAIM_DEVICE_LINE,
] as const;

/** Who a device is: a stable id that is never shown, and the name people read. */
export interface DeviceIdentity {
	id: string;
	name: string;
}

/**
 * This device's identity. A device without an id of its own is told apart by
 * its name, which is all it has.
 */
export function identityOf(device: DevicePort): DeviceIdentity {
	const name = device.name();
	return { id: device.id?.() ?? name, name };
}

/**
 * Whether `who` wrote the claim on the note. A claim names its device by id, so
 * two devices on the same default name are two devices and a rename does not
 * strand a claim; a claim written before ids existed has only the name.
 */
export function claimedBy(note: TranscriptNote, who: DeviceIdentity): boolean {
	const id = readString(note, CLAIM_DEVICE_LINE);
	if (id !== undefined) return id === who.id;
	return readString(note, "transcriber") === who.name;
}

/**
 * Whether the note on disk is still this device's attempt: not cancelled, not
 * asked for again, and claimed by this device.
 */
export function stillClaimedBy(note: TranscriptNote, who: DeviceIdentity, attempt: number): boolean {
	return (
		(readInteger(note, "attempt") ?? 1) === attempt &&
		readString(note, "transcribe") !== "cancelled" &&
		claimedBy(note, who)
	);
}

/** The note with a claim written in `who`'s name and id: what an adapter writes to take a note. */
export function claimNote(note: TranscriptNote, who: DeviceIdentity, at: string): TranscriptNote {
	return setProperty(markTaken(note, { name: who.name, at }), CLAIM_DEVICE_LINE, who.id);
}

/**
 * Whether the note holds this device's own unanswered claim: it was taken by
 * this device for the note's current attempt and has not been answered.
 * Nobody else's claim is ever this device's to let go.
 */
export function holdsOwnClaim(note: TranscriptNote, who: DeviceIdentity): boolean {
	const attempt = readInteger(note, "attempt") ?? 1;
	return (
		claimedBy(note, who) &&
		readString(note, "transcriber-state") === "taken" &&
		readInteger(note, "transcriber-attempt") === attempt
	);
}

/**
 * Let go of this device's own claim: the transcriber lines come off and
 * `attempt` goes up by one, so an answer that still lands from the old send
 * belongs to an attempt that is over. The note is waiting again.
 */
export function letGoOfClaim(note: TranscriptNote): TranscriptNote {
	let next = note;
	for (const key of TRANSCRIBER_LINES) next = removeProperty(next, key);
	return setProperty(next, "attempt", String((readInteger(note, "attempt") ?? 1) + 1));
}
