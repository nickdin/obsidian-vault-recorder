/**
 * The transcript note: one note per recording, holding the request for a
 * transcript, the transcriber's and agent's answers, and the text itself.
 *
 * Pure: text in, text out. No Obsidian import, no clock of its own, no vault.
 * The words of the note — property names, state words, section headings, the
 * turn shape — are the hand-off rule (`docs/hand-off-rule.md`), fixed English,
 * copied from the spec's property block character for character. A program
 * written to that document and this module read and write the same notes; the
 * fixtures in `docs/hand-off-fixtures/` are what keeps both honest.
 *
 * A note is its properties (in file order, each kept exactly as written) and a
 * body. Reading and writing a property never reformats the others, so a note
 * survives a round trip byte for byte.
 */

import { AGENT_KINDS, TRANSCRIBER_KINDS, type AgentKind, type RecordingModeKey, type TranscriberKind } from "./settings-data";

/** The rule version this module writes and understands. */
export const RULE_VERSION = 1;

/** The mode words as they are written into a note. */
export type TranscriptMode = "daily-log" | "cursor" | "meeting";

export const MODE_WORDS: Record<RecordingModeKey, TranscriptMode> = {
	dailyLog: "daily-log",
	cursor: "cursor",
	meeting: "meeting",
};

/** The two section headings, fixed. */
export const SECTION_HEADINGS = {
	agent: "## Agent",
	transcript: "## Transcript",
} as const;

export type SectionName = keyof typeof SECTION_HEADINGS;

/**
 * Every property of the rule, in the order a note lists them. Properties
 * written later are inserted at their place in this order, so the same facts
 * always produce the same bytes.
 */
export const PROPERTY_ORDER = [
	// written by the plugin at stop, and on cancel / try again
	"rule-version",
	"audio",
	"audio-bytes",
	"mode",
	"recorded",
	"linked-from",
	"speaker-split",
	"participants",
	"owner",
	"language",
	"attempt",
	"transcribe",
	"transcribe-kind",
	// written by the transcriber
	"transcriber",
	"transcriber-state",
	"transcriber-at",
	"transcriber-progress",
	"transcriber-attempt",
	"transcriber-reason",
	"transcriber-seconds",
	// written by the plugin when the transcript is done and an agent is chosen
	"agent",
	"agent-kind",
	"agent-attempt",
	"agent-for",
	"agent-requested-at",
	// written by the agent
	"agent-by",
	"agent-state",
	"agent-at",
	"agent-attempt-answered",
	"agent-reason",
	// written by the plugin only, later
	"naming",
	"keep-audio",
	"audio-deleted",
] as const;

/** One property as written: its key and the lines it occupies. */
export interface NoteProperty {
	key: string;
	/** The first line is `key: value`; a block list adds `  - item` lines. */
	lines: string[];
}

export interface TranscriptNote {
	properties: NoteProperty[];
	/** Everything after the closing `---` line, as written. */
	body: string;
}

// --- Reading and writing text ---------------------------------------------------

/**
 * Read a note's text. Returns `null` for a note without a `rule-version`
 * property — it is not the plugin's, and nothing here goes near it.
 */
export function parseTranscriptNote(text: string): TranscriptNote | null {
	if (!text.startsWith("---\n")) return null;
	const close = text.indexOf("\n---\n", 3);
	const closeAtEnd = text.endsWith("\n---") && close === -1;
	if (close === -1 && !closeAtEnd) return null;
	const head = text.slice(4, close === -1 ? text.length - 4 : close);
	const body = close === -1 ? "" : text.slice(close + 5);

	const properties: NoteProperty[] = [];
	const keyLine = /^([A-Za-z0-9_-]+):(?:\s.*|)$/;
	for (const line of head === "" ? [] : head.split("\n")) {
		const match = keyLine.exec(line);
		if (match) {
			properties.push({ key: match[1], lines: [line] });
		} else if (properties.length > 0) {
			properties[properties.length - 1].lines.push(line);
		} else {
			return null;
		}
	}
	if (!properties.some((p) => p.key === "rule-version")) return null;
	return { properties, body };
}

export function serializeTranscriptNote(note: TranscriptNote): string {
	const head = note.properties.flatMap((p) => p.lines).join("\n");
	return `---\n${head}\n---\n${note.body}`;
}

// --- Reading values ---------------------------------------------------------------

