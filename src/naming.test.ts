import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	clearNaming,
	displayOf,
	hasGivenNames,
	leaveRestUnnamed,
	renameSpeaker,
	speakerChoices,
	turnsIn,
	typedName,
	unnamedCount,
	unnamedLabels,
} from "./naming.js";
import {
	formatTurn,
	markDone,
	markTryAgain,
	parseTranscriptNote,
	readString,
	serializeTranscriptNote,
	type TranscriptNote,
} from "./transcript-note.js";

const HEAD = `---
rule-version: 1
audio: "[[Recording 20261019093539.m4a]]"
audio-bytes: 14123456
mode: meeting
recorded: 2026-10-19T09:35:39+02:00
speaker-split: true
participants: ["[[Anna Svensson]]", "Bo Berg", "[[Cecilia Dahl]]"]
owner: "[[Robin Example]]"
attempt: 1
transcribe: requested
---
`;

/** A done meeting: three speakers, the agent's summary naming two of them. */
function meeting(extra = ""): TranscriptNote {
	const parsed = parseTranscriptNote(HEAD + extra);
	assert.ok(parsed);
	const turns = [
		formatTurn(2, "Speaker 1", "Welcome, all."),
		formatTurn(9, "Speaker 2", "Thanks, Speaker 20 is late."),
		formatTurn(31, "Speaker 1", "Shall we start?"),
		formatTurn(75, "Speaker 3", "Yes."),
		formatTurn(80, "Speaker 2", "I have the numbers."),
	].join("\n\n");
	let note = markDone(parsed, {
		at: "2026-10-19T10:01:00+02:00",
		seconds: 3600,
		text: turns,
	});
	note = { ...note, body: note.body.replace("## Transcript", "## Agent\n\n- **Speaker 2:** sends the numbers\n- Speaker 1 chairs; Speaker 3 agrees\n\n## Transcript") };
	return note;
}

const textOf = (note: TranscriptNote): string => serializeTranscriptNote(note);

describe("turns and labels", () => {
	it("reads each turn's time in seconds and its label as written", () => {
		const turns = turnsIn(meeting().body);
		assert.deepEqual(
			turns.map((t) => [t.seconds, t.label]),
			[
				[2, "Speaker 1"],
				[9, "Speaker 2"],
				[31, "Speaker 1"],
				[75, "Speaker 3"],
				[80, "Speaker 2"],
			],
		);
	});

	it("reads an hour into the seconds", () => {
		assert.equal(turnsIn(formatTurn(3725, "Speaker 1", "late"))[0].seconds, 3725);
	});

	it("shows a link's words, and an alias", () => {
		assert.equal(displayOf("[[Anna Svensson]]"), "Anna Svensson");
		assert.equal(displayOf("[[Anna Svensson|Anna]]"), "Anna");
		assert.equal(displayOf("Bo Berg"), "Bo Berg");
	});
});

describe("the unnamed count", () => {
	it("counts the numbered labels left in the body, each once", () => {
		const note = meeting();
		assert.deepEqual(unnamedLabels(note), ["Speaker 2", "Speaker 1", "Speaker 3"]);
		assert.equal(unnamedCount(note), 3);
	});

	it("falls as speakers are named", () => {
		const note = renameSpeaker(meeting(), "Speaker 1", "[[Robin Example]]");
		assert.equal(unnamedCount(note), 2);
	});

	it("is zero once naming is finished, whatever is left", () => {
		assert.equal(unnamedCount(leaveRestUnnamed(meeting())), 0);
	});

	it("is zero for a transcript without a speaker split", () => {
		const note = markDone(parseTranscriptNote(HEAD)!, { at: "x", seconds: 1, text: "Just words." });
		assert.equal(unnamedCount(note), 0);
	});
});

