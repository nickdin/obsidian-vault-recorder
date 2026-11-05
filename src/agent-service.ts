/**
 * The service agent.
 *
 * When a transcript is done the plugin asks for the agent's step (`agent:
 * requested`, written by the lifecycle, `shouldRequestAgent` says when). This
 * adapter is what answers it for a mode whose agent is `service`: it sends the
 * linking note and the transcript note to a chat-completions address and
 * writes the answer under `## Agent`.
 *
 * - **The request:** `POST <address>/chat/completions`, a JSON body with
 *   exactly `model` and `messages` — a system message (the fixed part, the
 *   user's instruction, the context note) and a user message (the linking
 *   note, the transcript note, then the instruction again and the answer's
 *   language). `Authorization: Bearer <key>` only when a key name is set.
 *   Nothing else is sent: no temperature, no stream flag.
 * - **The answer** is `choices[0].message.content`, a string or a list of
 *   chunks. Trailing `Speaker N = name` lines are taken off it; a name that is
 *   the owner or a participant exactly as the note lists them is applied the
 *   way a click on a label applies it (`renameSpeaker`), any other is ignored.
 * - **A refusal** (any status outside 200–299, or an answer with no text) is
 *   `agent-state: failed` with the service's own words. **No network, or an
 *   address nobody answers at,** is a wait with a reason, retried on every tick.
 * - **The claim** is `agent-state: working` in this device's name, written
 *   before the send. A serving device then waits and reads the note again, as
 *   the transcriber step does, and backs off if the claim is no longer its own.
 *
 * Everything outside the rules (network, keys, reading a linked note) comes in
 * through ports, so this module runs under Node without Obsidian.
 */

import type { Adapters, AgentAdapter, ClockPort, DevicePort, NoteTick, VaultPort } from "./lifecycle";
import type { AgentEntry, RecordingModeKey } from "./settings-data";
import type { KeyStore } from "./key-store";
import { CLAIM_SETTLE_MS, sleep } from "./serving-device";
import { transcriptLanguage } from "./agent-language";
import { displayOf, renameSpeaker } from "./naming";
import {
	SECTION_HEADINGS,
	formatTimestamp,
	markAgentDone,
	markAgentFailed,
	markAgentWorking,
	parseTimestamp,
	parseTranscriptNote,
	readInteger,
	readList,
	readSection,
	readString,
	removeProperty,
	serializeTranscriptNote,
	type DerivedState,
	type TranscriptNote,
} from "./transcript-note";
import { refusalMessage, type NetworkPort, type NetworkResponse } from "./transcriber-service";

// --- Ports ---------------------------------------------------------------------

/** Reads the note a link names, resolved the way a link written in the note at `fromPath` would be. */
export interface NoteReaderPort {
	/** The text of the note `link` names (`2026-10-19 Planning`, as written inside `[[…]]`), or `null` when this device has none. */
	read(link: string, fromPath: string): Promise<string | null>;
}

export interface AgentServicePorts {
	/** The lifecycle's own vault, clock and device: the adapter writes the note through them. */
	vault: Pick<VaultPort, "read" | "write">;
	clock: ClockPort;
	device: DevicePort;
	network: NetworkPort;
	keys: KeyStore;
	notes: NoteReaderPort;
	/** How a serving device waits between its claim and its second read; real time when left out. */
	wait?: (ms: number) => Promise<void>;
}

// --- The words the request is made of --------------------------------------------

/** The instruction a meeting gets when its box is empty: a meeting's shape. */
export const DEFAULT_AGENT_INSTRUCTION =
	"Summarise the recording in a few paragraphs, then list the decisions and the actions, each with who owns it.";

/**
 * The instruction the daily log and the cursor get when their box is empty.
 * There the speaker talks to themselves, so a meeting summary invents decisions
 * and owners nobody mentioned; this tidies what was said and adds nothing.
 */
export const DEFAULT_TIDY_INSTRUCTION =
	"Tidy what was said into short notes, in the speaker's own words and in the first person. Write each thing that is a task as a Markdown task line, `- [ ] …`. Add nothing that was not said: no decisions, no owners, no summary.";

/** What a mode's empty instruction box stands for: the meeting default for a meeting, the tidy-up for the others. */
export function defaultInstructionFor(mode: RecordingModeKey): string {
	return mode === "meeting" ? DEFAULT_AGENT_INSTRUCTION : DEFAULT_TIDY_INSTRUCTION;
}

