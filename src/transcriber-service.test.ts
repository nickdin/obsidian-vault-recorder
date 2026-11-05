import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Lifecycle, defaultAdapters, type StoppedRecording } from "./lifecycle.js";
import { audioOfSize, makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { keyNameProblem, type KeyStore } from "./key-store.js";
import {
	buildMultipartBody,
	contentTypeOf,
	createServiceAdapter,
	refusalMessage,
	serviceName,
	transcriptOf,
	transcriptionUrl,
	withServiceAdapter,
	type AudioPort,
	type NetworkPort,
	type NetworkRequest,
	type NetworkResponse,
} from "./transcriber-service.js";
import {
	markCancelled,
	markTryAgain,
	parseTranscriptNote,
	readSection,
	readString,
	serializeTranscriptNote,
} from "./transcript-note.js";

const FILENAME = "Recording 20261019093539.m4a";
const NOTE = "Recording 20261019093539.md";
const DAILY_LOG = "Journal/2026-10-19.md";
const AUDIO_BYTES = 20_000;
const ADDRESS = "https://stt.example.test/v1";
const FAKE_KEY = "fake-throwaway-key-123";

/** A network that answers from a script and remembers every request it was given. */
class FakeNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	/** The next answer; a function is called for each request, an Error is thrown as a lost connection. */
	next: NetworkResponse | Error | ((request: NetworkRequest) => NetworkResponse) = {
		status: 200,
		text: JSON.stringify({ text: "Hello from the service." }),
	};

	/** Every address asked "does anybody answer here?", without a recording. */
	readonly probes: string[] = [];

	/** Answers (returns) unless the scripted answer is an Error, which is a lost connection. */
	async reach(url: string): Promise<void> {
		this.probes.push(url);
		if (this.next instanceof Error) throw this.next;
	}

	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		if (this.next instanceof Error) throw this.next;
		return typeof this.next === "function" ? this.next(request) : this.next;
	}
}

class FakeKeys implements KeyStore {
	readonly keys = new Map<string, string>();
	get(name: string): string | null {
		return this.keys.get(name) ?? null;
	}
}

/** Audio read out of the pretend vault: the file's size, filled with a recognisable byte. */
function audioFrom(world: FakeWorld): AudioPort {
	return {
		async read(link) {
			const size = world.vault.binaries.get(link);
			if (size === undefined) return null;
			return new Uint8Array(size).fill(0x41).buffer;
		},
	};
}

function setUp(entry: Partial<{ address: string; keyName: string; modelName: string }> = {}) {
	const world = makeFakeWorld();
	world.vault.seed(DAILY_LOG, "Earlier thought.\n");
	world.currentSettings.transcribers.dailyLog = {
		kind: "service",
		modelId: "",
		address: ADDRESS,
		keyName: "",
		modelName: "whisper-1",
		...entry,
	};
	const network = new FakeNetwork();
	const keys = new FakeKeys();
	const adapters = withServiceAdapter(defaultAdapters(), {
		vault: world.vault,
		clock: world.clock,
		device: world.device,
		network,
		keys,
		audio: audioFrom(world),
	});
	const adapter = adapters.transcribers.service!;
	const lifecycle = new Lifecycle(world, adapters);
	return { world, network, keys, lifecycle, adapter };
}

function dailyStop(): StoppedRecording {
	return {
		mode: "dailyLog",
		filename: FILENAME,
		peak: 0.3,
		audio: audioOfSize(AUDIO_BYTES),
		linkTarget: { kind: "daily-log", path: DAILY_LOG },
	};
}

async function noteOf(world: FakeWorld) {
	const text = await world.vault.read(NOTE);
	assert.ok(text !== null, "the transcript note exists");
	const note = parseTranscriptNote(text);
	assert.ok(note !== null);
	return note;
}