describe("naming a speaker", () => {
	it("replaces the label in every turn of both sections", () => {
		const note = renameSpeaker(meeting(), "Speaker 2", "Bo Berg");
		const text = textOf(note);
		assert.ok(text.includes("[00:00:09] **Bo Berg:** Thanks"));
		assert.ok(text.includes("[00:01:20] **Bo Berg:** I have the numbers."));
		assert.ok(text.includes("- **Bo Berg:** sends the numbers"), "the agent's section changes too");
		assert.equal(text.includes("**Speaker 2:**"), false);
	});

	it("leaves the other speakers and a longer number alone", () => {
		const text = textOf(renameSpeaker(meeting(), "Speaker 2", "Bo Berg"));
		assert.ok(text.includes("**Speaker 1:** Welcome"));
		assert.ok(text.includes("**Speaker 3:** Yes."));
		assert.ok(text.includes("Speaker 20 is late"), "Speaker 20 is not Speaker 2");
	});

	it("replaces a bare label in the agent's running text, and nothing else", () => {
		const text = textOf(renameSpeaker(meeting(), "Speaker 1", "[[Robin Example]]"));
		assert.ok(text.includes("- [[Robin Example]] chairs; Speaker 3 agrees"));
	});

	it("leaves what somebody said alone, even when it says Speaker 1", () => {
		const note = meeting();
		const spoken = { ...note, body: note.body.replace("Shall we start?", "Speaker 1 is on mute, Speaker 1 again.") };
		const text = textOf(renameSpeaker(spoken, "Speaker 1", "[[Robin Example]]"));
		assert.ok(text.includes("**[[Robin Example]]:** Speaker 1 is on mute, Speaker 1 again."));
		assert.ok(text.includes("- [[Robin Example]] chairs; Speaker 3 agrees"), "the agent's running text still changes");
	});

	it("writes a participant exactly as listed, link and all", () => {
		const text = textOf(renameSpeaker(meeting(), "Speaker 3", "[[Cecilia Dahl]]"));
		assert.ok(text.includes("[00:01:15] **[[Cecilia Dahl]]:** Yes."));
	});

	it("writes a typed name as plain text", () => {
		const typed = typedName("  Dana   Ek ");
		assert.deepEqual(typed, { ok: true, written: "Dana Ek" });
		const text = textOf(renameSpeaker(meeting(), "Speaker 3", "Dana Ek"));
		assert.ok(text.includes("**Dana Ek:** Yes."));
		assert.equal(text.includes("[[Dana Ek]]"), false);
	});

	it("takes the written name literally, a dollar sign included", () => {
		const text = textOf(renameSpeaker(meeting(), "Speaker 3", "R$&D"));
		assert.ok(text.includes("**R$&D:** Yes."));
	});

	it("renames any label, a program's guess included", () => {
		const named = renameSpeaker(meeting(), "Speaker 3", "Anna");
		const again = renameSpeaker(named, "Anna", "[[Anna Svensson]]");
		const text = textOf(again);
		assert.ok(text.includes("**[[Anna Svensson]]:** Yes."));
		assert.equal(text.includes("**Anna:**"), false);
	});

	it("changes a guessed name only as a label, never in what somebody said", () => {
		const body = [formatTurn(1, "Anna", "Anna, can you hear me?"), formatTurn(5, "Speaker 2", "Yes.")].join("\n\n");
		const note = markDone(parseTranscriptNote(HEAD)!, { at: "x", seconds: 9, text: body });
		const text = textOf(renameSpeaker(note, "Anna", "[[Anna Svensson]]"));
		assert.ok(text.includes("**[[Anna Svensson]]:** Anna, can you hear me?"));
	});

	it("finds a linked name by the words a reader sees", () => {
		const note = markDone(parseTranscriptNote(HEAD)!, {
			at: "x",
			seconds: 9,
			text: formatTurn(1, "[[Anna Svensson]]", "Hello."),
		});
		const text = textOf(renameSpeaker(note, "Anna Svensson", "Bo Berg"));
		assert.ok(text.includes("**Bo Berg:** Hello."));
	});

	it("is the same note when the label is not there", () => {
		const note = meeting();
		assert.equal(renameSpeaker(note, "Speaker 9", "Bo Berg"), note);
	});

	it("leaves the properties as they were", () => {
		const before = meeting();
		const after = renameSpeaker(before, "Speaker 2", "Bo Berg");
		assert.deepEqual(after.properties, before.properties);
	});
});

