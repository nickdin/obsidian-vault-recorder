import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DEFAULT_SETTINGS } from "./settings-data.js";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { makeFakeWorld, type FakeWorld } from "./lifecycle-fakes.js";
import { RUN_AGENT_QUESTION, RecordingActions } from "./lifecycle-actions.js";
import type { KeyStore } from "./key-store.js";
import type { AgentEntry } from "./settings-data.js";
import {
	AGENT_FIXED_PART,
	DEFAULT_AGENT_INSTRUCTION,
	answerOf,
	chatUrl,
	shouldRequestAgent,
	splitNamingLines,
	withServiceAgent,
	type NoteReaderPort,
} from "./agent-service.js";
import type { NetworkPort, NetworkRequest, NetworkResponse } from "./transcriber-service.js";
import { ProgressMemory, buildQueue } from "./queue-model.js";
import { stateLine } from "./state-line.js";
import {
	buildRequestNote,
	deriveState,
	formatTurn,
	markAgentDone,
	markAgentFailed,
	markAgentRequested,
	markAgentWorking,
	markDone,
	markTryAgain,
	parseTranscriptNote,
	readInteger,
	readSection,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

const NOTE = "Recording 20261019093539.md";
const ADDRESS = "http://127.0.0.1:11434/v1";
const DONE_AT = "2026-10-19T09:48:44+02:00";
const LINKING = "# 2026-10-19 Planning\n\n- Budget for the autumn\n- Hiring plan\n";
const CONTEXT = "BAS means the base budget. FTE means a full-time position.";

/** A network that answers from a script and remembers every request it was given. */
class FakeNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	readonly probes: string[] = [];
	next: NetworkResponse | Error | ((request: NetworkRequest) => NetworkResponse) = reply("A summary.");

	async reach(url: string): Promise<void> {
		this.probes.push(url);
		if (this.next instanceof Error) throw this.next;
	}

	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		if (this.next instanceof Error) throw this.next;
		return typeof this.next === "function" ? this.next(request) : this.next;
	}

	/** The JSON body of request `n`. */
	body(n = 0): { model: string; messages: Array<{ role: string; content: string }> } {
		return JSON.parse(new TextDecoder().decode(this.requests[n].body));
	}
}

class FakeKeys implements KeyStore {
	readonly keys = new Map<string, string>();
	get(name: string): string | null {
		return this.keys.get(name) ?? null;
	}
}

class FakeNotes implements NoteReaderPort {
	readonly notes = new Map<string, string>([["2026-10-19 Planning", LINKING]]);
	async read(link: string): Promise<string | null> {
		return this.notes.get(link) ?? null;
	}
}

/** A chat-completions answer carrying `content`, a string or a list of chunks. */
function reply(content: string | unknown[]): NetworkResponse {
	return { status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) };
}

const TURNS = [
	formatTurn(0, "Speaker 1", "Welcome, everybody."),
	formatTurn(12, "Speaker 2", "Thanks. I agree with the budget."),
	formatTurn(30, "Speaker 3", "I will send the hiring plan."),
].join("\n\n");

/** The text of a meeting's transcript note whose transcript is done. */
function doneNote(extra: (note: TranscriptNote) => TranscriptNote = (n) => n): string {
	const request = buildRequestNote({
		audio: "Recording 20261019093539.m4a",
		audioBytes: 20_000,
		mode: "meeting",
		recorded: "2026-10-19T09:35:39+02:00",
		linkedFrom: "2026-10-19 Planning",
		speakerSplit: true,
		participants: ["[[Anna Svensson]]", "Bo Berg"],
		owner: "[[Robin Example]]",
		attempt: 1,
	});
	const done = markDone(setProperty(request, "transcriber", "home-pc"), {
		at: DONE_AT,
		seconds: 700,
		text: TURNS,
	});
	return serializeTranscriptNote(extra(done));
}