/** The part of the system message the user never sees (spec #69 § 9, in substance). */
export const AGENT_FIXED_PART = [
	"You receive the transcript of a recording and the note it is linked from.",
	"Answer in the transcript's language unless the instruction says otherwise.",
	"Write Markdown with no top heading.",
	"If speakers are labelled `Speaker N` and you are sure who one is, end your answer with one line per speaker in the shape `Speaker 2 = [[Anna Svensson]]`, using only the owner's name or a participant exactly as written in the transcript note's `owner` and `participants` properties; otherwise leave the label.",
].join(" ");

/** The last line of the user message: the answer's language, said where a small model obeys it. */
export const AGENT_LANGUAGE_LINE = "Write your whole answer in the language the transcript is written in.";

/** Added to that line only when the mode's box is filled, so a box that names a language wins. */
export const AGENT_LANGUAGE_YIELDS = "If your instruction names another language, use that one instead.";

/** The mode's instruction, or that mode's default when its box is empty. */
function instructionOf(entry: AgentEntry, mode: RecordingModeKey): string {
	const written = entry.instruction.trim();
	return written === "" ? defaultInstructionFor(mode) : written;
}

/** The URL the request goes to: the address, without trailing slashes, plus `/chat/completions`. */
export function chatUrl(address: string): string {
	return `${address.trim().replace(/\/+$/, "")}/chat/completions`;
}

/** The system message: the fixed part, then the instruction, then the context note. */
export function systemMessage(entry: AgentEntry, contextNote: string | null, mode: RecordingModeKey): string {
	const parts = [AGENT_FIXED_PART, instructionOf(entry, mode)];
	if (contextNote !== null && contextNote.trim() !== "") {
		parts.push(`Context about the user's work, to help you read the transcript:\n\n${contextNote.trim()}`);
	}
	return parts.join("\n\n");
}

const HOUR_MS = 3_600_000;

const AGENT_PROPERTIES = [
	"agent",
	"agent-attempt",
	"agent-by",
	"agent-state",
	"agent-at",
	"agent-attempt-answered",
	"agent-reason",
	"agent-requested-at",
];

/**
 * The transcript note as the agent should read it: the note's own text without
 * the agent's earlier answer and the lines that describe it, which are the
 * agent's own output and not the recording.
 */
export function transcriptForAgent(note: TranscriptNote): string {
	let stripped = note;
	for (const key of AGENT_PROPERTIES) stripped = removeProperty(stripped, key);
	const lines = stripped.body.split("\n");
	const start = lines.findIndex((l) => l.trimEnd() === SECTION_HEADINGS.agent);
	if (start !== -1) {
		const after = lines.findIndex((l, i) => i > start && l.trimEnd() === SECTION_HEADINGS.transcript);
		const kept = [...lines.slice(0, start), ...(after === -1 ? [] : lines.slice(after))];
		stripped = { ...stripped, body: kept.join("\n") };
	}
	return serializeTranscriptNote(stripped);
}

/**
 * The user message: the linking note's content, then the transcript note's,
 * then the instruction again and the answer's language.
 *
 * The system message already says to answer in the transcript's language, and
 * `llama3.2` ignored it: Swedish transcripts got English answers every time. The same words last in the user message gave Swedish 12 times in 12
 * and kept English transcripts English. The yielding sentence is added only
 * when the box is filled: the default instruction names no language, and a
 * yielding clause sent with an empty box cost one Swedish answer in four.
 *
 * The language line names the language when `transcriptLanguage` knows it,
 * and is the generic line otherwise.
 */
export function userMessage(
	entry: AgentEntry,
	linkingNote: string | null,
	transcriptNote: string,
	mode: RecordingModeKey,
): string {
	const linking =
		linkingNote === null
			? "(The note this recording is linked from could not be read on this device.)"
			: linkingNote;
	const known = transcriptLanguage(transcriptNote);
	const line = known === null ? AGENT_LANGUAGE_LINE : `Write your whole answer in ${known}, the transcript's language.`;
	const language = entry.instruction.trim() === "" ? line : `${line} ${AGENT_LANGUAGE_YIELDS}`;
	return (
		`The note this recording is linked from:\n\n${linking}\n\nThe transcript note:\n\n${transcriptNote}` +
		`\n\nYour instruction: ${instructionOf(entry, mode)}\n\n${language}`
	);
}

/** The request body: the model and the messages, nothing else. */
export function chatBody(model: string, system: string, user: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		}),
	);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// --- Reading the answer ----------------------------------------------------------------

function textOfChunk(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (chunk && typeof chunk === "object") {
		const text = (chunk as Record<string, unknown>).text;
		if (typeof text === "string") return text;
	}
	return "";
}

