import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	describeAgentSends,
	describeTranscriberSends,
	renderSendsList,
	sendsLines,
	type SendsListElement,
} from "./settings-sends.js";
import { DEFAULT_SETTINGS } from "./settings-data.js";

/** A list element in memory: each line is a record whose text `setText` replaces. */
function fakeList() {
	const lines: { text: string }[] = [];
	const list: SendsListElement = {
		createEl: (_tag, options) => {
			const line = { text: options.text };
			lines.push(line);
			return { setText: (text: string) => void (line.text = text) };
		},
	};
	return { list, lines };
}

function serviceSettings() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.transcribers.cursor.kind = "service";
	settings.agents.cursor.kind = "service";
	return settings;
}

describe("describeTranscriberSends / describeAgentSends", () => {
	it("names the address a service sends to, and a plain sign when none is set", () => {
		assert.match(describeTranscriberSends({ kind: "service", address: "" }), /\(no address set yet\)\/audio\/transcriptions/);
		assert.match(describeTranscriberSends({ kind: "service", address: " https://a.example/v1/ " }), /to https:\/\/a\.example\/v1\/audio\/transcriptions/);
		assert.match(describeAgentSends({ kind: "service", address: "http://127.0.0.1:11434/v1" }), /to http:\/\/127\.0\.0\.1:11434\/v1\/chat\/completions/);
	});

	it("gives a different line when the same entry's address changes", () => {
		const entry = { kind: "service" as const, address: "https://one.example/v1" };
		const before = describeTranscriberSends(entry);
		entry.address = "https://two.example/v1";
		assert.notEqual(describeTranscriberSends(entry), before);
	});
});

describe("renderSendsList", () => {
	it("draws one line per transcriber and agent of the three modes", () => {
		const { list, lines } = fakeList();
		renderSendsList(list, serviceSettings());
		assert.equal(lines.length, 6);
		assert.deepEqual(lines.map((l) => l.text), sendsLines(serviceSettings()));
	});

	it("refresh shows an address typed after the lines were drawn", () => {
		const settings = serviceSettings();
		const { list, lines } = fakeList();
		const sends = renderSendsList(list, settings);
		assert.match(lines[2].text, /\(no address set yet\)\/audio\/transcriptions/);
		assert.match(lines[3].text, /\(no address set yet\)\/chat\/completions/);

		settings.transcribers.cursor.address = "https://typed.example/v1";
		settings.agents.cursor.address = "https://agent.example/v1";
		sends.refresh();

		assert.match(lines[2].text, /to https:\/\/typed\.example\/v1\/audio\/transcriptions/);
		assert.match(lines[3].text, /to https:\/\/agent\.example\/v1\/chat\/completions/);
	});

	it("refresh follows a changed kind as well, and leaves untouched lines as they were", () => {
		const settings = serviceSettings();
		const { list, lines } = fakeList();
		const sends = renderSendsList(list, settings);
		const first = lines[0].text;
		settings.transcribers.cursor.kind = "none";
		sends.refresh();
		assert.match(lines[2].text, /nothing is sent; the recording is kept as audio only/);
		assert.equal(lines[0].text, first);
	});
});