function setUp(options: { entry?: Partial<AgentEntry>; serving?: boolean } = {}) {
	const world = makeFakeWorld();
	world.clock.set("2026-10-19T09:50:00+02:00");
	world.vault.seed("Context.md", CONTEXT);
	world.currentSettings.agents.meeting = { ...agentEntry(), ...options.entry };
	if (options.serving) world.device.deviceRole = "serving";
	const network = new FakeNetwork();
	const keys = new FakeKeys();
	const notes = new FakeNotes();
	const waits: number[] = [];
	const adapters = withServiceAgent(defaultAdapters(), {
		vault: world.vault,
		clock: world.clock,
		device: world.device,
		network,
		keys,
		notes,
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	const lifecycle = new Lifecycle(world, adapters);
	const asked: string[] = [];
	const answer = { yes: true };
	const actions = new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: (path, step) => lifecycle.exclusively(path, step),
		confirm: async (question) => {
			asked.push(question);
			return answer.yes;
		},
		refresh: (path) => lifecycle.look(path, world.clock.now()),
	});
	return { world, network, keys, notes, waits, lifecycle, actions, asked, answer };
}

function agentEntry(): AgentEntry {
	return {
		kind: "service",
		instruction: "Make bullet points of what was decided.",
		contextNotePath: "Context.md",
		address: ADDRESS,
		keyName: "",
		modelName: "llama3.2",
		chosenAt: "",
	};
}

type Setup = ReturnType<typeof setUp>;

const tick = (s: Setup) => s.lifecycle.tick(s.world.clock.now());

function noteOf(s: Setup): TranscriptNote {
	const note = parseTranscriptNote(s.world.vault.texts.get(NOTE) ?? "");
	assert.ok(note, "the transcript note exists");
	return note;
}

function rewrite(s: Setup, change: (note: TranscriptNote) => TranscriptNote): void {
	s.world.vault.texts.set(NOTE, serializeTranscriptNote(change(noteOf(s))));
}

const stateOf = (s: Setup) => deriveState(noteOf(s), s.world.clock.now(), 24);

/** A meeting whose transcript is done and whose agent has not been asked. */
function withDoneMeeting(options?: Parameters<typeof setUp>[0]): Setup {
	const s = setUp(options);
	s.world.vault.seed(NOTE, doneNote());
	return s;
}