function property(note: TranscriptNote, key: string): NoteProperty | undefined {
	return note.properties.find((p) => p.key === key);
}

/** A property's value: a string, a list of strings, or `undefined` when absent. */
export function readProperty(
	note: TranscriptNote,
	key: string,
): string | string[] | undefined {
	const found = property(note, key);
	if (!found) return undefined;
	const rest = found.lines[0].slice(key.length + 1).trim();
	if (rest === "") {
		const items = found.lines
			.slice(1)
			.map((line) => /^\s*-\s+(.*)$/.exec(line))
			.filter((m): m is RegExpExecArray => m !== null)
			.map((m) => parseScalar(m[1]));
		return items.length > 0 ? items : "";
	}
	if (rest.startsWith("[")) return parseFlowList(rest);
	return parseScalar(rest);
}

export function readString(note: TranscriptNote, key: string): string | undefined {
	const value = readProperty(note, key);
	return typeof value === "string" ? value : undefined;
}

export function readList(note: TranscriptNote, key: string): string[] | undefined {
	const value = readProperty(note, key);
	return Array.isArray(value) ? value : undefined;
}

export function readInteger(note: TranscriptNote, key: string): number | undefined {
	const value = readString(note, key);
	return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined;
}

export function readBoolean(note: TranscriptNote, key: string): boolean | undefined {
	const value = readString(note, key);
	return value === "true" ? true : value === "false" ? false : undefined;
}

/** A scalar as written: quoted with `"` or `'`, or plain with an optional ` # comment`. */
function parseScalar(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith('"')) return readDoubleQuoted(trimmed, 0).value;
	if (trimmed.startsWith("'")) return readSingleQuoted(trimmed, 0).value;
	const comment = trimmed.indexOf(" #");
	return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

function readDoubleQuoted(text: string, start: number): { value: string; end: number } {
	let value = "";
	let i = start + 1;
	for (; i < text.length && text[i] !== '"'; i++) {
		if (text[i] === "\\" && i + 1 < text.length) {
			i++;
			value += text[i] === "n" ? "\n" : text[i] === "t" ? "\t" : text[i];
		} else {
			value += text[i];
		}
	}
	return { value, end: i + 1 };
}

function readSingleQuoted(text: string, start: number): { value: string; end: number } {
	let value = "";
	let i = start + 1;
	for (; i < text.length; i++) {
		if (text[i] === "'") {
			if (text[i + 1] === "'") {
				value += "'";
				i++;
			} else {
				break;
			}
		} else {
			value += text[i];
		}
	}
	return { value, end: i + 1 };
}

function parseFlowList(text: string): string[] {
	const items: string[] = [];
	let i = 1;
	while (i < text.length && text[i] !== "]") {
		while (text[i] === " " || text[i] === ",") i++;
		if (text[i] === "]" || i >= text.length) break;
		if (text[i] === '"') {
			const read = readDoubleQuoted(text, i);
			items.push(read.value);
			i = read.end;
		} else if (text[i] === "'") {
			const read = readSingleQuoted(text, i);
			items.push(read.value);
			i = read.end;
		} else {
			let end = i;
			while (end < text.length && text[end] !== "," && text[end] !== "]") end++;
			items.push(text.slice(i, end).trim());
			i = end;
		}
	}
	return items;
}

// --- Writing values -----------------------------------------------------------------

/** A string in double quotes, with `\`, `"` and newlines escaped. */
export function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** A list in flow style, every item quoted: `["a", "b"]`. */
export function flowList(items: readonly string[]): string {
	return `[${items.map(quote).join(", ")}]`;
}

/** A wiki link to `target`, quoted so YAML does not read `[[` as a list: `"[[target]]"`. */
export function quotedLink(target: string): string {
	return quote(`[[${target}]]`);
}

/**
 * Set a property to `raw`, the text after `key: `. An existing property is
 * replaced where it stands; a new one goes in at its place in `PROPERTY_ORDER`.
 */
