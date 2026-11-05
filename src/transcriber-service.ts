/**
 * The service transcriber (spec #69 § 4 Service, § 5 Keys).
 *
 * A service is an address, a key name and a model name. This device sends the
 * recording itself, in the shared transcription request shape, and writes the
 * transcriber lines of the note in its own name while it does.
 *
 * - **The request:** `POST <address>/audio/transcriptions`, multipart with the
 *   fields `file` and `model`, `language` only when the note carries one, and
 *   `Authorization: Bearer <key>` only when a key name is set. The address is
 *   the API base (`https://api.openai.com/v1`). No `response_format` is sent:
 *   the answer is read as `{"text": …}`, or as plain text when it is not JSON.
 * - **A refusal** (any status outside 200–299) is *failed*, with the service's
 *   own message and the audio's size, and is not retried.
 * - **No network, or an unreachable address** is a wait: the note stays
 *   waiting and the reason is shown. Before a note is claimed the address is
 *   asked whether anybody answers (`NetworkPort.reach`, no recording sent), so
 *   an address that does not answer costs one small request per waiting note
 *   per tick (30 s; no back-off) and writes nothing to the note. Only an
 *   address that answered the question and then failed the send leaves a claim
 *   to let go.
 * - **A key name set but no key on this device, no address, or no model name**
 *   is a wait that sends nothing.
 *
 * Everything outside the rules (the network, the key store, reading the audio)
 * comes in through ports, so this module runs under Node without Obsidian.
 */

import type {
	Adapters,
	ClockPort,
	DevicePort,
	NoteTick,
	TranscriberAdapter,
	VaultPort,
} from "./lifecycle";
import type { TranscriberEntry } from "./settings-data";
import type { KeyStore } from "./key-store";
import {
	CLAIM_SETTLE_MS,
	TRANSCRIBER_LINES,
	claimNote,
	claimedBy,
	identityOf,
	sleep,
	stillClaimedBy,
} from "./serving-device";
import {
	formatTimestamp,
	markDone,
	markFailed,
	parseTranscriptNote,
	readBoolean,
	readInteger,
	readString,
	removeProperty,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note";

// --- Ports ---------------------------------------------------------------------

export interface NetworkRequest {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	body: ArrayBuffer;
}

export interface NetworkResponse {
	status: number;
	text: string;
}

/**
 * The network send. Returns whatever status the service answered with, error
 * statuses included; throws only when no answer could be had (no network, an
 * address nobody answers at). That distinction is what makes "cannot be
 * reached" a wait and a refusal a failure.
 */
export interface NetworkPort {
	/**
	 * Ask whether anybody answers at `url`, sending no recording. Resolves on
	 * any answer, whatever its status; throws when none could be had. This is
	 * what lets an unreachable address be tried on every tick without the note
	 * being claimed and released each time.
	 */
	reach(url: string): Promise<void>;
	send(request: NetworkRequest): Promise<NetworkResponse>;
}

/** Reads the recording a transcript note names. */
export interface AudioPort {
	/**
	 * The bytes of the file `link` names (`Recording ….m4a`, as written inside
	 * `[[…]]`), resolved the way a link in the note at `fromPath` would be; or
	 * `null` when this device has no such file.
	 */
	read(link: string, fromPath: string): Promise<ArrayBuffer | null>;
}

export interface ServiceAdapterPorts {
	/** The lifecycle's own vault, clock and device: the adapter writes the note through them. */
	vault: Pick<VaultPort, "read" | "write">;
	clock: ClockPort;
	device: DevicePort;
	network: NetworkPort;
	keys: KeyStore;
	audio: AudioPort;
	/** How a serving device waits between its claim and its second read; real time when left out. */
	wait?: (ms: number) => Promise<void>;
}

// --- The request ---------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	webm: "audio/webm",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	wav: "audio/wav",
	mp3: "audio/mpeg",
	flac: "audio/flac",
};