describe("the service agent's request", () => {
	it("posts to the address with /chat/completions, and sends only the model and the two messages", async () => {
		const s = withDoneMeeting();
		await tick(s);
		assert.equal(s.network.requests.length, 1);
		const [request] = s.network.requests;
		assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
		assert.equal(request.method, "POST");
		const body = s.network.body();
		assert.deepEqual(Object.keys(body).sort(), ["messages", "model"]);
		assert.equal(body.model, "llama3.2");
		assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
		assert.equal(request.headers.Authorization, undefined, "no key name, no Authorization header");
	});

	it("builds the system message as the fixed part, then the instruction, then the context note", async () => {
		const s = withDoneMeeting();
		await tick(s);
		const system = s.network.body().messages[0].content;
		assert.ok(system.startsWith(AGENT_FIXED_PART), "the fixed part comes first");
		const instruction = system.indexOf("Make bullet points of what was decided.");
		const context = system.indexOf(CONTEXT);
		assert.ok(instruction > AGENT_FIXED_PART.length, "the instruction follows the fixed part");
		assert.ok(context > instruction, "the context note follows the instruction");
	});

	it("uses the default instruction when the box is empty", async () => {
		const s = withDoneMeeting({ entry: { instruction: "  ", contextNotePath: "" } });
		await tick(s);
		const system = s.network.body().messages[0].content;
		assert.equal(system, `${AGENT_FIXED_PART}\n\n${DEFAULT_AGENT_INSTRUCTION}`);
	});

	it("builds the user message from the linking note and the transcript note, without an earlier agent answer", async () => {
		const s = withDoneMeeting();
		rewrite(s, (n) => markAgentDone(markAgentRequested(n), { at: "2026-10-19T09:40:00+02:00", text: "STALE ANSWER" }));
		rewrite(s, (n) => setProperty(n, "transcriber-at", "2026-10-19T09:48:44+02:00"));
		// A newer transcript than the stale answer makes the agent ask again.
		rewrite(s, (n) => setProperty(n, "agent-at", "2026-10-19T09:40:00+02:00"));
		await tick(s);
		const user = s.network.body().messages[1].content;
		assert.ok(user.includes(LINKING), "the linking note's content");
		assert.ok(user.includes("Thanks. I agree with the budget."), "the transcript note's content");
		assert.ok(user.includes('owner: "[[Robin Example]]"'), "the transcript note's properties, which name the owner");
		assert.ok(!user.includes("STALE ANSWER"), "the agent's own earlier answer is not sent back");
	});

	it("ends the user message with the instruction and the language line when the box is empty", async () => {
		const s = withDoneMeeting({ entry: { instruction: "  ", contextNotePath: "" } });
		await tick(s);
		const user = s.network.body().messages[1].content;
		const ending =
			"\n\nYour instruction: Summarise the recording in a few paragraphs, then list the decisions and the actions, each with who owns it." +
			"\n\nWrite your whole answer in the language the transcript is written in.";
		assert.ok(user.endsWith(ending), `the user message ends with the language line, got: …${user.slice(-300)}`);
	});

	it("ends the user message with the line that yields to the instruction when the box is filled", async () => {
		const s = withDoneMeeting();
		await tick(s);
		const user = s.network.body().messages[1].content;
		const ending =
			"\n\nYour instruction: Make bullet points of what was decided." +
			"\n\nWrite your whole answer in the language the transcript is written in. If your instruction names another language, use that one instead.";
		assert.ok(user.endsWith(ending), `the user message ends with the yielding line, got: …${user.slice(-300)}`);
	});

	it("sends a bearer key only when a key name is set and the key is on this device", async () => {
		const s = withDoneMeeting({ entry: { keyName: "my-llm" } });
		await tick(s);
		assert.equal(s.network.requests.length, 0, "no key on this device: nothing is sent");
		s.keys.keys.set("my-llm", "throwaway-key");
		await tick(s);
		assert.equal(s.network.requests[0].headers.Authorization, "Bearer throwaway-key");
	});

	it("trims trailing slashes from the address", () => {
		assert.equal(chatUrl(" http://h/v1/// "), "http://h/v1/chat/completions");
	});
});