/** Split a multipart body into its named parts (text as text, the file part as latin1 bytes). */
function parts(request: NetworkRequest) {
	const type = request.headers["Content-Type"];
	const boundary = /boundary=(.+)$/.exec(type)?.[1];
	assert.ok(boundary, "the content type names a boundary");
	const text = new TextDecoder("latin1").decode(new Uint8Array(request.body));
	assert.equal(text.endsWith(`--${boundary}--\r\n`), true, "the body is closed");
	return text
		.split(`--${boundary}`)
		.slice(1, -1)
		.map((section) => {
			const [head, ...rest] = section.replace(/^\r\n/, "").split("\r\n\r\n");
			return {
				name: /name="([^"]*)"/.exec(head)?.[1] ?? "",
				filename: /filename="([^"]*)"/.exec(head)?.[1],
				contentType: /Content-Type: (.*)/.exec(head)?.[1],
				body: rest.join("\r\n\r\n").replace(/\r\n$/, ""),
			};
		});
}

describe("the service transcriber: the request", () => {
	it("posts the recording to the address with /audio/transcriptions appended, as multipart with file and model", async () => {
		const { world, network, lifecycle } = setUp();
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());

		assert.equal(network.requests.length, 1);
		const [request] = network.requests;
		assert.equal(request.url, `${ADDRESS}/audio/transcriptions`);
		assert.equal(request.method, "POST");
		assert.match(request.headers["Content-Type"], /^multipart\/form-data; boundary=\S+$/);
		const sent = parts(request);
		assert.deepEqual(sent.map((p) => p.name), ["model", "file"]);
		assert.equal(sent[0].body, "whisper-1");
		assert.equal(sent[1].filename, FILENAME);
		assert.equal(sent[1].contentType, "audio/mp4");
		assert.equal(sent[1].body, "A".repeat(AUDIO_BYTES), "the audio's own bytes, all of them");
	});

	it("strips trailing slashes from the address before appending the path", async () => {
		const { world, network, lifecycle } = setUp({ address: `${ADDRESS}//` });
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests[0].url, `${ADDRESS}/audio/transcriptions`);
	});

	it("sends the language when the note carries one, and no language field when it does not", async () => {
		const withLanguage = setUp();
		withLanguage.world.currentSettings.language = "sv";
		await withLanguage.lifecycle.recordingStopped(dailyStop());
		await withLanguage.lifecycle.tick(withLanguage.world.clock.now());
		const sent = parts(withLanguage.network.requests[0]);
		assert.deepEqual(
			sent.filter((p) => p.name === "language").map((p) => p.body),
			["sv"],
		);

		const detect = setUp();
		await detect.lifecycle.recordingStopped(dailyStop());
		await detect.lifecycle.tick(detect.world.clock.now());
		assert.equal(parts(detect.network.requests[0]).some((p) => p.name === "language"), false);
	});

	it("sends a bearer key when a key name is set and the key is on this device", async () => {
		const { world, network, keys, lifecycle } = setUp({ keyName: "stt-key" });
		keys.keys.set("stt-key", FAKE_KEY);
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
	});

	it("sends no Authorization header when no key name is set", async () => {
		const { world, network, keys, lifecycle } = setUp();
		keys.keys.set("stt-key", FAKE_KEY); // on the device, but not asked for
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.equal("Authorization" in network.requests[0].headers, false);
	});
});