export function contentTypeOf(filename: string): string {
	const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** The URL the request goes to: the address, without trailing slashes, plus `/audio/transcriptions`. */
export function transcriptionUrl(address: string): string {
	return `${address.trim().replace(/\/+$/, "")}/audio/transcriptions`;
}

export interface MultipartInput {
	boundary: string;
	/** Text fields, in order. */
	fields: Array<[name: string, value: string]>;
	file: { field: string; filename: string; contentType: string; data: ArrayBuffer };
}

/**
 * A `multipart/form-data` body, built by hand: `requestUrl` takes no
 * `FormData`. Text fields first, then the file, each part opened with
 * `--boundary` and the body closed with `--boundary--`.
 */
export function buildMultipartBody(input: MultipartInput): ArrayBuffer {
	const encoder = new TextEncoder();
	const quoted = (value: string) => value.replace(/[\r\n"]/g, "_");
	const chunks: Uint8Array[] = [];
	for (const [name, value] of input.fields) {
		chunks.push(
			encoder.encode(
				`--${input.boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`,
			),
		);
	}
	const { file } = input;
	chunks.push(
		encoder.encode(
			`--${input.boundary}\r\nContent-Disposition: form-data; name="${quoted(file.field)}"; filename="${quoted(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
		),
	);
	chunks.push(new Uint8Array(file.data));
	chunks.push(encoder.encode(`\r\n--${input.boundary}--\r\n`));
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return body.buffer;
}

function newBoundary(): string {
	const random = Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16));
	return `----VaultRecorder${random.join("")}`;
}

// --- Reading the answer ----------------------------------------------------------

/** The service's own words for a refusal: `error.message`, `error`, `message`, or the body. */
export function refusalMessage(status: number, body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const error = record.error;
			if (typeof error === "string" && error !== "") return error;
			if (error && typeof error === "object") {
				const message = (error as Record<string, unknown>).message;
				if (typeof message === "string" && message !== "") return message;
			}
			if (typeof record.message === "string" && record.message !== "") return record.message;
		}
	} catch {
		// Not JSON: the body itself is the message.
	}
	const text = body.trim();
	return text === "" ? `HTTP ${status}` : text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The transcript out of a successful answer: `{"text": …}`, or the body when it is not JSON. */
export function transcriptOf(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const text = (parsed as Record<string, unknown>).text;
			return typeof text === "string" ? text.trim() : null;
		}
	} catch {
		return body.trim();
	}
	return body.trim();
}

// --- Reasons ---------------------------------------------------------------------

/** A name for the service in a message: the address's host, or the address, or the key name. */
export function serviceName(entry: TranscriberEntry): string {
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

const WAYS_OUT = {
	key: "Ways out: enter the key in this plugin's settings on this device, pick another transcriber for the mode, or let a serving device take it.",
	address:
		"Ways out: check the address and the connection, pick another transcriber for the mode, or let a serving device take it.",
	setting:
		"Ways out: fill in the address in this plugin's settings, or pick another transcriber for the mode.",
	model:
		"Ways out: fill in the model name in this plugin's settings, or pick another transcriber for the mode.",
	audio:
		"Ways out: wait for Obsidian Sync to deliver the recording, or let the device that recorded it send it.",
};

/** The audio link of a note, as the name inside `[[…]]`. */
function audioLinkOf(note: TranscriptNote): string | null {
	const written = readString(note, "audio");
	const match = written === undefined ? null : /\[\[([^\]|#]+)/.exec(written);
	return match ? match[1].trim() : null;
}

// --- The adapter -------------------------------------------------------------------

/**
 * Build the service adapter. `pluginAdapters` in `adapter-table.ts` registers
 * it by kind, beside the defaults, through `withServiceAdapter`.
 */
export function createServiceAdapter(ports: ServiceAdapterPorts): TranscriberAdapter {
	/** Addresses that could not be reached at the last attempt, cleared by the next success. */
	const unreachable = new Set<string>();
	/** Audio links the device has no complete copy of yet. */
	const audioMissing = new Set<string>();
	/**
	 * Notes with a send in progress for an attempt, so overlapping ticks never
	 * send one twice. Keyed by attempt: a lost send let go of on a phone raises
	 * the attempt, and its replacement must not wait for the lost one's promise.
	 */
	const inFlight = new Set<string>();
	/** Addresses that answered the last time they were asked or sent to: no need to ask again. */
	const reachable = new Set<string>();

	function stampOf(at: Date): string {
		return formatTimestamp(at, ports.clock.utcOffsetMinutes(at));
	}

	function blocker(note: TranscriptNote, entry: TranscriberEntry): string | null {
		if (entry.address.trim() === "") {
			return `no address is set for this mode's service transcriber. ${WAYS_OUT.setting}`;
		}
		if (entry.modelName.trim() === "") {
			return `no model name is set for this mode's service transcriber. ${WAYS_OUT.model}`;
		}
		if (entry.keyName.trim() !== "" && ports.keys.get(entry.keyName.trim()) === null) {
			return `no key for ${serviceName(entry)} on this device. ${WAYS_OUT.key}`;
		}
		if (unreachable.has(entry.address.trim())) {
			return `${entry.address.trim()} cannot be reached from this device. ${WAYS_OUT.address}`;
		}
		const link = audioLinkOf(note);
		if (link !== null && audioMissing.has(link)) {
			return `the recording is not on this device yet. ${WAYS_OUT.audio}`;
		}
		return null;
	}

	/** Take this device's own transcriber lines off a note it had claimed. */
	async function letGo(path: string, attempt: number): Promise<void> {
		const text = await ports.vault.read(path);
		const note = text === null ? null : parseTranscriptNote(text);
		if (note === null) return;
		if (!claimedBy(note, identityOf(ports.device))) return; // not ours to release
		if (readInteger(note, "transcriber-attempt") !== attempt) return; // a later attempt's claim
		let next = note;
		for (const key of TRANSCRIBER_LINES) next = removeProperty(next, key);
		await ports.vault.write(path, serializeTranscriptNote(next));
	}

	async function tick(item: NoteTick<TranscriberEntry>): Promise<void> {
		const { path, note, state, entry, now } = item;
		const flightKey = `${path}\n${readInteger(note, "attempt") ?? 1}`;
		if (state.transcriber !== "waiting" || inFlight.has(flightKey)) return;
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
					await ports.network.reach(transcriptionUrl(address));
				} catch {
					unreachable.add(address);
					return;
				}
				unreachable.delete(address);
				reachable.add(address);
			}
			const link = audioLinkOf(note);
			const audio = link === null ? null : await ports.audio.read(link, path);
			const expected = readInteger(note, "audio-bytes") ?? 0;
			if (link === null || audio === null || audio.byteLength < expected) {
				if (link !== null) audioMissing.add(link);
				return;
			}
			audioMissing.delete(link);

			// Claim the note in this device's own name, so no other device sends it too.
			// The note is read again right before the write: whoever claimed it
			// first does the work, and a Cancel written since must not be undone.
			const attempt = readInteger(note, "attempt") ?? 1;
			const freshText = await ports.vault.read(path);
			const fresh = freshText === null ? null : parseTranscriptNote(freshText);
			if (
				fresh === null ||
				(readInteger(fresh, "attempt") ?? 1) !== attempt ||
				readString(fresh, "transcribe") === "cancelled" ||
				readInteger(fresh, "transcriber-attempt") === attempt
			) {
				return;
			}
			const who = identityOf(ports.device);
			await ports.vault.write(
				path,
				serializeTranscriptNote(claimNote(fresh, who, stampOf(now))),
			);
			// A serving device waits, then reads the note again: if another
			// device's claim crossed this one in Sync, that device's name is on the
			// note now and this one backs off, leaving the note alone.
			if (ports.device.role() === "serving") {
				await (ports.wait ?? sleep)(CLAIM_SETTLE_MS);
				const settledText = await ports.vault.read(path);
				const settled = settledText === null ? null : parseTranscriptNote(settledText);
				if (settled === null || !stillClaimedBy(settled, who, attempt)) return;
			}

			const fields: Array<[string, string]> = [["model", entry.modelName.trim()]];
			const language = readString(note, "language");
			if (language !== undefined && language !== "") fields.push(["language", language]);
			const boundary = newBoundary();
			const headers: Record<string, string> = {
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			};
			if (key !== null) headers.Authorization = `Bearer ${key}`;

			let response: NetworkResponse;
			try {
				response = await ports.network.send({
					url: transcriptionUrl(address),
					method: "POST",
					headers,
					body: buildMultipartBody({
						boundary,
						fields,
						file: { field: "file", filename: link, contentType: contentTypeOf(link), data: audio },
					}),
				});
			} catch {
				// Answered a moment ago, then lost: the claim just written is let go.
				reachable.delete(address);
				unreachable.add(address);
				await letGo(path, attempt);
				return;
			}
			unreachable.delete(address);
			reachable.add(address);

			// The answer lands on the note as it is now, unless a new attempt has begun.
			const currentText = await ports.vault.read(path);
			const current = currentText === null ? null : parseTranscriptNote(currentText);
			if (current === null || (readInteger(current, "attempt") ?? 1) !== attempt) return;
			// Another device's claim may have reached the note while the send was out.
			if (!claimedBy(current, identityOf(ports.device))) return;
			const finished = ports.clock.now();
			const at = stampOf(finished);
			const name = ports.device.name();
			let transcript: string | null = null;
			if (response.status >= 200 && response.status < 300) transcript = transcriptOf(response.text);
			const answered =
				transcript !== null
					? markDone(current, {
							at,
							seconds: Math.max(0, Math.round((finished.getTime() - now.getTime()) / 1000)),
							text: transcript,
							// A service answers in plain text: a meeting comes back without speakers.
							withoutSpeakerSplit: readBoolean(current, "speaker-split") === true,
						})
					: markFailed(current, {
							at,
							name,
							reason:
								response.status >= 200 && response.status < 300
									? `The service answered without a transcript (audio: ${audio.byteLength} bytes)`
									: `${refusalMessage(response.status, response.text)} (HTTP ${response.status}; audio: ${audio.byteLength} bytes)`,
						});
			await ports.vault.write(path, serializeTranscriptNote(answered));
		} finally {
			inFlight.delete(flightKey);
		}
	}

	return {
		kind: "service",
		requestsTranscriptNote: true,
		waitingReason: (note, entry) => blocker(note, entry),
		tick,
	};
}

/** The table `pluginAdapters` (`adapter-table.ts`) passes to `Lifecycle`, with the service adapter added beside the defaults. */
export function withServiceAdapter(base: Adapters, ports: ServiceAdapterPorts): Adapters {
	return {
		...base,
		transcribers: { ...base.transcribers, service: createServiceAdapter(ports) },
	};
}
