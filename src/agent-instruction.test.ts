import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as nodeModule from "node:module";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { makeFakeWorld } from "./lifecycle-fakes.js";
import {
	AGENT_FIXED_PART,
	AGENT_LANGUAGE_LINE,
	AGENT_LANGUAGE_YIELDS,
	DEFAULT_AGENT_INSTRUCTION,
	DEFAULT_TIDY_INSTRUCTION,
	defaultInstructionFor,
	systemMessage,
	userMessage,
	withServiceAgent,
} from "./agent-service.js";
import { RECORDING_MODE_KEYS, type AgentEntry, type RecordingModeKey } from "./settings-data.js";
import type { NetworkPort, NetworkRequest, NetworkResponse } from "./transcriber-service.js";
import { MODE_WORDS, buildRequestNote, formatTurn, markDone, serializeTranscriptNote, setProperty } from "./transcript-note.js";

// What an empty instruction box stands for depends on the recording's mode: a meeting keeps the
// summary-with-decisions default, the daily log and the cursor get a tidy-up that adds nothing.

const entry = (instruction: string): AgentEntry => ({
	kind: "service",
	instruction,
	contextNotePath: "",
	address: "http://127.0.0.1:11434/v1",
	keyName: "",
	modelName: "llama3.2",
	chosenAt: "",
});

const EXPECTED_DEFAULT: Record<RecordingModeKey, string> = {
	meeting: DEFAULT_AGENT_INSTRUCTION,
	dailyLog: DEFAULT_TIDY_INSTRUCTION,
	cursor: DEFAULT_TIDY_INSTRUCTION,
};

describe("the default agent instruction per mode", () => {
	it("keeps the meeting default word for word", () => {
		assert.equal(
			DEFAULT_AGENT_INSTRUCTION,
			"Summarise the recording in a few paragraphs, then list the decisions and the actions, each with who owns it.",
		);
	});

	it("tidies, in the first person, with task lines and nothing invented, for the daily log and the cursor", () => {
		assert.match(DEFAULT_TIDY_INSTRUCTION, /own words/);
		assert.match(DEFAULT_TIDY_INSTRUCTION, /first person/);
		assert.ok(DEFAULT_TIDY_INSTRUCTION.includes("`- [ ] …`"), "names the Markdown task line");
		assert.match(DEFAULT_TIDY_INSTRUCTION, /no decisions, no owners, no summary/);
		assert.notEqual(DEFAULT_TIDY_INSTRUCTION, DEFAULT_AGENT_INSTRUCTION);
	});

	for (const mode of RECORDING_MODE_KEYS) {
		it(`gives the ${mode} mode its own default from defaultInstructionFor`, () => {
			assert.equal(defaultInstructionFor(mode), EXPECTED_DEFAULT[mode]);
		});

		it(`puts the ${mode} default in the system message when the box is empty`, () => {
			assert.equal(systemMessage(entry("  "), null, mode), `${AGENT_FIXED_PART}\n\n${EXPECTED_DEFAULT[mode]}`);
		});

		it(`puts the ${mode} default on the user message's instruction line when the box is empty`, () => {
			const user = userMessage(entry(""), null, "TRANSCRIPT", mode);
			assert.ok(
				user.endsWith(`\n\nYour instruction: ${EXPECTED_DEFAULT[mode]}\n\n${AGENT_LANGUAGE_LINE}`),
				`got: …${user.slice(-300)}`,
			);
		});

		it(`lets a filled box win in the ${mode} mode, in both messages`, () => {
			const written = "Make a shopping list.";
			assert.equal(systemMessage(entry(written), null, mode), `${AGENT_FIXED_PART}\n\n${written}`);
			const user = userMessage(entry(` ${written} `), null, "TRANSCRIPT", mode);
			assert.ok(
				user.endsWith(`\n\nYour instruction: ${written}\n\n${AGENT_LANGUAGE_LINE} ${AGENT_LANGUAGE_YIELDS}`),
				`got: …${user.slice(-300)}`,
			);
		});
	}
});

// The same through the adapter: the mode the lifecycle hands to `tick` is the one the request is built with.

class RecordingNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	async reach(): Promise<void> {}
	async send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Notes." } }] }) };
	}
	messages(): Array<{ role: string; content: string }> {
		return JSON.parse(new TextDecoder().decode(this.requests[0].body)).messages;
	}
}

