import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { renameSpeaker, typedName } from "./naming.js";
import {
	formatTurn,
	markDone,
	parseTranscriptNote,
	type TranscriptNote,
} from "./transcript-note.js";

const HEAD = `---
rule-version: 1
audio: "[[Recording 20261019093539.m4a]]"
audio-bytes: 14123456
mode: meeting
recorded: 2026-10-19T09:35:39+02:00
speaker-split: true
attempt: 1
transcribe: requested
---
`;

/** A done meeting whose agent section is exactly `agent`. */
function withAgent(agent: string): TranscriptNote {
	const parsed = parseTranscriptNote(HEAD);
	assert.ok(parsed);
	const done = markDone(parsed, {
		at: "2026-10-19T10:01:00+02:00",
		seconds: 3600,
		text: [formatTurn(2, "Speaker 1", "Hello."), formatTurn(9, "Speaker 2", "Hi.")].join("\n\n"),
	});
	return { ...done, body: done.body.replace("## Transcript", `## Agent\n\n${agent}\n\n## Transcript`) };
}

describe("renaming inside the agent's section", () => {
	it("changes Speaker 1 in plain prose and nowhere it is a link target or code", () => {
		const note = withAgent(
			[
				"Speaker 1 opened.",
				"See [[Notes#Speaker 1]] and [[Speaker 1]].",
				"Read [the page](https://example.com/Speaker 1/notes) too.",
				"Run `Speaker 1` as written, or ``a `Speaker 1` b``.",
			].join("\n"),
		);
		const after = renameSpeaker(note, "Speaker 1", "Anna");
		const agent = after.body.split("## Agent")[1].split("## Transcript")[0];
		assert.match(agent, /^\s*Anna opened\./);
		assert.ok(agent.includes("[[Notes#Speaker 1]]"), "wikilink heading kept");
		assert.ok(agent.includes("[[Speaker 1]]"), "wikilink target kept");
		assert.ok(agent.includes("(https://example.com/Speaker 1/notes)"), "markdown link URL kept");
		assert.ok(agent.includes("`Speaker 1`"), "code span kept");
		assert.ok(agent.includes("``a `Speaker 1` b``"), "double-backtick code span kept");
		assert.ok(!agent.includes("[[Notes#Anna"), "no link was rewritten");
	});

	it("still changes the words of a markdown link's own text", () => {
		const note = withAgent("Ask [Speaker 1](https://example.com) about it.");
		const agent = renameSpeaker(note, "Speaker 1", "Anna").body;
		assert.ok(agent.includes("[Anna](https://example.com)"));
	});
});

describe("a typed name that would break the label", () => {
	for (const [what, input] of [
		["a backtick", "Bo`x"],
		["a trailing backslash", "Bo\\"],
		["a trailing backslash after spaces", "Bo \\  "],
		["Speaker 3", "Speaker 3"],
		["Speaker 12 with odd spacing", "  Speaker   12 "],
	] as const) {
		it(`refuses ${what}, with a reason`, () => {
			const result = typedName(input);
			assert.equal(result.ok, false, input);
			if (!result.ok) assert.ok(result.reason.length > 10, "a reason is given");
		});
	}

	it("still accepts a plain name, an apostrophe, and a name that merely starts with Speaker", () => {
		for (const good of ["Bo Berg", "O'Neil", "Speaker Anna", "Speaker 3b"]) {
			assert.equal(typedName(good).ok, true, good);
		}
	});
});