/**
 * The answer's text out of a successful reply: `choices[0].message.content` as
 * a string, or as a list of chunks (strings, or objects with `text`). `null`
 * when the reply has no text in either shape.
 */
export function answerOf(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	const choices = (parsed as { choices?: unknown } | null)?.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
	const text = Array.isArray(content) ? content.map(textOfChunk).join("") : typeof content === "string" ? content : null;
	return text === null || text.trim() === "" ? null : text.trim();
}

/** One naming line the agent ended its answer with. */
export interface NamingLine {
	label: string;
	name: string;
}

const NAMING_LINE = /^\s*(?:[-*]\s+)?(Speaker \d+)\s*=\s*(.+?)\s*$/;

/**
 * Take the trailing `Speaker N = name` lines off an answer. Only the lines at
 * its end are taken, blank lines between them allowed; a line of that shape in
 * the middle of the text is the agent's prose and stays.
 */
export function splitNamingLines(answer: string): { text: string; lines: NamingLine[] } {
	const rows = answer.split("\n");
	const lines: NamingLine[] = [];
	let end = rows.length;
	while (end > 0) {
		const row = rows[end - 1];
		if (row.trim() === "") {
			end--;
			continue;
		}
		const match = NAMING_LINE.exec(row);
		if (!match) break;
		lines.unshift({ label: match[1], name: match[2] });
		end--;
	}
	return { text: rows.slice(0, end).join("\n").trim(), lines };
}

/**
 * Apply the agent's naming lines the way a click would: each name must be the
 * owner or a participant as the note lists them (the listed form is what is
 * written); any other name is ignored, and so is a label not in the note.
 */
export function applyNamingLines(note: TranscriptNote, lines: readonly NamingLine[]): TranscriptNote {
	const listed = [readString(note, "owner"), ...(readList(note, "participants") ?? [])].filter(
		(name): name is string => name !== undefined && name.trim() !== "",
	);
	let next = note;
	for (const { label, name } of lines) {
		const written = listed.find((candidate) => candidate === name || displayOf(candidate) === name);
		if (written !== undefined) next = renameSpeaker(next, label, written);
	}
	return next;
}

// --- When the plugin asks for the agent ---------------------------------------------------

/**
 * Whether the plugin should write `agent: requested` on this note now. The
 * rule, in the note's own words so every device reaches the same answer:
 *
 * - the transcript has arrived (`done`, or `done-without-speaker-split`, which
 *   is text with a failed split — a transcript that failed has nothing to send);
 * - never after the agent was cancelled;
 * - a note with no agent line is asked once, but only when its transcript
 *   finished at or after `chosenAt`, the moment the mode's agent was chosen —
 *   at any age, so a meeting transcribed on Friday night is asked when the
 *   laptop opens on Monday. A transcript from before that moment is never
 *   asked: enabling an agent must not send the whole vault to a service. With
 *   no `chosenAt` (`""`, or one that is not a time) the window is the overdue
 *   time instead, so an entry saved before the moment was recorded never sends
 *   anything older than a day;
 * - a note whose agent has answered (done or failed) is asked again when a
 *   transcript landed after that answer — a try again that produced new text, or
 *   a later successful split (`agent-for` names the transcript the ask was
 *   about; a note written before that line compares the two times instead). A
 *   failed answer for the same transcript waits for "run again".
 */
export function shouldRequestAgent(
	note: TranscriptNote,
	state: DerivedState,
	now: Date,
	overdueHours: number,
	chosenAt: string,
): boolean {
	if (state.transcriber !== "done" && state.transcriber !== "done-without-speaker-split") return false;
	const asked = readString(note, "agent");
	if (asked === "cancelled") return false;
	const transcriptAt = parseTimestamp(readString(note, "transcriber-at"));
	if (asked !== "requested") {
		if (transcriptAt === null) return true;
		const chosen = parseTimestamp(chosenAt);
		if (chosen !== null) return transcriptAt >= chosen;
		return now.getTime() - transcriptAt <= overdueHours * HOUR_MS;
	}
	if (state.agent !== "done" && state.agent !== "failed") return false;
	// The note says which transcript the ask was about: only a different one is new.
	const askedFor = readString(note, "agent-for");
	if (askedFor !== undefined) return askedFor !== readString(note, "transcriber-at");
	const agentAt = parseTimestamp(readString(note, "agent-at"));
	return transcriptAt !== null && agentAt !== null && transcriptAt > agentAt;
}

