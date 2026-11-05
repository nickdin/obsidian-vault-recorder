import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { AGENT_LANGUAGE_LINE, AGENT_LANGUAGE_YIELDS, userMessage } from "./agent-service.js";
import type { AgentEntry } from "./settings-data.js";
import { buildRequestNote, formatTurn, markDone, serializeTranscriptNote } from "./transcript-note.js";

// The user message's last line names the transcript's language when the plugin knows it:
// the note's `language` property first, else a guess from the transcript text, else #170's generic line.

const SWEDISH = "Jag ska ringa banken i morgon och det är viktigt att jag inte glömmer det.";
const ENGLISH = "I will call the bank tomorrow and it is important that I do not forget it.";
const UNPLACEABLE = "Okej. Mm. Banken, imorgon.";

const entry = (instruction: string): AgentEntry => ({
	kind: "service",
	instruction,
	contextNotePath: "",
	address: "http://127.0.0.1:11434/v1",
	keyName: "",
	modelName: "llama3.2",
	chosenAt: "",
});

function transcript(text: string, language?: string): string {
	const request = buildRequestNote({
		audio: "Recording 20261025095911.m4a",
		audioBytes: 20_000,
		mode: "daily-log",
		recorded: "2026-10-25T09:59:11+02:00",
		speakerSplit: false,
		language,
		attempt: 1,
	});
	const done = markDone(request, { at: "2026-10-25T10:00:00+02:00", seconds: 4, text: formatTurn(0, "Speaker 1", text) });
	return serializeTranscriptNote(done);
}

const lastLine = (message: string): string => message.slice(message.lastIndexOf("\n\n") + 2);

describe("the language line of the user message", () => {
	it("names Swedish for a note with language: sv, whatever the text says", () => {
		const message = userMessage(entry(""), null, transcript(ENGLISH, "sv"), "dailyLog");
		assert.equal(lastLine(message), "Write your whole answer in Swedish, the transcript's language.");
	});

	it("names the language and still yields to a filled instruction box", () => {
		const message = userMessage(entry("Make bullet points."), null, transcript(ENGLISH, "sv"), "dailyLog");
		assert.equal(
			lastLine(message),
			`Write your whole answer in Swedish, the transcript's language. ${AGENT_LANGUAGE_YIELDS}`,
		);
	});

	it("names English for a note with language: en", () => {
		const message = userMessage(entry(""), null, transcript(SWEDISH, "en"), "dailyLog");
		assert.equal(lastLine(message), "Write your whole answer in English, the transcript's language.");
	});

	it("names Swedish for a Swedish transcript with no language property", () => {
		const message = userMessage(entry(""), null, transcript(SWEDISH), "dailyLog");
		assert.equal(lastLine(message), "Write your whole answer in Swedish, the transcript's language.");
	});

	it("gives the generic line for an English transcript with no language property", () => {
		const message = userMessage(entry(""), null, transcript(ENGLISH), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line for a transcript it cannot place", () => {
		const message = userMessage(entry(""), null, transcript(UNPLACEABLE), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line when a single Swedish word is all there is to go on", () => {
		const message = userMessage(entry(""), null, transcript("Okej, jag banken imorgon."), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line for a mixed transcript with three English words and two Swedish ones", () => {
		const message = userMessage(entry(""), null, transcript("Jag ska send the report and call you."), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line for a Norwegian transcript, which shares many words with Swedish", () => {
		const text = "Jeg skal ringe banken i morgen og det er viktig at jeg ikke glemmer det.";
		const message = userMessage(entry(""), null, transcript(text), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line for a Danish transcript, which shares many words with Swedish", () => {
		const text = "Jeg skal ringe banken i morgen, og det er vigtigt at jeg ikke glemmer det.";
		const message = userMessage(entry(""), null, transcript(text), "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});

	it("gives the generic line, with the yielding sentence, for one it cannot place when the box is filled", () => {
		const message = userMessage(entry("Tidy."), null, transcript(UNPLACEABLE), "dailyLog");
		assert.equal(lastLine(message), `${AGENT_LANGUAGE_LINE} ${AGENT_LANGUAGE_YIELDS}`);
	});

	it("treats a language property the plugin cannot name as unknown, and guesses from the text", () => {
		const message = userMessage(entry(""), null, transcript(SWEDISH, "zz-not-a-language"), "dailyLog");
		assert.equal(lastLine(message), "Write your whole answer in Swedish, the transcript's language.");
	});

	it("does not let Swedish words in the properties place the language", () => {
		const note = transcript(UNPLACEABLE).replace("mode:", "dessutom: och det är jag som har\nmode:");
		const message = userMessage(entry(""), null, note, "dailyLog");
		assert.equal(lastLine(message), AGENT_LANGUAGE_LINE);
	});
});