describe("the service agent's answer", () => {
	it("lands under ## Agent, above ## Transcript, and the agent's lines say who answered", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("The budget was agreed.");
		await tick(s);
		const note = noteOf(s);
		assert.equal(readSection(note, "agent"), "The budget was agreed.");
		const body = note.body;
		assert.ok(body.indexOf("## Agent") < body.indexOf("## Transcript"), "the agent section is above the transcript");
		assert.equal(readString(note, "agent-state"), "done");
		assert.equal(readString(note, "agent-by"), "test-desktop");
		assert.equal(readInteger(note, "agent-attempt"), 1);
		assert.equal(readInteger(note, "agent-attempt-answered"), 1);
		assert.equal(stateOf(s).agent, "done");
	});

	it("reads an answer given as a list of chunks", async () => {
		const s = withDoneMeeting();
		s.network.next = reply([{ type: "text", text: "First half. " }, { type: "text", text: "Second half." }]);
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), "First half. Second half.");
	});

	it("takes the Speaker N = name lines off the answer and applies them as a click would", async () => {
		const s = withDoneMeeting();
		s.network.next = reply(
			"Speaker 2 agreed to the budget; Speaker 3 will send the hiring plan.\n\nSpeaker 2 = [[Anna Svensson]]\nSpeaker 3 = Bo Berg\n",
		);
		await tick(s);
		const note = noteOf(s);
		const section = readSection(note, "agent") ?? "";
		assert.ok(!/Speaker \d = /.test(section), "the naming lines are off the section");
		assert.equal(
			section,
			"[[Anna Svensson]] agreed to the budget; Bo Berg will send the hiring plan.",
			"a bare Speaker N in the summary is renamed too, as a click does",
		);
		assert.ok(note.body.includes("**[[Anna Svensson]]:** Thanks. I agree with the budget."));
		assert.ok(note.body.includes("**Bo Berg:** I will send the hiring plan."));
		assert.ok(note.body.includes("**Speaker 1:** Welcome, everybody."), "a speaker the agent did not name stays a number");
	});

	it("applies the owner's name as written, and ignores a name that is neither the owner nor a participant", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("Summary.\n\nSpeaker 1 = [[Robin Example]]\nSpeaker 2 = Mallory Unlisted");
		await tick(s);
		const note = noteOf(s);
		assert.ok(note.body.includes("**[[Robin Example]]:** Welcome, everybody."));
		assert.ok(note.body.includes("**Speaker 2:** Thanks."), "an unknown name is ignored");
		assert.ok(!note.body.includes("Mallory"), "the unknown name is nowhere in the note");
	});

	it("applies a participant named by the words a reader sees", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("Summary.\n\nSpeaker 2 = Anna Svensson");
		await tick(s);
		assert.ok(noteOf(s).body.includes("**[[Anna Svensson]]:** Thanks."), "the listed form is what is written");
	});

	it("takes only the lines at the end: a naming-shaped line in the middle is prose", () => {
		const split = splitNamingLines("Speaker 1 = a guess in the middle\n\nMore text.\n\n- Speaker 2 = [[Anna Svensson]]\n\n");
		assert.equal(split.text, "Speaker 1 = a guess in the middle\n\nMore text.");
		assert.deepEqual(split.lines, [{ label: "Speaker 2", name: "[[Anna Svensson]]" }]);
	});

	it("reads string and chunk answers, and nothing else", () => {
		assert.equal(answerOf(JSON.stringify({ choices: [{ message: { content: " hi " } }] })), "hi");
		assert.equal(answerOf(JSON.stringify({ choices: [{ message: { content: ["a", { text: "b" }, 5] } }] })), "ab");
		assert.equal(answerOf(JSON.stringify({ choices: [{ message: { content: "  " } }] })), null);
		assert.equal(answerOf(JSON.stringify({ choices: [] })), null);
		assert.equal(answerOf("not json"), null);
	});
});