/** Whether the agent section holds text a person may have edited: "run again" asks before replacing it. */
export function hasAgentText(note: TranscriptNote): boolean {
	const text = readSection(note, "agent");
	return text !== undefined && text.trim() !== "";
}

// --- Reasons ---------------------------------------------------------------------------------

const WAYS_OUT = {
	key: "Ways out: enter the key in this plugin's settings on this device, pick another agent for the mode, or let a serving device take it.",
	address:
		"Ways out: check the address and the connection, pick another agent for the mode, or let a serving device take it.",
	setting: "Ways out: fill in the address in this plugin's settings, or pick another agent for the mode.",
	model: "Ways out: fill in the model name in this plugin's settings, or pick another agent for the mode.",
	context: "Ways out: correct the context note's path in this plugin's settings, or empty it.",
};

/** The audio link's cousin: the name inside the first `[[…]]` of a property, or `null`. */
function linkOf(note: TranscriptNote, key: string): string | null {
	const written = readString(note, key);
	const match = written === undefined ? null : /\[\[([^\]|#]+)/.exec(written);
	return match ? match[1].trim() : null;
}

// --- The adapter ---------------------------------------------------------------------------------

/** A name for the service in a message: the address's host, or the address, or the key name. */
function serviceName(entry: AgentEntry): string {
	const address = entry.address.trim();
	if (address !== "") {
		try {
			return new URL(address).host || address;
		} catch {
			return address;
		}
	}
	return entry.keyName.trim() || "the service";
}

/** Take this device's own claim off the note, so the agent step is waiting again. */
function releaseClaim(note: TranscriptNote): TranscriptNote {
	let next = note;
	for (const key of ["agent-by", "agent-state", "agent-at", "agent-attempt-answered", "agent-reason"]) {
		next = removeProperty(next, key);
	}
	return next;
}

/**
 * Build the service agent. `pluginAdapters` in `adapter-table.ts` registers it
 * by kind through `withServiceAgent`.
 */
export function createServiceAgent(ports: AgentServicePorts): AgentAdapter {
	/** Addresses that could not be reached at the last attempt, cleared by the next success. */
	const unreachable = new Set<string>();
	/** Addresses that answered the last time: no need to ask again. */
	const reachable = new Set<string>();
	/** Context-note paths this device could not read. */
	const contextMissing = new Set<string>();
	/** Notes with a send under way for an agent attempt, so overlapping ticks never send one twice. */
	const inFlight = new Set<string>();

	const stampOf = (at: Date): string => formatTimestamp(at, ports.clock.utcOffsetMinutes(at));

	function blocker(entry: AgentEntry): string | null {
		if (entry.address.trim() === "") {
			return `no address is set for this mode's service agent. ${WAYS_OUT.setting}`;
		}
		if (entry.modelName.trim() === "") {
			return `no model name is set for this mode's service agent. ${WAYS_OUT.model}`;
		}
		const keyName = entry.keyName.trim();
		if (keyName !== "" && ports.keys.get(keyName) === null) {
			return `no key for ${serviceName(entry)} on this device. ${WAYS_OUT.key}`;
		}
		if (unreachable.has(entry.address.trim())) {
			return `${entry.address.trim()} cannot be reached from this device. ${WAYS_OUT.address}`;
		}
		const context = entry.contextNotePath.trim();
		if (context !== "" && contextMissing.has(context)) {
			return `the context note '${context}' is not in this vault. ${WAYS_OUT.context}`;
		}
		return null;
	}

	async function load(path: string): Promise<TranscriptNote | null> {
		const text = await ports.vault.read(path);
		return text === null ? null : parseTranscriptNote(text);
	}

	/** Whether the note on disk still shows this device's claim on this attempt. */
	function stillMine(note: TranscriptNote | null, attempt: number): note is TranscriptNote {
		return (
			note !== null &&
			readString(note, "agent") === "requested" &&
			(readInteger(note, "agent-attempt") ?? 1) === attempt &&
			readString(note, "agent-state") === "working" &&
			readInteger(note, "agent-attempt-answered") === attempt &&
			readString(note, "agent-by") === ports.device.name()
		);
	}

	async function letGo(path: string, attempt: number): Promise<void> {
		const note = await load(path);
		if (!stillMine(note, attempt)) return;
		await ports.vault.write(path, serializeTranscriptNote(releaseClaim(note)));
	}

	async function tick(item: NoteTick<AgentEntry>): Promise<void> {
		const { path, note, state, mode, entry, now } = item;
		if (state.agent !== "waiting") return;
		// A transcript a try again is replacing is not sent: it would be answered
		// for text that is about to go, and asked for twice.
		if (state.transcriber !== "done" && state.transcriber !== "done-without-speaker-split") return;
		const attempt = readInteger(note, "agent-attempt") ?? 1;
		const flightKey = `${path}\n${attempt}`;
		if (inFlight.has(flightKey)) return;
		const address = entry.address.trim();
		const keyName = entry.keyName.trim();
		if (address === "" || entry.modelName.trim() === "") return;
		const key = keyName === "" ? null : ports.keys.get(keyName);
		if (keyName !== "" && key === null) return; // sends nothing; the reason is derived

		inFlight.add(flightKey);
		try {
			// Ask before claiming: an address nobody answers at leaves the note untouched.
			if (!reachable.has(address)) {
				try {
					await ports.network.reach(chatUrl(address));
				} catch {
					unreachable.add(address);
					return;
				}
				unreachable.delete(address);
				reachable.add(address);
			}
			const contextPath = entry.contextNotePath.trim();
			let contextNote: string | null = null;
			if (contextPath !== "") {
				contextNote = await ports.vault.read(contextPath);
				if (contextNote === null) {
					contextMissing.add(contextPath);
					return;
				}
				contextMissing.delete(contextPath);
			}

			// Claim the note in this device's own name, so no other device sends it too.
			// It is read again right before the write: whoever claimed it first does
			// the work, and a cancel written since must not be undone.
			const fresh = await load(path);
			if (
				fresh === null ||
				readString(fresh, "agent") !== "requested" ||
				(readInteger(fresh, "agent-attempt") ?? 1) !== attempt ||
				readInteger(fresh, "agent-attempt-answered") === attempt
			) {
				return;
			}
			const transcriptAt = readString(fresh, "transcriber-at");
			await ports.vault.write(
				path,
				serializeTranscriptNote(markAgentWorking(fresh, { name: ports.device.name(), at: stampOf(now) })),
			);
			// A serving device waits, then reads the note again: if another device's
			// claim crossed this one in Sync, that device's name is on the note now.
			if (ports.device.role() === "serving") {
				await (ports.wait ?? sleep)(CLAIM_SETTLE_MS);
				if (!stillMine(await load(path), attempt)) return;
			}

			const linkName = linkOf(fresh, "linked-from");
			const linking = linkName === null ? null : await ports.notes.read(linkName, path);
			const request = {
				url: chatUrl(address),
				method: "POST" as const,
				headers: {
					"Content-Type": "application/json",
					...(key === null ? {} : { Authorization: `Bearer ${key}` }),
				},
				body: chatBody(
					entry.modelName.trim(),
					systemMessage(entry, contextNote, mode),
					userMessage(entry, linking, transcriptForAgent(fresh), mode),
				),
			};

			let response: NetworkResponse;
			try {
				response = await ports.network.send(request);
			} catch {
				// Answered a moment ago, then lost: the claim just written is let go.
				reachable.delete(address);
				unreachable.add(address);
				await letGo(path, attempt);
				return;
			}
			unreachable.delete(address);
			reachable.add(address);

			// The answer lands on the note as it is now, unless it is no longer this
			// attempt's, was cancelled, or the transcript it read has been replaced.
			const current = await load(path);
			if (!stillMine(current, attempt)) return;
			if (readString(current, "transcriber-at") !== transcriptAt) {
				await letGo(path, attempt);
				return;
			}
			const at = stampOf(ports.clock.now());
			const answer =
				response.status >= 200 && response.status < 300 ? answerOf(response.text) : null;
			if (answer === null) {
				const reason =
					response.status >= 200 && response.status < 300
						? "The service answered without any text"
						: `${refusalMessage(response.status, response.text)} (HTTP ${response.status})`;
				await ports.vault.write(path, serializeTranscriptNote(markAgentFailed(current, { at, reason })));
				return;
			}
			const { text, lines } = splitNamingLines(answer);
			// The section is written first: naming then turns the `Speaker N` the
			// summary mentions into the name, as a click on a label would.
			const written = markAgentDone(current, { at, text });
			await ports.vault.write(path, serializeTranscriptNote(applyNamingLines(written, lines)));
		} finally {
			inFlight.delete(flightKey);
		}
	}

	return { kind: "service", waitingReason: (_note, entry) => blocker(entry), tick };
}

/** The table `pluginAdapters` (`adapter-table.ts`) passes to `Lifecycle`, with the service agent added beside the defaults. */
export function withServiceAgent(base: Adapters, ports: AgentServicePorts): Adapters {
	return { ...base, agents: { ...base.agents, service: createServiceAgent(ports) } };
}