describe("merging", () => {
	it("two labels given one name become one speaker", () => {
		let note = renameSpeaker(meeting(), "Speaker 2", "Bo Berg");
		note = renameSpeaker(note, "Speaker 3", "Bo Berg");
		const labels = turnsIn(note.body).map((t) => t.label);
		assert.deepEqual(labels, ["Speaker 1", "Bo Berg", "Speaker 1", "Bo Berg", "Bo Berg"]);
		assert.equal(unnamedCount(note), 1);
	});

	it("choosing a name already in the note is how the list merges", () => {
		const named = renameSpeaker(meeting(), "Speaker 2", "[[Anna Svensson]]");
		const offered = speakerChoices(named, "Speaker 3").map((c) => c.written);
		assert.ok(offered.includes("[[Anna Svensson]]"));
		const merged = renameSpeaker(named, "Speaker 3", "[[Anna Svensson]]");
		assert.equal(turnsIn(merged.body).filter((t) => t.label === "[[Anna Svensson]]").length, 3);
	});
});

describe("the list's order", () => {
	it("is the owner, then the participants not yet used, then the rest", () => {
		let note = renameSpeaker(meeting(), "Speaker 2", "Bo Berg");
		note = renameSpeaker(note, "Speaker 3", "Dana Ek");
		const choices = speakerChoices(note, "Speaker 1");
		assert.deepEqual(
			choices.map((c) => [c.group, c.written]),
			[
				["owner", "[[Robin Example]]"],
				["participant", "[[Anna Svensson]]"],
				["participant", "[[Cecilia Dahl]]"],
				["other", "Bo Berg"],
				["other", "Dana Ek"],
			],
		);
	});

	it("keeps the participants' own order", () => {
		const names = speakerChoices(meeting(), "Speaker 1").map((c) => c.written);
		assert.deepEqual(names, ["[[Robin Example]]", "[[Anna Svensson]]", "Bo Berg", "[[Cecilia Dahl]]"]);
	});

	it("offers the owner first even when the owner is already used", () => {
		const note = renameSpeaker(meeting(), "Speaker 1", "[[Robin Example]]");
		const choices = speakerChoices(note, "Speaker 2");
		assert.equal(choices[0].written, "[[Robin Example]]");
		assert.equal(choices.filter((c) => c.written === "[[Robin Example]]").length, 1);
	});

	it("does not offer the label being renamed", () => {
		const note = renameSpeaker(meeting(), "Speaker 1", "[[Anna Svensson]]");
		const names = speakerChoices(note, "[[Anna Svensson]]").map((c) => c.written);
		assert.equal(names.includes("[[Anna Svensson]]"), false);
	});

	it("offers no Speaker N, and only the owner when the meeting note listed nobody", () => {
		const bare = parseTranscriptNote(HEAD.replace(/participants:.*\n/, ""))!;
		const note = markDone(bare, { at: "x", seconds: 1, text: formatTurn(1, "Speaker 1", "Hi") });
		assert.deepEqual(speakerChoices(note, "Speaker 1").map((c) => c.written), ["[[Robin Example]]"]);
	});

	it("shows what a reader sees beside what is written", () => {
		const first = speakerChoices(meeting(), "Speaker 1")[0];
		assert.deepEqual(first, { written: "[[Robin Example]]", display: "Robin Example", group: "owner" });
	});
});

describe("a typed name", () => {
	it("refuses a blank one", () => {
		assert.equal(typedName("   ").ok, false);
	});

	it("refuses what would break the bold label or write a link", () => {
		for (const bad of ["Anna **", "[[Anna]]", "a]b"]) assert.equal(typedName(bad).ok, false, bad);
	});
});

describe("leave the rest unnamed", () => {
	it("writes naming: finished and leaves the text", () => {
		const before = meeting();
		const after = leaveRestUnnamed(before);
		assert.equal(readString(after, "naming"), "finished");
		assert.equal(after.body, before.body);
	});

	it("puts the property after the plugin's own request lines, in the rule's order", () => {
		const keys = leaveRestUnnamed(meeting()).properties.map((p) => p.key);
		assert.equal(keys[keys.length - 1], "naming");
	});

	it("is cleared by try again, which also says that names will be lost", () => {
		const finished = leaveRestUnnamed(meeting());
		assert.equal(hasGivenNames(finished), true);
		const again = markTryAgain(clearNaming(finished));
		assert.equal(readString(again, "naming"), undefined);
		assert.equal(readString(again, "attempt"), "2");
	});

	it("knows when no names were given, so there is nothing to lose", () => {
		assert.equal(hasGivenNames(meeting()), false);
		assert.equal(hasGivenNames(renameSpeaker(meeting(), "Speaker 2", "Bo Berg")), true);
	});
});