describe("the service transcriber: the answer", () => {
	it("writes the plain text under ## Transcript and the note is done, in this device's name", async () => {
		const { world, lifecycle } = setUp();
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());

		const note = await noteOf(world);
		assert.equal(readSection(note, "transcript"), "Hello from the service.");
		assert.equal(readString(note, "transcriber-state"), "done");
		assert.equal(readString(note, "transcriber"), "test-desktop");
		await lifecycle.tick(world.clock.now());
		assert.equal(lifecycle.statusOf(NOTE)?.state.transcriber, "done");
	});

	it("takes the note in its own name before the answer arrives", async () => {
		const { world, network, lifecycle } = setUp();
		let seenWhileSending: string | undefined;
		network.next = () => {
			seenWhileSending = world.vault.texts.get(NOTE);
			return { status: 200, text: JSON.stringify({ text: "x" }) };
		};
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.ok(seenWhileSending);
		const during = parseTranscriptNote(seenWhileSending);
		assert.ok(during);
		assert.equal(readString(during, "transcriber-state"), "taken");
		assert.equal(readString(during, "transcriber"), "test-desktop");
	});

	it("reads an answer that is not JSON as the transcript itself", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = { status: 200, text: "Just words.\n" };
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.equal(readSection(await noteOf(world), "transcript"), "Just words.");
	});

	it("marks a meeting done without speaker split, since a service answers in plain text", async () => {
		const { world, lifecycle } = setUp();
		world.currentSettings.transcribers.meeting = structuredClone(
			world.currentSettings.transcribers.dailyLog,
		);
		await lifecycle.recordingStopped({ ...dailyStop(), mode: "meeting" });
		await lifecycle.tick(world.clock.now());
		const note = await noteOf(world);
		assert.equal(readString(note, "speaker-split"), "true");
		assert.equal(readString(note, "transcriber-state"), "done-without-speaker-split");
	});

	it("writes a refusal as failed with the service's own message and the audio's size, and does not retry", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = {
			status: 400,
			text: JSON.stringify({ error: { message: "Unsupported file format", type: "invalid_request_error" } }),
		};
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());

		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber-state"), "failed");
		const reason = readString(note, "transcriber-reason");
		assert.match(reason ?? "", /Unsupported file format/);
		assert.match(reason ?? "", /20000 bytes/);
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 1, "a failure waits for 'try again'");
	});

	it("does not write an answer to an attempt that has since been asked for again", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = () => {
			// The user tries again while the first send is out.
			const current = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(current);
			world.vault.texts.set(NOTE, serializeTranscriptNote(markTryAgain(current)));
			return { status: 200, text: JSON.stringify({ text: "stale" }) };
		};
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		const note = await noteOf(world);
		assert.equal(readSection(note, "transcript"), undefined);
		assert.equal(readString(note, "attempt"), "2");
	});

	it("keeps a transcript that lands after a cancel, shown as done", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = () => {
			const current = parseTranscriptNote(world.vault.texts.get(NOTE) ?? "");
			assert.ok(current);
			world.vault.texts.set(NOTE, serializeTranscriptNote(markCancelled(current)));
			return { status: 200, text: JSON.stringify({ text: "late" }) };
		};
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(lifecycle.statusOf(NOTE)?.state.transcriber, "done");
	});
});