describe("when the agent runs", () => {
	it("runs once per transcript: later ticks do not ask again", async () => {
		const s = withDoneMeeting();
		await tick(s);
		await tick(s);
		s.world.clock.advance(60_000);
		await tick(s);
		assert.equal(s.network.requests.length, 1);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 1, "the plugin asked once");
	});

	it("does not ask for an agent the mode has not chosen", async () => {
		const s = withDoneMeeting({ entry: { kind: "none" } });
		await tick(s);
		assert.equal(readString(noteOf(s), "agent"), undefined);
		assert.equal(s.network.requests.length, 0);
	});

	it("does not run while the transcript is not done, nor when it failed", async () => {
		const waiting = setUp();
		waiting.world.vault.seed(
			NOTE,
			serializeTranscriptNote(
				buildRequestNote({
					audio: "Recording 20261019093539.m4a",
					audioBytes: 20_000,
					mode: "meeting",
					recorded: "2026-10-19T09:35:39+02:00",
					speakerSplit: true,
					attempt: 1,
				}),
			),
		);
		await tick(waiting);
		assert.equal(readString(noteOf(waiting), "agent"), undefined);
		const failed = withDoneMeeting();
		rewrite(failed, (n) => setProperty(n, "transcriber-state", "failed"));
		await tick(failed);
		assert.equal(readString(noteOf(failed), "agent"), undefined, "a transcript that failed has nothing to send");
		assert.equal(failed.network.requests.length, 0);
	});

	it("does run when the speaker split failed, for the text is there", async () => {
		const s = withDoneMeeting();
		rewrite(s, (n) => setProperty(n, "transcriber-state", "done-without-speaker-split"));
		await tick(s);
		assert.equal(s.network.requests.length, 1);
	});

	it("does not send a transcript that was finished before an agent was chosen", async () => {
		const s = withDoneMeeting();
		s.world.clock.set("2026-10-21T09:50:00+02:00"); // two days after the transcript
		await tick(s);
		assert.equal(readString(noteOf(s), "agent"), undefined);
		assert.equal(s.network.requests.length, 0);
	});

	it("is not asked again after the agent was cancelled", () => {
		const s = withDoneMeeting();
		rewrite(s, (n) => setProperty(markAgentRequested(n), "agent", "cancelled"));
		assert.equal(shouldRequestAgent(noteOf(s), stateOf(s), s.world.clock.now(), 24, ""), false);
	});

	it("asks for a hand-off agent too, and sends nothing itself", async () => {
		const s = withDoneMeeting({ entry: { kind: "hand-off" } });
		const handOff = new Lifecycle(s.world);
		await handOff.tick(s.world.clock.now());
		const note = noteOf(s);
		assert.equal(readString(note, "agent"), "requested");
		assert.equal(stateOf(s).agent, "waiting");
		assert.equal(s.network.requests.length, 0);
	});

	it("runs again when a try again has brought new text, and not before", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("First summary.");
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), "First summary.");

		s.world.clock.set("2026-10-19T10:00:00+02:00");
		s.world.vault.texts.set(NOTE, serializeTranscriptNote(markTryAgain(noteOf(s))));
		await tick(s);
		assert.equal(s.network.requests.length, 1, "the new text has not landed: nothing is sent");

		s.network.next = reply("Second summary.");
		s.world.clock.set("2026-10-19T10:05:00+02:00");
		rewrite(s, (n) =>
			markDone(n, { at: "2026-10-19T10:04:00+02:00", seconds: 300, text: formatTurn(0, "Speaker 1", "A new text.") }),
		);
		await tick(s);
		assert.equal(s.network.requests.length, 2);
		assert.equal(readSection(noteOf(s), "agent"), "Second summary.");
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);
		assert.ok(s.network.body(1).messages[1].content.includes("A new text."), "the new transcript is what was sent");
	});

	it("runs again when a later successful split replaces a transcript that had none", async () => {
		const s = withDoneMeeting();
		rewrite(s, (n) => setProperty(n, "transcriber-state", "done-without-speaker-split"));
		s.network.next = reply("Summary from plain text.");
		await tick(s);
		assert.equal(s.network.requests.length, 1);

		s.world.clock.set("2026-10-19T11:00:00+02:00");
		rewrite(s, (n) =>
			setProperty(setProperty(n, "transcriber-state", "done"), "transcriber-at", "2026-10-19T10:59:00+02:00"),
		);
		s.network.next = reply("Summary with speakers.");
		await tick(s);
		assert.equal(s.network.requests.length, 2);
		assert.equal(readSection(noteOf(s), "agent"), "Summary with speakers.");
	});

	it("sends nothing while a try again is replacing the transcript", async () => {
		const s = setUp();
		// The agent is asked for and has not answered; then the user clicks "Try again".
		s.world.vault.seed(NOTE, doneNote((n) => markAgentRequested(n)));
		rewrite(s, (n) => markTryAgain(n));
		await tick(s);
		await tick(s);
		assert.equal(s.network.requests.length, 0, "the old transcript is not sent");
		assert.equal(readSection(noteOf(s), "agent"), undefined, "no agent section is written for it");
		assert.equal(readString(noteOf(s), "agent-state"), undefined, "the agent is not claimed");
	});

	it("does not loop when another device's clock puts the answer before the transcript", async () => {
		const s = withDoneMeeting();
		await tick(s);
		// The answer carries an earlier time than the transcript, as skewed clocks can write.
		rewrite(s, (n) => setProperty(n, "agent-at", "2026-10-19T09:00:00+02:00"));
		await tick(s);
		await tick(s);
		assert.equal(s.network.requests.length, 1, "this device already asked about this transcript");
	});
});