export function setProperty(
	note: TranscriptNote,
	key: string,
	raw: string,
): TranscriptNote {
	const written: NoteProperty = { key, lines: [`${key}: ${raw}`] };
	const index = note.properties.findIndex((p) => p.key === key);
	if (index !== -1) {
		const properties = [...note.properties];
		properties[index] = written;
		return { ...note, properties };
	}
	const rank = (k: string): number => PROPERTY_ORDER.indexOf(k as never);
	const mine = rank(key);
	let insertAt = note.properties.length;
	if (mine !== -1) {
		let lastBefore = -1;
		let firstAfter = -1;
		note.properties.forEach((p, i) => {
			const theirs = rank(p.key);
			if (theirs === -1) return;
			if (theirs < mine) lastBefore = i;
			else if (firstAfter === -1) firstAfter = i;
		});
		if (lastBefore !== -1) insertAt = lastBefore + 1;
		else if (firstAfter !== -1) insertAt = firstAfter;
	}
	const properties = [...note.properties];
	properties.splice(insertAt, 0, written);
	return { ...note, properties };
}

export function removeProperty(note: TranscriptNote, key: string): TranscriptNote {
	return { ...note, properties: note.properties.filter((p) => p.key !== key) };
}

/** A moment as the notes write it: local time with its offset, `2026-10-19T09:35:39+02:00`. */
export function formatTimestamp(at: Date, offsetMinutes: number): string {
	const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
	const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absolute = Math.abs(offsetMinutes);
	return (
		`${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
		`T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
		`${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
	);
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/;

/** Milliseconds since the epoch for a timestamp in the notes' shape, or `null` for anything else. */
export function parseTimestamp(text: string | undefined): number | null {
	if (text === undefined || !TIMESTAMP.test(text)) return null;
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : ms;
}

// --- The request ---------------------------------------------------------------------

/** What the plugin writes at stop, and again on try again. */
export interface TranscriptRequest {
	/** The audio file's link text, such as `Recording 20261019093539.m4a`. */
	audio: string;
	audioBytes: number;
	mode: TranscriptMode;
	/** When recording stopped, as `formatTimestamp` writes it. */
	recorded: string;
	/** The linking note's link text; absent when nothing links from a note. */
	linkedFrom?: string;
	speakerSplit: boolean;
	/** Names exactly as the linking note lists them; absent when it had none. */
	participants?: string[];
	/** The owner's name exactly as typed in settings; absent when the setting is empty. */
	owner?: string;
	/** A language code; absent when the setting is "detect". */
	language?: string;
	attempt: number;
	/**
	 * The mode's transcriber kind when the request is written, so a program and
	 * every device agree on whose the request is. Absent only in a note
	 * written before the line existed, which then follows the settings.
	 */
	transcribeKind?: TranscriberKind;
}

/** A new transcript note asking for a transcript: properties only, no body. */
export function buildRequestNote(request: TranscriptRequest): TranscriptNote {
	let note: TranscriptNote = {
		properties: [{ key: "rule-version", lines: [`rule-version: ${RULE_VERSION}`] }],
		body: "",
	};
	const set = (key: string, raw: string): void => {
		note = setProperty(note, key, raw);
	};
	set("audio", quotedLink(request.audio));
	set("audio-bytes", String(request.audioBytes));
	set("mode", request.mode);
	set("recorded", request.recorded);
	if (request.linkedFrom !== undefined) set("linked-from", quotedLink(request.linkedFrom));
	set("speaker-split", String(request.speakerSplit));
	if (request.participants !== undefined) set("participants", flowList(request.participants));
	if (request.owner !== undefined) set("owner", quote(request.owner));
	if (request.language !== undefined) set("language", quote(request.language));
	set("attempt", String(request.attempt));
	set("transcribe", "requested");
	if (request.transcribeKind !== undefined) set("transcribe-kind", request.transcribeKind);
	return note;
}

/**
 * The kind of transcriber the request was written for: `transcribe-kind`.
 * `undefined` when the note has no such line (written before the line
 * existed); `null` when the line names no kind this module knows, which
 * nothing here takes.
 */
export function readTranscribeKind(note: TranscriptNote): TranscriberKind | null | undefined {
	return readKind(note, "transcribe-kind", TRANSCRIBER_KINDS);
}

/** The kind of agent the ask was written for: `agent-kind`, read as `readTranscribeKind` reads its line. */
export function readAgentKind(note: TranscriptNote): AgentKind | null | undefined {
	return readKind(note, "agent-kind", AGENT_KINDS);
}

function readKind<K extends string>(note: TranscriptNote, key: string, known: readonly K[]): K | null | undefined {
	const written = readString(note, key);
	if (written === undefined) return undefined;
	return known.find((kind) => kind === written) ?? null;
}

// --- Sections -------------------------------------------------------------------------

interface Sections {
	preamble: string;
	agent?: string;
	transcript?: string;
}

function splitSections(body: string): Sections {
	const lines = body.split("\n");
	const at = (heading: string): number => lines.findIndex((l) => l.trimEnd() === heading);
	const agentAt = at(SECTION_HEADINGS.agent);
	const transcriptAt = at(SECTION_HEADINGS.transcript);
	const starts = [agentAt, transcriptAt].filter((i) => i !== -1).sort((a, b) => a - b);
	const contentOf = (start: number): string => {
		const next = starts.find((s) => s > start) ?? lines.length;
		return trimBlankLines(lines.slice(start + 1, next).join("\n"));
	};
	return {
		preamble: trimBlankLines(lines.slice(0, starts[0] ?? lines.length).join("\n")),
		agent: agentAt === -1 ? undefined : contentOf(agentAt),
		transcript: transcriptAt === -1 ? undefined : contentOf(transcriptAt),
	};
}

function trimBlankLines(text: string): string {
	return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

/** The text under a section's heading, without the heading; `undefined` when there is none. */
export function readSection(note: TranscriptNote, name: SectionName): string | undefined {
	return splitSections(note.body)[name];
}

/**
 * Put `content` under a section's heading, replacing whatever was there. The
 * body comes out in the fixed layout: a blank line, then `## Agent` when there
 * is an agent section, then `## Transcript`.
 */
export function writeSection(
	note: TranscriptNote,
	name: SectionName,
	content: string,
): TranscriptNote {
	const sections = splitSections(note.body);
	sections[name] = trimBlankLines(content);
	const pieces: string[] = [];
	if (sections.preamble !== "") pieces.push(`${sections.preamble}\n`);
	for (const section of ["agent", "transcript"] as const) {
		const text = sections[section];
		if (text !== undefined) pieces.push(`${SECTION_HEADINGS[section]}\n\n${text}\n`);
	}
	return { ...note, body: `\n${pieces.join("\n")}` };
}

/** One turn of a transcript with a speaker split: `[00:12:34] **Speaker 1:** text`. */
export function formatTurn(seconds: number, speaker: string, text: string): string {
	const whole = Math.floor(seconds);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const clock = `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`;
	return `[${clock}] **${speaker}:** ${text}`;
}

// --- States ---------------------------------------------------------------------------

export type TranscriberState =
	| "waiting"
	| "being-transcribed"
	| "done"
	| "done-without-speaker-split"
	| "failed"
	| "cancelled"
	/** The note carries a rule version this module does not know. */
	| "unknown-rule-version";

export type AgentState = "none" | "waiting" | "working" | "done" | "failed" | "cancelled";

export interface DerivedState {
	transcriber: TranscriberState;
	/** Waiting, or taken with no change, for longer than the overdue time. */
	transcriberOverdue: boolean;
	agent: AgentState;
	agentOverdue: boolean;
}

const HOUR_MS = 3_600_000;

/**
 * Derive every state from a note. Nothing is written for a state: a note says
 * what was asked and what was answered, and the state follows.
 *
 * An answer counts only for the attempt it names. `transcriber-attempt` equal
 * to `attempt` is an answer to the current request; a lower number is an old
 * answer and the note is waiting again. An absent `attempt` counts as 1.
 *
 * - A finished transcript wins over a cancel: one that lands after a cancel is
 *   kept and shown as done.
 * - Otherwise `transcribe: cancelled` is cancelled, whatever was written before.
 * - Overdue is measured on `now`, the caller's own clock, from timestamps in
 *   the note. Waiting counts from the later of `recorded` and the last
 *   `transcriber-at`; taken counts from `transcriber-at`. A waiting agent
 *   counts from the latest of `recorded`, `transcriber-at`, `agent-at` and
 *   `agent-requested-at`. A timestamp that cannot be read is never overdue.
 * - A state word this module does not know is read as no answer at all.
 */
export function deriveState(
	note: TranscriptNote,
	now: Date,
	overdueHours: number,
): DerivedState {
	if (readInteger(note, "rule-version") !== RULE_VERSION) {
		return {
			transcriber: "unknown-rule-version",
			transcriberOverdue: false,
			agent: "none",
			agentOverdue: false,
		};
	}
	const overdueMs = overdueHours * HOUR_MS;
	const longer = (sinceMs: number | null): boolean =>
		sinceMs !== null && now.getTime() - sinceMs > overdueMs;

	const recorded = parseTimestamp(readString(note, "recorded"));
	const transcriberAt = parseTimestamp(readString(note, "transcriber-at"));

	const attempt = readInteger(note, "attempt") ?? 1;
	const answerState = readString(note, "transcriber-state");
	const answered = readInteger(note, "transcriber-attempt") === attempt;

	let transcriber: TranscriberState;
	if (answered && answerState === "done") transcriber = "done";
	else if (answered && answerState === "done-without-speaker-split")
		transcriber = "done-without-speaker-split";
	else if (readString(note, "transcribe") === "cancelled") transcriber = "cancelled";
	else if (answered && answerState === "failed") transcriber = "failed";
	else if (answered && answerState === "taken") transcriber = "being-transcribed";
	else transcriber = "waiting";

	let transcriberOverdue = false;
	if (transcriber === "waiting") {
		transcriberOverdue = longer(latest(recorded, transcriberAt));
	} else if (transcriber === "being-transcribed") {
		transcriberOverdue = longer(transcriberAt ?? recorded);
	}

	const { agent, agentOverdue } = deriveAgent(note, longer, recorded, transcriberAt);
	return { transcriber, transcriberOverdue, agent, agentOverdue };
}

function deriveAgent(
	note: TranscriptNote,
	longer: (sinceMs: number | null) => boolean,
	recorded: number | null,
	transcriberAt: number | null,
): { agent: AgentState; agentOverdue: boolean } {
	const asked = readString(note, "agent");
	if (asked !== "requested" && asked !== "cancelled") {
		return { agent: "none", agentOverdue: false };
	}
	const agentAt = parseTimestamp(readString(note, "agent-at"));
	const raisedAt = parseTimestamp(readString(note, "agent-requested-at"));
	const attempt = readInteger(note, "agent-attempt");
	const answerState = readString(note, "agent-state");
	const answered =
		attempt !== undefined && readInteger(note, "agent-attempt-answered") === attempt;

	let agent: AgentState;
	if (answered && answerState === "done") agent = "done";
	else if (asked === "cancelled") agent = "cancelled";
	else if (answered && answerState === "failed") agent = "failed";
	else if (answered && answerState === "working") agent = "working";
	else agent = "waiting";

	let agentOverdue = false;
	if (agent === "waiting") agentOverdue = longer(latest(latest(latest(recorded, transcriberAt), agentAt), raisedAt));
	else if (agent === "working") agentOverdue = longer(agentAt ?? transcriberAt);
	return { agent, agentOverdue };
}

function latest(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.max(a, b);
}

// --- Writes by the transcriber and the agent ---------------------------------------------

/**
 * The writes a transcriber makes, as pure functions of a note. A program under
 * the hand-off rule makes them itself; the plugin makes them when it acts as
 * a transcriber on a device. Each takes the time it happened as text, so the
 * caller's clock and zone decide how it reads.
 */

export function markTaken(
	note: TranscriptNote,
	by: { name: string; at: string },
): TranscriptNote {
	let next = removeProperty(removeProperty(removeProperty(note, "transcriber-progress"), "transcriber-reason"), "transcriber-seconds");
	next = setProperty(next, "transcriber", by.name);
	next = setProperty(next, "transcriber-state", "taken");
	next = setProperty(next, "transcriber-at", by.at);
	return setProperty(next, "transcriber-attempt", String(readInteger(note, "attempt") ?? 1));
}

export function markProgress(note: TranscriptNote, percent: number): TranscriptNote {
	return setProperty(note, "transcriber-progress", String(percent));
}

export function markDone(
	note: TranscriptNote,
	done: { at: string; seconds: number; text: string; withoutSpeakerSplit?: boolean },
): TranscriptNote {
	let next = removeProperty(removeProperty(note, "transcriber-progress"), "transcriber-reason");
	next = setProperty(
		next,
		"transcriber-state",
		done.withoutSpeakerSplit ? "done-without-speaker-split" : "done",
	);
	next = setProperty(next, "transcriber-at", done.at);
	next = setProperty(next, "transcriber-attempt", String(readInteger(note, "attempt") ?? 1));
	next = setProperty(next, "transcriber-seconds", String(done.seconds));
	return writeSection(next, "transcript", done.text);
}

export function markFailed(
	note: TranscriptNote,
	failed: { at: string; reason: string; name?: string },
): TranscriptNote {
	let next = removeProperty(note, "transcriber-progress");
	if (failed.name !== undefined) next = setProperty(next, "transcriber", failed.name);
	next = setProperty(next, "transcriber-state", "failed");
	next = setProperty(next, "transcriber-at", failed.at);
	next = setProperty(next, "transcriber-attempt", String(readInteger(note, "attempt") ?? 1));
	return setProperty(next, "transcriber-reason", quote(failed.reason));
}

/** The user cancels: the plugin writes `transcribe: cancelled`. */
export function markCancelled(note: TranscriptNote): TranscriptNote {
	return setProperty(note, "transcribe", "cancelled");
}

/** The user cancels the agent: the plugin writes `agent: cancelled`, and no device asks the agent again. */
export function markAgentCancelled(note: TranscriptNote): TranscriptNote {
	return setProperty(note, "agent", "cancelled");
}

/**
 * The user tries again: a new attempt, asked for afresh. Earlier answers stay
 * and are now old. `kind` is the mode's transcriber kind now, written over the
 * one the request had, so changing a mode and trying again redirects it; with
 * no `kind` the line is left as it is.
 */
export function markTryAgain(note: TranscriptNote, kind?: TranscriberKind): TranscriptNote {
	const attempt = (readInteger(note, "attempt") ?? 1) + 1;
	const asked = setProperty(setProperty(note, "attempt", String(attempt)), "transcribe", "requested");
	return kind === undefined ? asked : setProperty(asked, "transcribe-kind", kind);
}

/**
 * The transcript is done and an agent is chosen: the plugin asks for the agent's
 * step. `kind` is the mode's agent kind now, written as `agent-kind` so a
 * program and every device agree on whose the ask is. A run-again by
 * hand passes `raisedAt` (the time it was raised, as text), and the ask is
 * stamped `agent-requested-at` so its waiting time starts then. The first ask
 * passes no `raisedAt` and is stamped with nothing.
 */
export function markAgentRequested(
	note: TranscriptNote,
	ask: { kind?: AgentKind; raisedAt?: string } = {},
): TranscriptNote {
	const attempt = (readInteger(note, "agent-attempt") ?? 0) + 1;
	let asked = setProperty(setProperty(note, "agent", "requested"), "agent-attempt", String(attempt));
	if (ask.kind !== undefined) asked = setProperty(asked, "agent-kind", ask.kind);
	return ask.raisedAt === undefined ? asked : setProperty(asked, "agent-requested-at", ask.raisedAt);
}

/**
 * Record which transcript (its `transcriber-at`) the agent was asked about, so
 * every device and every restart can tell a new transcript from one already
 * asked about, whatever their clocks say. The plugin writes it with the ask.
 */
export function markAgentFor(note: TranscriptNote): TranscriptNote {
	const transcriptAt = readString(note, "transcriber-at");
	return transcriptAt === undefined ? note : setProperty(note, "agent-for", transcriptAt);
}

export function markAgentWorking(
	note: TranscriptNote,
	by: { name: string; at: string },
): TranscriptNote {
	let next = removeProperty(note, "agent-reason");
	next = setProperty(next, "agent-by", by.name);
	next = setProperty(next, "agent-state", "working");
	next = setProperty(next, "agent-at", by.at);
	return setProperty(next, "agent-attempt-answered", String(readInteger(note, "agent-attempt") ?? 1));
}

export function markAgentDone(
	note: TranscriptNote,
	done: { at: string; text: string },
): TranscriptNote {
	let next = removeProperty(note, "agent-reason");
	next = setProperty(next, "agent-state", "done");
	next = setProperty(next, "agent-at", done.at);
	next = setProperty(next, "agent-attempt-answered", String(readInteger(note, "agent-attempt") ?? 1));
	return writeSection(next, "agent", done.text);
}

export function markAgentFailed(
	note: TranscriptNote,
	failed: { at: string; reason: string },
): TranscriptNote {
	let next = setProperty(note, "agent-state", "failed");
	next = setProperty(next, "agent-at", failed.at);
	next = setProperty(next, "agent-attempt-answered", String(readInteger(note, "agent-attempt") ?? 1));
	return setProperty(next, "agent-reason", quote(failed.reason));
}