describe("the service transcriber: waiting", () => {
	it("leaves the note waiting when the network fails, says why, and tries again on the next tick", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = new Error("net::ERR_CONNECTION_REFUSED");
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());

		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber-state"), undefined, "the claim is let go");
		assert.equal(readString(note, "transcriber"), undefined);
		await lifecycle.tick(world.clock.now());
		assert.equal(network.probes.length, 2, "the address is asked again on the next tick");
		const status = lifecycle.statusOf(NOTE);
		assert.equal(status?.state.transcriber, "waiting");
		assert.ok(
			status?.waitingReason?.startsWith(`${ADDRESS} cannot be reached from this device`),
			`reason was: ${status?.waitingReason}`,
		);
		assert.match(status?.waitingReason ?? "", /Ways out:/);

		network.next = { status: 200, text: JSON.stringify({ text: "back online" }) };
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(readSection(await noteOf(world), "transcript"), "back online");
		assert.equal(lifecycle.statusOf(NOTE)?.waitingReason, null, "the reason goes with the success");
	});

	it("waits with 'no key for <service> on this device' and sends nothing when the named key is missing", async () => {
		const { world, network, keys, lifecycle } = setUp({ keyName: "stt-key" });
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());

		assert.equal(network.requests.length, 0);
		const status = lifecycle.statusOf(NOTE);
		assert.equal(status?.state.transcriber, "waiting");
		assert.match(status?.waitingReason ?? "", /^no key for stt\.example\.test on this device\./);
		assert.match(status?.waitingReason ?? "", /Ways out:/);
		assert.equal(readString(await noteOf(world), "transcriber-state"), undefined, "nothing was claimed");

		// The key is entered on this device: the very next tick sends.
		keys.keys.set("stt-key", FAKE_KEY);
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 1);
	});

	it("writes nothing to a waiting note while the address cannot be reached, and says why", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = new Error("net::ERR_CONNECTION_REFUSED");
		await lifecycle.recordingStopped(dailyStop());
		const write = world.vault.write.bind(world.vault);
		let writes = 0;
		world.vault.write = async (path, text) => {
			if (path === NOTE) writes++;
			return write(path, text);
		};
		for (let i = 0; i < 3; i++) await lifecycle.tick(world.clock.now());
		assert.equal(writes, 0, "no claim and no release");
		assert.equal(network.requests.length, 0, "no recording was sent");
		assert.ok(network.probes.length >= 3, "the address is still tried on every tick");
		assert.ok(
			lifecycle.statusOf(NOTE)?.waitingReason?.startsWith(`${ADDRESS} cannot be reached from this device`),
			`reason was: ${lifecycle.statusOf(NOTE)?.waitingReason}`,
		);
	});

	it("lets the claim go when the address answered the question but the send was lost", async () => {
		const { world, network, lifecycle } = setUp();
		network.send = async (request) => {
			network.requests.push(request);
			throw new Error("net::ERR_CONNECTION_RESET");
		};
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		const note = await noteOf(world);
		assert.equal(readString(note, "transcriber-state"), undefined, "the claim is let go");
		assert.equal(readString(note, "transcriber"), undefined);
		await lifecycle.tick(world.clock.now());
		assert.match(lifecycle.statusOf(NOTE)?.waitingReason ?? "", /cannot be reached from this device/);
	});

	it("sends the recording on the tick after the address answers again", async () => {
		const { world, network, lifecycle } = setUp();
		network.next = new Error("net::ERR_CONNECTION_REFUSED");
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		network.next = { status: 200, text: JSON.stringify({ text: "back online" }) };
		await lifecycle.tick(world.clock.now());
		assert.equal(readSection(await noteOf(world), "transcript"), "back online");
		await lifecycle.tick(world.clock.now());
		assert.equal(lifecycle.statusOf(NOTE)?.waitingReason, null);
	});

	it("waits, sending nothing, when a model name is not set", async () => {
		const { world, network, lifecycle } = setUp({ modelName: "  " });
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 0);
		const status = lifecycle.statusOf(NOTE);
		assert.equal(status?.state.transcriber, "waiting");
		assert.match(
			status?.waitingReason ?? "",
			/^no model name is set for this mode's service transcriber\. Ways out:/,
		);
	});

	it("waits, sending nothing, while the audio on this device is smaller than audio-bytes", async () => {
		const { world, network, lifecycle } = setUp();
		await lifecycle.recordingStopped(dailyStop());
		world.vault.binaries.set(FILENAME, AUDIO_BYTES - 1); // Sync has delivered part of it
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 0);
		assert.match(lifecycle.statusOf(NOTE)?.waitingReason ?? "", /^the recording is not on this device yet/);
		world.vault.binaries.set(FILENAME, AUDIO_BYTES);
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 1);
	});

	it("waits with a reason when no address is set", async () => {
		const { world, network, lifecycle } = setUp({ address: "" });
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 0);
		assert.match(lifecycle.statusOf(NOTE)?.waitingReason ?? "", /^no address is set/);
	});

	it("does not send a note twice when ticks overlap (the adapter's own guard)", async () => {
		const { world, network, lifecycle, adapter } = setUp();
		await lifecycle.recordingStopped(dailyStop());
		const status = lifecycle.statusOf(NOTE);
		assert.ok(status !== undefined);
		const text = await world.vault.read(NOTE);
		const note = parseTranscriptNote(text ?? "");
		assert.ok(note !== null);
		const item = {
			path: NOTE,
			note,
			state: status.state,
			mode: "dailyLog" as const,
			entry: world.currentSettings.transcribers.dailyLog,
			now: world.clock.now(),
		};
		// Straight at the adapter: the lifecycle's own guard is not in the way.
		await Promise.all([adapter.tick!(item), adapter.tick!(item)]);
		assert.equal(network.requests.length, 1);
	});

	it("moves on to the next note while one note's send never returns", async () => {
		const { world, network, lifecycle } = setUp();
		const FILENAME_B = "Recording 20261019093540.m4a";
		const NOTE_B = "Recording 20261019093540.md";
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.recordingStopped({
			...dailyStop(),
			filename: FILENAME_B,
			linkTarget: { kind: "daily-log", path: DAILY_LOG },
		});
		let sends = 0;
		network.send = async (request) => {
			network.requests.push(request);
			sends++;
			if (sends === 1) return new Promise<NetworkResponse>(() => {}); // note A: never answers
			return { status: 200, text: JSON.stringify({ text: "B's words." }) };
		};
		void lifecycle.tick(world.clock.now()); // stuck inside note A's send
		await new Promise((resolve) => setImmediate(resolve));
		await Promise.race([
			lifecycle.tick(world.clock.now()),
			new Promise((resolve) => setTimeout(resolve, 200)),
		]);
		const noteB = parseTranscriptNote((await world.vault.read(NOTE_B)) ?? "");
		assert.equal(readString(noteB!, "transcriber-state"), "done");
		const noteA = parseTranscriptNote((await world.vault.read(NOTE)) ?? "");
		assert.equal(readString(noteA!, "transcriber-state"), "taken");
		assert.equal(network.requests.length, 2, "A once, B once");
	});

	it("acts only on notes whose mode chose a service", async () => {
		const { world, network, lifecycle } = setUp();
		world.currentSettings.transcribers.dailyLog.kind = "hand-off";
		await lifecycle.recordingStopped(dailyStop());
		await lifecycle.tick(world.clock.now());
		assert.equal(network.requests.length, 0);
	});
});