describe("once per transcript across devices and restarts", () => {
	/** A second Lifecycle on the same vault: another device, or this one after Obsidian restarts. */
	function anotherDevice(s: Setup): Lifecycle {
		const adapters = withServiceAgent(defaultAdapters(), {
			vault: s.world.vault,
			clock: s.world.clock,
			device: s.world.device,
			network: s.network,
			keys: s.keys,
			notes: s.notes,
			wait: async () => {},
		});
		return new Lifecycle(s.world, adapters);
	}

	it("asks once in total when a fresh Lifecycle meets a note whose answer is dated before the transcript", async () => {
		const s = withDoneMeeting();
		await tick(s);
		rewrite(s, (n) => setProperty(n, "agent-at", "2026-10-19T09:00:00+02:00"));
		const second = anotherDevice(s);
		await second.tick(s.world.clock.now());
		await second.tick(s.world.clock.now());
		await tick(s);
		assert.equal(s.network.requests.length, 1, "the note says which transcript the agent was asked about");
	});

	it("still asks again for a transcript that a try again replaced", async () => {
		const s = withDoneMeeting();
		await tick(s);
		rewrite(s, (n) => markTryAgain(n));
		rewrite(s, (n) => markDone(n, { at: "2026-10-19T09:55:00+02:00", seconds: 700, text: TURNS }));
		s.world.clock.set("2026-10-19T09:56:00+02:00");
		await anotherDevice(s).tick(s.world.clock.now());
		assert.equal(s.network.requests.length, 2);
	});
});

describe("run the agent again by hand", () => {
	it("asks before replacing a section that has text, and leaves it when the answer is no", async () => {
		const s = withDoneMeeting();
		await tick(s);
		s.answer.yes = false;
		const result = await s.actions.runAgentAgain(NOTE);
		assert.deepEqual(s.asked, [RUN_AGENT_QUESTION]);
		assert.equal(result.changed, false);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 1);
		await tick(s);
		assert.equal(s.network.requests.length, 1);
	});

	it("runs the agent again on yes, and the new answer replaces the section", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("Before.");
		await tick(s);
		// A hand edit to the section: the question exists for exactly this.
		rewrite(s, (n) => markAgentDone(n, { at: "2026-10-19T09:51:00+02:00", text: "My own edit." }));
		s.network.next = reply("After.");
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, true);
		assert.equal(s.asked.length, 1);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);
		await tick(s);
		assert.equal(s.network.requests.length, 2);
		assert.equal(readSection(noteOf(s), "agent"), "After.");
	});

	it("does not ask when there is no section text to lose", async () => {
		const s = withDoneMeeting();
		s.network.next = { status: 500, text: JSON.stringify({ error: { message: "overloaded" } }) };
		await tick(s);
		assert.equal(stateOf(s).agent, "failed");
		s.network.next = reply("Second try.");
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(s.asked.length, 0);
		assert.equal(result.changed, true);
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), "Second try.");
	});

	it("refuses when the mode has no agent, when there is no transcript yet, and while the agent is working", async () => {
		const none = withDoneMeeting({ entry: { kind: "none" } });
		assert.equal((await none.actions.runAgentAgain(NOTE)).changed, false);
		const early = setUp();
		early.world.vault.seed(
			NOTE,
			serializeTranscriptNote(
				buildRequestNote({
					audio: "Recording 20261019093539.m4a",
					audioBytes: 20_000,
					mode: "meeting",
					recorded: "2026-10-19T09:35:39+02:00",
					speakerSplit: true,
					attempt: 1,
				}),
			),
		);
		assert.match((await early.actions.runAgentAgain(NOTE)).message, /no transcript yet/);
		const working = withDoneMeeting();
		rewrite(working, (n) => markAgentWorking(markAgentRequested(n), { name: "home-pc", at: "2026-10-19T09:49:00+02:00" }));
		assert.match((await working.actions.runAgentAgain(NOTE)).message, /already on its way/);
	});
});