async function sentFor(mode: RecordingModeKey, instruction: string): Promise<Array<{ role: string; content: string }>> {
	const world = makeFakeWorld();
	world.clock.set("2026-10-19T09:50:00+02:00");
	world.currentSettings.agents[mode] = entry(instruction);
	const network = new RecordingNetwork();
	const adapters = withServiceAgent(defaultAdapters(), {
		vault: world.vault,
		clock: world.clock,
		device: world.device,
		network,
		keys: { get: () => null },
		notes: { read: async () => null },
	});
	const request = buildRequestNote({
		audio: "Recording 20261019093539.m4a",
		audioBytes: 20_000,
		mode: MODE_WORDS[mode],
		recorded: "2026-10-19T09:35:39+02:00",
		linkedFrom: "2026-10-19 Planning",
		speakerSplit: mode === "meeting",
		participants: [],
		owner: "[[Robin Example]]",
		attempt: 1,
	});
	const done = markDone(setProperty(request, "transcriber", "home-pc"), {
		at: "2026-10-19T09:48:44+02:00",
		seconds: 40,
		text: formatTurn(0, "Speaker 1", "I have to call the bank tomorrow."),
	});
	world.vault.seed("Recording 20261019093539.md", serializeTranscriptNote(done));
	await new Lifecycle(world, adapters).tick(world.clock.now());
	assert.equal(network.requests.length, 1, "the agent was asked once");
	return network.messages();
}

describe("the agent step sends the recording's own mode's default", () => {
	for (const mode of RECORDING_MODE_KEYS) {
		it(`sends the ${mode} default in both messages for a ${MODE_WORDS[mode]} note with an empty box`, async () => {
			const [system, user] = await sentFor(mode, "");
			assert.equal(system.content, `${AGENT_FIXED_PART}\n\n${EXPECTED_DEFAULT[mode]}`);
			assert.ok(user.content.includes(`\n\nYour instruction: ${EXPECTED_DEFAULT[mode]}\n\n`));
		});
	}

	it("sends a filled box as written for a daily-log note", async () => {
		const [system, user] = await sentFor("dailyLog", "Make a shopping list.");
		assert.equal(system.content, `${AGENT_FIXED_PART}\n\nMake a shopping list.`);
		assert.ok(user.content.includes("\n\nYour instruction: Make a shopping list.\n\n"));
	});
});

// The settings page's placeholder. `settings-agent.ts` imports the `obsidian` package, which exists only
// inside Obsidian, so the import is answered here by a stand-in that records what the page asks of it.

interface Drawn {
	name: string;
	placeholder: string | undefined;
}

/** `module.registerHooks` (Node 24+): synchronous hooks, which the installed `@types/node` does not declare. */
type Step = (specifier: string, context: unknown) => unknown;
const registerHooks = (nodeModule as unknown as {
	registerHooks(hooks: { resolve: (specifier: string, context: unknown, next: Step) => unknown; load: (url: string, context: unknown, next: Step) => unknown }): void;
}).registerHooks;

describe("the settings page's instruction box", () => {
	const drawn: Drawn[] = [];
	(globalThis as Record<string, unknown>).__vaultRecorderDrawn = drawn;

	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "obsidian") return { url: "vault-recorder-test:obsidian", shortCircuit: true };
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url !== "vault-recorder-test:obsidian") return nextLoad(url, context);
			const source = `
				export class SecretComponent { constructor() {} setValue() { return this; } onChange() { return this; } }
				export class Setting {
					constructor() { this.entry = { name: "", placeholder: undefined }; globalThis.__vaultRecorderDrawn.push(this.entry); }
					setName(name) { this.entry.name = name; return this; }
					setDesc() { return this; }
					addComponent() { return this; }
					addText() { return this; }
					addTextArea(build) {
						const entry = this.entry;
						build({
							setPlaceholder(text) { entry.placeholder = text; return this; },
							setValue() { return this; },
							onChange() { return this; },
						});
						return this;
					}
				}`;
			return { format: "module", source, shortCircuit: true };
		},
	});

	async function placeholderOf(mode: RecordingModeKey): Promise<string | undefined> {
		const { renderAgentFields } = await import("./settings-agent.js");
		drawn.length = 0;
		const context = { app: {}, keys: { get: () => null }, save: async () => {}, redraw: () => {} };
		renderAgentFields({} as HTMLElement, mode, entry(""), context as never);
		const box = drawn.find((d) => d.name.endsWith("agent instruction"));
		assert.ok(box, "the instruction box is drawn");
		return box.placeholder;
	}

	for (const mode of RECORDING_MODE_KEYS) {
		it(`shows the ${mode} default as the placeholder`, async () => {
			assert.equal(await placeholderOf(mode), EXPECTED_DEFAULT[mode]);
		});
	}
});