describe("the request's pieces", () => {
	it("builds a multipart body byte for byte", () => {
		const body = buildMultipartBody({
			boundary: "XX",
			fields: [["model", "m"]],
			file: {
				field: "file",
				filename: 'a"b.m4a',
				contentType: "audio/mp4",
				data: new Uint8Array([1, 2, 3]).buffer,
			},
		});
		assert.equal(
			new TextDecoder("latin1").decode(body),
			'--XX\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n' +
				'--XX\r\nContent-Disposition: form-data; name="file"; filename="a_b.m4a"\r\nContent-Type: audio/mp4\r\n\r\n\x01\x02\x03\r\n' +
				"--XX--\r\n",
		);
	});

	it("names the content type from the extension", () => {
		assert.equal(contentTypeOf("a.WEBM"), "audio/webm");
		assert.equal(contentTypeOf("a.unknown"), "application/octet-stream");
	});

	it("builds the URL from the address", () => {
		assert.equal(transcriptionUrl(" http://127.0.0.1:9/v1/ "), "http://127.0.0.1:9/v1/audio/transcriptions");
	});

	it("takes a refusal's message from the places services put it", () => {
		assert.equal(refusalMessage(400, '{"error":{"message":"bad"}}'), "bad");
		assert.equal(refusalMessage(401, '{"error":"no key"}'), "no key");
		assert.equal(refusalMessage(500, '{"message":"oops"}'), "oops");
		assert.equal(refusalMessage(502, "Bad Gateway"), "Bad Gateway");
		assert.equal(refusalMessage(503, "  "), "HTTP 503");
	});

	it("reads a transcript from JSON or plain text, and none from JSON without text", () => {
		assert.equal(transcriptOf('{"text":" hi "}'), "hi");
		assert.equal(transcriptOf("plain\n"), "plain");
		assert.equal(transcriptOf('{"other":1}'), null);
	});

	it("names a service by the address's host", () => {
		const entry = { kind: "service" as const, modelId: "", address: "https://api.openai.com/v1", keyName: "k", modelName: "" };
		assert.equal(serviceName(entry), "api.openai.com");
		assert.equal(serviceName({ ...entry, address: "" }), "k");
	});

	it("accepts only names the Keychain accepts", () => {
		assert.equal(keyNameProblem(""), null);
		assert.equal(keyNameProblem("openai-key"), null);
		assert.notEqual(keyNameProblem("OpenAI Key"), null);
		assert.notEqual(keyNameProblem("a--b"), null);
	});
});

describe("the adapter as registered", () => {
	it("is the service kind and asks for a transcript note", () => {
		const world = makeFakeWorld();
		const adapter = createServiceAdapter({
			vault: world.vault,
			clock: world.clock,
			device: world.device,
			network: new FakeNetwork(),
			keys: new FakeKeys(),
			audio: audioFrom(world),
		});
		assert.equal(adapter.kind, "service");
		assert.equal(adapter.requestsTranscriptNote, true);
	});
});