describe("when the agent cannot answer", () => {
	it("writes agent-state: failed with the service's own words and the HTTP status", async () => {
		const s = withDoneMeeting();
		s.network.next = { status: 400, text: JSON.stringify({ error: { message: "context length exceeded" } }) };
		await tick(s);
		const note = noteOf(s);
		assert.equal(readString(note, "agent-state"), "failed");
		assert.equal(readString(note, "agent-reason"), "context length exceeded (HTTP 400)");
		assert.equal(readSection(note, "agent"), undefined, "a failure writes no section");
		assert.equal(stateOf(s).agent, "failed");
		await tick(s);
		assert.equal(s.network.requests.length, 1, "a failure is not retried on its own");
	});

	it("fails when the service answers without text", async () => {
		const s = withDoneMeeting();
		s.network.next = reply("   ");
		await tick(s);
		assert.equal(readString(noteOf(s), "agent-state"), "failed");
		assert.match(readString(noteOf(s), "agent-reason") ?? "", /without any text/);
	});

	it("waits, writing nothing, when the address cannot be reached, and goes on when it can", async () => {
		const s = withDoneMeeting();
		s.network.next = new Error("connection refused");
		await tick(s);
		const note = noteOf(s);
		assert.equal(readString(note, "agent-state"), undefined, "no claim is left on the note");
		assert.equal(s.network.requests.length, 0);
		await tick(s); // the reason is derived from what the last attempt learned
		assert.match(s.lifecycle.statusOf(NOTE)?.waitingReason ?? "", /cannot be reached from this device/);
		s.network.next = reply("Back again.");
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), "Back again.");
	});

	it("lets go of its claim when the send is lost, so the step waits again", async () => {
		const s = withDoneMeeting();
		s.network.next = (() => {
			throw new Error("connection reset");
		}) as never;
		await tick(s);
		assert.equal(readString(noteOf(s), "agent-state"), undefined);
		assert.equal(stateOf(s).agent, "waiting");
	});

	it("waits, naming the way out, when the key is not on this device", async () => {
		const s = withDoneMeeting({ entry: { keyName: "my-llm" } });
		await tick(s);
		assert.match(s.lifecycle.statusOf(NOTE)?.waitingReason ?? "", /no key for 127\.0\.0\.1:11434 on this device/);
	});

	it("waits when the context note is not in the vault", async () => {
		const s = withDoneMeeting({ entry: { contextNotePath: "Nowhere.md" } });
		await tick(s);
		await tick(s); // the reason is derived from what the last attempt learned
		assert.equal(s.network.requests.length, 0);
		assert.match(s.lifecycle.statusOf(NOTE)?.waitingReason ?? "", /context note 'Nowhere\.md' is not in this vault/);
	});

	it("drops the answer when the agent was asked again while the send was out", async () => {
		const s = withDoneMeeting();
		s.network.next = () => {
			rewrite(s, (n) => markAgentRequested(n));
			return reply("An answer to the old attempt.");
		};
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), undefined);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);
	});

	it("drops the answer when the transcript was replaced while the send was out", async () => {
		const s = withDoneMeeting();
		s.network.next = () => {
			rewrite(s, (n) => setProperty(n, "transcriber-at", "2026-10-19T09:49:30+02:00"));
			return reply("An answer about the old text.");
		};
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), undefined);
		assert.equal(stateOf(s).agent, "waiting", "the claim is let go so the new text is read next");
	});

	it("drops the answer when the agent was cancelled while the send was out", async () => {
		const s = withDoneMeeting();
		s.network.next = () => {
			rewrite(s, (n) => setProperty(n, "agent", "cancelled"));
			return reply("Too late.");
		};
		await tick(s);
		assert.equal(readSection(noteOf(s), "agent"), undefined);
	});
});

describe("a serving device and the agent", () => {
	it("leaves the agent step to the recording device for the grace period, then takes it and waits before sending", async () => {
		const s = withDoneMeeting({ serving: true });
		s.world.clock.set("2026-10-19T09:50:00+02:00"); // 76 s after the transcript
		await tick(s);
		assert.equal(s.network.requests.length, 0, "inside the grace period");
		s.world.clock.set("2026-10-19T09:53:00+02:00");
		await tick(s);
		assert.equal(s.network.requests.length, 1);
		assert.deepEqual(s.waits, [2 * 60_000], "it waited the settle time between its claim and the send");
		assert.equal(readSection(noteOf(s), "agent"), "A summary.");
	});

	it("backs off when another device's name is on the claim after the wait", async () => {
		const s = withDoneMeeting({ serving: true });
		s.world.clock.set("2026-10-19T09:53:00+02:00");
		const settle = s.waits;
		const lifecycle = new Lifecycle(
			s.world,
			withServiceAgent(defaultAdapters(), {
				vault: s.world.vault,
				clock: s.world.clock,
				device: s.world.device,
				network: s.network,
				keys: s.keys,
				notes: s.notes,
				wait: async (ms) => {
					settle.push(ms);
					rewrite(s, (n) => setProperty(n, "agent-by", "the-laptop"));
				},
			}),
		);
		await lifecycle.tick(s.world.clock.now());
		assert.equal(s.network.requests.length, 0, "the other device's claim stands");
		assert.equal(readString(noteOf(s), "agent-by"), "the-laptop");
	});

	it("never takes a hand-off agent", async () => {
		const s = withDoneMeeting({ serving: true, entry: { kind: "hand-off" } });
		s.world.clock.set("2026-10-19T09:59:00+02:00");
		await tick(s);
		assert.equal(readString(noteOf(s), "agent-state"), undefined);
		assert.equal(s.network.requests.length, 0);
	});
});

describe("the queue and the state line for the agent", () => {
	const clock = (now: string) => ({ now: new Date(now), utcOffsetMinutes: () => 120 });
	const queueOf = (texts: Array<[string, string]>, now: string) =>
		buildQueue({
			notes: texts.map(([path, text]) => ({ path, note: parseTranscriptNote(text)!, waitingReason: null })),
			clock: clock(now),
			overdueHours: 24,
			progress: new ProgressMemory(),
			settings: DEFAULT_SETTINGS,
		});
	const asked = (text: string) => serializeTranscriptNote(markAgentRequested(parseTranscriptNote(text)!));

	it("shows agent working, agent failed and agent overdue as groups, each with run again where it applies", () => {
		const base = doneNote();
		const working = serializeTranscriptNote(
			markAgentWorking(markAgentRequested(parseTranscriptNote(base)!), { name: "home-pc", at: "2026-10-19T09:49:00+02:00" }),
		);
		const failed = serializeTranscriptNote(
			markAgentFailed(markAgentRequested(parseTranscriptNote(base)!), { at: "2026-10-19T09:49:00+02:00", reason: "model not found" }),
		);
		const overdue = asked(base);
		const groups = queueOf(
			[
				["working.md", working],
				["failed.md", failed],
				["late.md", overdue],
			],
			"2026-10-21T12:00:00+02:00",
		);
		const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
		assert.deepEqual(byId["agent-working"], undefined, "a working agent two days on is overdue, not working");
		assert.deepEqual(byId["agent-overdue"].rows.map((r) => r.path).sort(), ["late.md", "working.md"]);
		assert.deepEqual(byId["agent-failed"].rows.map((r) => r.path), ["failed.md"]);
		for (const row of groups.flatMap((g) => g.rows)) {
			assert.ok(row.offers.some((o) => o.action === "run-agent"), `${row.path} offers run again`);
		}

		const fresh = queueOf([["working.md", working]], "2026-10-19T10:00:00+02:00");
		assert.equal(fresh[0].id, "agent-working");
		assert.equal(fresh[0].rows[0].offers.some((o) => o.action === "run-agent"), false, "no run again while it is working");
	});

	it("says in the state line where the agent stands, with the reason when it failed", () => {
		const status = (text: string, now: string) => {
			const note = parseTranscriptNote(text)!;
			return stateLine(note, { state: deriveState(note, new Date(now), 24), waitingReason: null }, clock(now));
		};
		const base = doneNote();
		const failed = serializeTranscriptNote(
			markAgentFailed(markAgentRequested(parseTranscriptNote(base)!), { at: "2026-10-19T09:49:00+02:00", reason: "model not found" }),
		);
		assert.equal(status(base, "2026-10-19T09:50:00+02:00"), "done");
		assert.equal(status(failed, "2026-10-19T09:50:00+02:00"), "done — agent failed: model not found");
		assert.equal(status(asked(base), "2026-10-19T09:50:00+02:00"), "done — agent waiting");
	});
});
