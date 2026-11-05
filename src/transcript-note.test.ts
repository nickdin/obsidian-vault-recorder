import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	buildRequestNote,
	deriveState,
	flowList,
	formatTimestamp,
	formatTurn,
	markAgentDone,
	markAgentFailed,
	markAgentRequested,
	markAgentWorking,
	markCancelled,
	markDone,
	markFailed,
	markProgress,
	markTaken,
	markTryAgain,
	PROPERTY_ORDER,
	SECTION_HEADINGS,
	parseTimestamp,
	parseTranscriptNote,
	quote,
	readBoolean,
	readInteger,
	readList,
	readProperty,
	readSection,
	readString,
	removeProperty,
	serializeTranscriptNote,
	setProperty,
	writeSection,
	type AgentState,
	type TranscriberState,
	type TranscriptNote,
	type TranscriptRequest,
} from "./transcript-note.js";

// `npm test` runs from the repository root.
const FIXTURES = path.join(process.cwd(), "docs", "hand-off-fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");
const text = (note: TranscriptNote): string => serializeTranscriptNote(note);

// --- The fixtures, built from typed input through the producers -----------------------------

const TRANSCRIBER = { name: "vault-transcriber 2.0" };
const AGENT = { name: "home-pc" };

const MEETING_TURNS = [
	formatTurn(3, "Speaker 1", "Welcome, everyone. Let us start with the plan for the autumn."),
	formatTurn(11, "Speaker 2", "Thanks. I have two points, the budget and the schedule."),
	formatTurn(754, "Speaker 1", "Then we agree on the schedule and meet again on Friday."),
].join("\n\n");

const MEETING_PLAIN = [
	"Welcome, everyone. Let us start with the plan for the autumn.",
	"Thanks. I have two points, the budget and the schedule.",
	"Then we agree on the schedule and meet again on Friday.",
].join("\n\n");

const DAILY_LOG_TEXT =
	"Remember to ask Anna about the budget before Friday.\n\nAlso order the new cable for the projector.";

const AGENT_TEXT =
	"The meeting agreed the schedule for the autumn.\n\nDecisions:\n- The schedule stands.\n\nActions:\n- Meet again on Friday (Speaker 1).";

const dailyLogRequest: TranscriptRequest = {
	audio: "Recording 20261019091200.m4a",
	audioBytes: 2314752,
	mode: "daily-log",
	recorded: "2026-10-19T09:12:00+02:00",
	linkedFrom: "2026-10-19",
	speakerSplit: false,
	attempt: 1,
};

const meetingRequest: TranscriptRequest = {
	audio: "Recording 20261019093539.m4a",
	audioBytes: 14123456,
	mode: "meeting",
	recorded: "2026-10-19T09:35:39+02:00",
	linkedFrom: "2026-10-19 Planning",
	speakerSplit: true,
	participants: ["[[Anna Svensson]]", "Bo Berg"],
	owner: "[[Robin Example]]",
	language: "sv",
	attempt: 1,
};

const oldCursorRequest: TranscriptRequest = {
	audio: "Recording 20261017075900.m4a",
	audioBytes: 5120000,
	mode: "cursor",
	recorded: "2026-10-17T08:00:00+02:00",
	linkedFrom: "Ideas",
	speakerSplit: false,
	attempt: 1,
};

/** Every fixture but one is a hand-off request: a program's to take. */
const HAND_OFF = { transcribeKind: "hand-off" } as const;

function builtFixtures(): Record<string, TranscriptNote> {
	const f01 = buildRequestNote({ ...dailyLogRequest, ...HAND_OFF });
	const f02 = buildRequestNote({ ...meetingRequest, ...HAND_OFF });
	const f03 = markProgress(markTaken(f02, { ...TRANSCRIBER, at: "2026-10-19T09:36:10+02:00" }), 42);
	const f04 = markDone(f03, { at: "2026-10-19T09:48:44+02:00", seconds: 754, text: MEETING_TURNS });
	const f05 = markDone(f03, {
		at: "2026-10-19T09:48:44+02:00",
		seconds: 754,
		text: MEETING_PLAIN,
		withoutSpeakerSplit: true,
	});
	const f06 = markDone(markTaken(f01, { ...TRANSCRIBER, at: "2026-10-19T09:13:02+02:00" }), {
		at: "2026-10-19T09:14:20+02:00",
		seconds: 98,
		text: DAILY_LOG_TEXT,
	});
	const f07 = markFailed(markTaken(f02, { ...TRANSCRIBER, at: "2026-10-19T09:36:10+02:00" }), {
		at: "2026-10-19T09:37:02+02:00",
		reason: "the audio could not be decoded",
	});
	const f08 = markCancelled(f01);
	const f09 = markDone(
		markCancelled(markTaken(f01, { ...TRANSCRIBER, at: "2026-10-19T09:13:02+02:00" })),
		{ at: "2026-10-19T09:14:20+02:00", seconds: 98, text: DAILY_LOG_TEXT },
	);
	const f10 = markTryAgain(f07, "hand-off");
	const f11 = buildRequestNote({ ...oldCursorRequest, ...HAND_OFF });
	const f12 = markProgress(
		markTaken(f11, { ...TRANSCRIBER, at: "2026-10-18T08:00:00+02:00" }),
		10,
	);
	const f13 = markFailed(
		setProperty(
			buildRequestNote({
				...meetingRequest,
				...HAND_OFF,
				participants: undefined,
				owner: undefined,
				language: undefined,
			}),
			"rule-version",
			"2",
		),
		{ ...TRANSCRIBER, at: "2026-10-19T09:36:10+02:00", reason: "unknown rule version 2" },
	);
	const f14 = markTryAgain(
		setProperty(
			markDone(
				markTaken(
					buildRequestNote({
						...oldCursorRequest,
						...HAND_OFF,
						audio: "Recording 20260901101500.m4a",
						audioBytes: 9876543,
						recorded: "2026-09-01T10:15:00+02:00",
					}),
					{ ...TRANSCRIBER, at: "2026-09-01T10:16:00+02:00" },
				),
				{
					at: "2026-09-01T10:19:30+02:00",
					seconds: 270,
					text: "The first idea is to move the weekly review to Monday morning.",
				},
			),
			"audio-deleted",
			"2026-10-01",
		),
		"hand-off",
	);
	const f15 = markAgentRequested(f04, { kind: "hand-off" });
	const f16 = markAgentWorking(f15, { ...AGENT, at: "2026-10-19T09:50:02+02:00" });
	const f17 = markAgentDone(
		markAgentWorking(f15, { ...AGENT, at: "2026-10-19T09:50:02+02:00" }),
		{ at: "2026-10-19T09:51:30+02:00", text: AGENT_TEXT },
	);
	const f18 = markAgentFailed(f16, {
		at: "2026-10-19T09:50:40+02:00",
		reason: "the model did not answer",
	});
	const f19 = markAgentWorking(
		markAgentRequested(
			markDone(
				markTaken(
					buildRequestNote({
						audio: "Recording 20261018075900.m4a",
						audioBytes: 8123456,
						mode: "meeting",
						recorded: "2026-10-18T08:00:00+02:00",
						linkedFrom: "2026-10-18 Review",
						speakerSplit: true,
						attempt: 1,
						...HAND_OFF,
					}),
					{ ...TRANSCRIBER, at: "2026-10-18T08:00:30+02:00" },
				),
				{
					at: "2026-10-18T08:12:00+02:00",
					seconds: 720,
					text: formatTurn(2, "Speaker 1", "Let us go through last week's numbers."),
				},
			),
			{ kind: "hand-off" },
		),
		{ ...AGENT, at: "2026-10-18T08:13:00+02:00" },
	);
	return {
		"01-requested-daily-log.md": f01,
		"02-requested-meeting.md": f02,
		"03-taken.md": f03,
		"04-done.md": f04,
		"05-done-without-speaker-split.md": f05,
		"06-done-daily-log.md": f06,
		"07-failed.md": f07,
		"08-cancelled.md": f08,
		"09-cancelled-late-transcript.md": f09,
		"10-try-again.md": f10,
		"11-overdue-waiting.md": f11,
		"12-overdue-taken.md": f12,
		"13-unknown-rule-version.md": f13,
		"14-audio-deleted.md": f14,
		"15-agent-requested.md": f15,
		"16-agent-working.md": f16,
		"17-agent-done.md": f17,
		"18-agent-failed.md": f18,
		"19-agent-overdue.md": f19,
		"21-agent-run-again.md": markAgentRequested(f19, { kind: "hand-off", raisedAt: "2026-10-19T12:00:00+02:00" }),
		"22-not-for-a-program.md": buildRequestNote({
			...oldCursorRequest,
			audio: "Recording 20261019100000.m4a",
			audioBytes: 3145728,
			recorded: "2026-10-19T10:00:00+02:00",
			transcribeKind: "service",
		}),
	};
}

/** What the plugin derives from each fixture at NOW, with the overdue time at 24 hours. */
const NOW = new Date("2026-10-19T12:00:00+02:00");
const EXPECTED: Record<
	string,
	{
		transcriber: TranscriberState;
		transcriberOverdue?: true;
		agent?: AgentState;
		agentOverdue?: true;
	}
> = {
	"01-requested-daily-log.md": { transcriber: "waiting" },
	"02-requested-meeting.md": { transcriber: "waiting" },
	"03-taken.md": { transcriber: "being-transcribed" },
	"04-done.md": { transcriber: "done" },
	"05-done-without-speaker-split.md": { transcriber: "done-without-speaker-split" },
	"06-done-daily-log.md": { transcriber: "done" },
	"07-failed.md": { transcriber: "failed" },
	"08-cancelled.md": { transcriber: "cancelled" },
	"09-cancelled-late-transcript.md": { transcriber: "done" },
	"10-try-again.md": { transcriber: "waiting" },
	"11-overdue-waiting.md": { transcriber: "waiting", transcriberOverdue: true },
	"12-overdue-taken.md": { transcriber: "being-transcribed", transcriberOverdue: true },
	"13-unknown-rule-version.md": { transcriber: "unknown-rule-version" },
	"14-audio-deleted.md": { transcriber: "waiting", transcriberOverdue: true },
	"15-agent-requested.md": { transcriber: "done", agent: "waiting" },
	"16-agent-working.md": { transcriber: "done", agent: "working" },
	"17-agent-done.md": { transcriber: "done", agent: "done" },
	"18-agent-failed.md": { transcriber: "done", agent: "failed" },
	"19-agent-overdue.md": { transcriber: "done", agent: "working", agentOverdue: true },
	"21-agent-run-again.md": { transcriber: "done", agent: "waiting" },
	"22-not-for-a-program.md": { transcriber: "waiting" },
};

describe("the fixtures", () => {
	const built = builtFixtures();

	it("are exactly the ones these tests know, plus the note that is not the plugin's", () => {
		assert.deepEqual(
			readdirSync(FIXTURES).sort(),
			[...Object.keys(built), "20-not-ours.md"].sort(),
		);
		assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(built).sort());
	});

	for (const name of Object.keys(built)) {
		it(`${name}: parsing and writing it back gives the same bytes`, () => {
			const parsed = parseTranscriptNote(fixture(name));
			assert.ok(parsed, "a fixture with a rule-version parses");
			assert.equal(text(parsed), fixture(name));
		});

		it(`${name}: the producers write exactly this file`, () => {
			assert.equal(text(built[name]), fixture(name));
		});

		it(`${name}: the plugin derives the documented state`, () => {
			const parsed = parseTranscriptNote(fixture(name));
			assert.ok(parsed);
			const expected = EXPECTED[name];
			assert.deepEqual(deriveState(parsed, NOW, 24), {
				transcriber: expected.transcriber,
				transcriberOverdue: expected.transcriberOverdue ?? false,
				agent: expected.agent ?? "none",
				agentOverdue: expected.agentOverdue ?? false,
			});
		});
	}

	it("20-not-ours.md has no rule-version, so it is not the plugin's", () => {
		assert.equal(parseTranscriptNote(fixture("20-not-ours.md")), null);
	});
});

describe("a note that is not the plugin's", () => {
	it("is ignored without a rule-version, whatever else it carries", () => {
		assert.equal(parseTranscriptNote("---\ntranscribe: requested\nattempt: 1\n---\n"), null);
	});

	it("is ignored without properties at all", () => {
		assert.equal(parseTranscriptNote("# Just a note\n\nrule-version: 1\n"), null);
		assert.equal(parseTranscriptNote(""), null);
	});
});

describe("the language in a request", () => {
	it("is written quoted, so a YAML reader takes 'no' as the string and not as false", () => {
		const request = { ...meetingRequest, language: "no" };
		const text = serializeTranscriptNote(buildRequestNote(request));
		assert.ok(text.includes('\nlanguage: "no"\n'));
		const note = parseTranscriptNote(text);
		assert.ok(note);
		assert.equal(readString(note, "language"), "no");
	});
});

describe("reading values", () => {
	const note = parseTranscriptNote(
		[
			"---",
			"rule-version: 1",
			'participants: ["[[Anna Svensson]]", \'Bo Berg\', Cy]',
			"owner: \"A \\\"quoted\\\" name\"",
			"language: sv # the code",
			"speaker-split: true",
			"attempt: 3",
			"keep-audio: maybe",
			"extra:",
			'  - "first"',
			"  - second",
			"---",
			"",
		].join("\n"),
	);

	it("reads flow lists with double quotes, single quotes and bare items", () => {
		assert.ok(note);
		assert.deepEqual(readList(note, "participants"), ["[[Anna Svensson]]", "Bo Berg", "Cy"]);
	});

	it("reads block lists", () => {
		assert.ok(note);
		assert.deepEqual(readList(note, "extra"), ["first", "second"]);
	});

	it("unescapes quoted strings and drops a trailing comment from a plain one", () => {
		assert.ok(note);
		assert.equal(readString(note, "owner"), 'A "quoted" name');
		assert.equal(readString(note, "language"), "sv");
	});

	it("reads integers and booleans, and nothing for a value that is neither", () => {
		assert.ok(note);
		assert.equal(readInteger(note, "attempt"), 3);
		assert.equal(readBoolean(note, "speaker-split"), true);
		assert.equal(readBoolean(note, "keep-audio"), undefined);
		assert.equal(readInteger(note, "language"), undefined);
		assert.equal(readProperty(note, "absent"), undefined);
	});
});

describe("writing values", () => {
	it("quotes and escapes, and lists with a comma and a space", () => {
		assert.equal(quote('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
		assert.equal(flowList(["a", "b"]), '["a", "b"]');
		assert.equal(flowList([]), "[]");
	});

	it("puts a new property at its place in the rule's order, whatever order it is written in", () => {
		let note = buildRequestNote(dailyLogRequest);
		note = setProperty(note, "transcriber-attempt", "1");
		note = setProperty(note, "transcriber", "p");
		note = setProperty(note, "audio-deleted", "2026-10-01");
		note = setProperty(note, "transcriber-state", "taken");
		assert.deepEqual(
			note.properties.map((p) => p.key).slice(-5),
			["transcribe", "transcriber", "transcriber-state", "transcriber-attempt", "audio-deleted"],
		);
	});

	it("leaves every other property exactly as written, including one it does not know", () => {
		const original = [
			"---",
			"rule-version: 1",
			"attempt: 1",
			"my-own:    spaced   value",
			"transcribe: requested",
			"---",
			"body stays",
			"",
		].join("\n");
		const note = parseTranscriptNote(original);
		assert.ok(note);
		const changed = text(setProperty(note, "attempt", "2"));
		assert.equal(changed, original.replace("attempt: 1", "attempt: 2"));
		assert.equal(text(removeProperty(note, "attempt")), original.replace("attempt: 1\n", ""));
	});
});

describe("timestamps", () => {
	it("writes the local time and its offset", () => {
		const at = new Date("2026-10-19T07:35:39Z");
		assert.equal(formatTimestamp(at, 120), "2026-10-19T09:35:39+02:00");
	});

	it("uses the offset it is given, not the machine's own zone", () => {
		const at = new Date("2026-10-19T07:35:39Z");
		assert.equal(formatTimestamp(at, -300), "2026-10-19T02:35:39-05:00");
		assert.equal(formatTimestamp(at, 330), "2026-10-19T13:05:39+05:30");
		assert.equal(formatTimestamp(at, 0), "2026-10-19T07:35:39+00:00");
	});

	it("moves the date with the offset", () => {
		assert.equal(
			formatTimestamp(new Date("2026-10-19T23:30:00Z"), 120),
			"2026-10-20T01:30:00+02:00",
		);
	});

	it("reads back what it writes, and refuses a shape it does not write", () => {
		const written = formatTimestamp(new Date("2026-10-19T07:35:39Z"), 120);
		assert.equal(parseTimestamp(written), Date.parse("2026-10-19T07:35:39Z"));
		assert.equal(parseTimestamp("19 October"), null);
		assert.equal(parseTimestamp(undefined), null);
	});
});

describe("sections", () => {
	const request = buildRequestNote(dailyLogRequest);

	it("a note without a body has no sections", () => {
		assert.equal(readSection(request, "transcript"), undefined);
		assert.equal(readSection(request, "agent"), undefined);
	});

	it("writing the transcript replaces it whole, and writing the agent puts it first", () => {
		const first = writeSection(request, "transcript", "one\n\ntwo");
		const replaced = writeSection(first, "transcript", "three");
		assert.equal(readSection(replaced, "transcript"), "three");
		const withAgent = writeSection(replaced, "agent", "answer");
		assert.equal(
			withAgent.body,
			"\n## Agent\n\nanswer\n\n## Transcript\n\nthree\n",
		);
		assert.equal(readSection(withAgent, "agent"), "answer");
	});

	it("replacing the agent's section leaves the transcript alone", () => {
		const both = parseTranscriptNote(fixture("17-agent-done.md"));
		assert.ok(both);
		const changed = writeSection(both, "agent", "new answer");
		assert.equal(readSection(changed, "agent"), "new answer");
		assert.equal(readSection(changed, "transcript"), readSection(both, "transcript"));
	});

	it("keeps text written above the first heading", () => {
		const note = { ...request, body: "\nMy own remark.\n\n## Transcript\n\nold\n" };
		const changed = writeSection(note, "transcript", "new");
		assert.equal(changed.body, "\nMy own remark.\n\n## Transcript\n\nnew\n");
	});

	it("reads a section up to the next heading of the rule, not the next heading of any kind", () => {
		const note = { ...request, body: "\n## Agent\n\nSummary\n\n### Details\n\nmore\n\n## Transcript\n\nt\n" };
		assert.equal(readSection(note, "agent"), "Summary\n\n### Details\n\nmore");
		assert.equal(readSection(note, "transcript"), "t");
	});
});

describe("a turn", () => {
	it("is the time in hours, minutes and seconds, then the speaker in bold", () => {
		assert.equal(formatTurn(754, "Speaker 1", "Hello."), "[00:12:34] **Speaker 1:** Hello.");
		assert.equal(formatTurn(3725, "Anna", "Hi."), "[01:02:05] **Anna:** Hi.");
	});
});

describe("deriving the transcriber's state", () => {
	const derive = (note: TranscriptNote, now = NOW) => deriveState(note, now, 24);
	const requested = (): TranscriptNote => buildRequestNote(meetingRequest);
	const atTaken = (note: TranscriptNote): TranscriptNote =>
		markTaken(note, { ...TRANSCRIBER, at: "2026-10-19T09:36:10+02:00" });

	it("an answer to an earlier attempt leaves the note waiting", () => {
		const failedOnce = markFailed(atTaken(requested()), {
			at: "2026-10-19T09:37:02+02:00",
			reason: "x",
		});
		assert.equal(derive(failedOnce).transcriber, "failed");
		assert.equal(derive(markTryAgain(failedOnce)).transcriber, "waiting");
	});

	it("a transcript that lands after a cancel is shown as done", () => {
		const cancelled = markCancelled(atTaken(requested()));
		assert.equal(derive(cancelled).transcriber, "cancelled");
		const landed = markDone(cancelled, { at: "2026-10-19T09:48:44+02:00", seconds: 1, text: "t" });
		assert.equal(derive(landed).transcriber, "done");
	});

	it("a cancel wins over a claim that has not finished, and over a failure", () => {
		assert.equal(derive(markCancelled(atTaken(requested()))).transcriber, "cancelled");
		const failed = markFailed(atTaken(requested()), { at: "2026-10-19T09:37:02+02:00", reason: "x" });
		assert.equal(derive(markCancelled(failed)).transcriber, "cancelled");
	});

	it("trying again after a cancel asks afresh", () => {
		const again = markTryAgain(markCancelled(requested()));
		assert.equal(readString(again, "transcribe"), "requested");
		assert.equal(readInteger(again, "attempt"), 2);
		assert.equal(derive(again).transcriber, "waiting");
	});

	it("a state word it does not know is no answer at all", () => {
		const odd = setProperty(atTaken(requested()), "transcriber-state", "finished");
		assert.equal(derive(odd).transcriber, "waiting");
	});

	it("a note whose rule-version it does not know is reported as such, not read", () => {
		const v2 = setProperty(requested(), "rule-version", "2");
		assert.equal(derive(v2).transcriber, "unknown-rule-version");
		const garbled = setProperty(requested(), "rule-version", "one");
		assert.equal(derive(garbled).transcriber, "unknown-rule-version");
	});

	it("waiting turns overdue only after the overdue time, counted on the clock it is given", () => {
		const note = requested(); // recorded 2026-10-19T09:35:39+02:00
		const justUnder = new Date("2026-10-20T09:35:39+02:00");
		const justOver = new Date("2026-10-20T09:35:40+02:00");
		assert.equal(derive(note, justUnder).transcriberOverdue, false);
		assert.equal(derive(note, justOver).transcriberOverdue, true);
		assert.equal(deriveState(note, justOver, 48).transcriberOverdue, false);
	});

	it("taken turns overdue from its last change, not from the recording", () => {
		const taken = atTaken(requested()); // recorded 09:35:39, taken 09:36:10
		const now = new Date("2026-10-20T09:36:00+02:00"); // over 24 h from recorded, under from taken
		assert.equal(derive(taken, now).transcriberOverdue, false);
		assert.equal(derive(taken, new Date("2026-10-20T09:36:11+02:00")).transcriberOverdue, true);
	});

	it("a finished or failed or cancelled note is never overdue", () => {
		const much = new Date("2027-01-01T00:00:00+01:00");
		const done = markDone(atTaken(requested()), { at: "2026-10-19T09:48:44+02:00", seconds: 1, text: "t" });
		assert.equal(derive(done, much).transcriberOverdue, false);
		assert.equal(derive(markCancelled(requested()), much).transcriberOverdue, false);
		const failed = markFailed(atTaken(requested()), { at: "2026-10-19T09:37:02+02:00", reason: "x" });
		assert.equal(derive(failed, much).transcriberOverdue, false);
	});

	it("a timestamp it cannot read is never overdue", () => {
		const odd = setProperty(requested(), "recorded", "yesterday");
		assert.equal(derive(odd, new Date("2030-01-01T00:00:00Z")).transcriberOverdue, false);
	});

	it("a request without an attempt counts as attempt 1", () => {
		const bare = removeProperty(atTaken(requested()), "attempt");
		assert.equal(derive(bare).transcriber, "being-transcribed");
	});
});

describe("deriving the agent's state", () => {
	const doneNote = (): TranscriptNote =>
		markDone(markTaken(buildRequestNote(meetingRequest), { ...TRANSCRIBER, at: "2026-10-19T09:36:10+02:00" }), {
			at: "2026-10-19T09:48:44+02:00",
			seconds: 1,
			text: "t",
		});
	const derive = (note: TranscriptNote, now = NOW) => deriveState(note, now, 24);

	it("there is no agent until one is asked for", () => {
		assert.equal(derive(doneNote()).agent, "none");
	});

	it("asked, then working, then done or failed", () => {
		const asked = markAgentRequested(doneNote());
		assert.equal(derive(asked).agent, "waiting");
		const working = markAgentWorking(asked, { ...AGENT, at: "2026-10-19T09:50:02+02:00" });
		assert.equal(derive(working).agent, "working");
		assert.equal(
			derive(markAgentDone(working, { at: "2026-10-19T09:51:30+02:00", text: "a" })).agent,
			"done",
		);
		assert.equal(
			derive(markAgentFailed(working, { at: "2026-10-19T09:51:30+02:00", reason: "x" })).agent,
			"failed",
		);
	});

	it("an answer to an earlier agent attempt leaves it waiting", () => {
		const failed = markAgentFailed(markAgentRequested(doneNote()), {
			at: "2026-10-19T09:51:30+02:00",
			reason: "x",
		});
		const again = markAgentRequested(failed);
		assert.equal(readInteger(again, "agent-attempt"), 2);
		assert.equal(derive(again).agent, "waiting");
	});

	it("working is overdue from its last change, waiting from when the transcript was done", () => {
		const asked = markAgentRequested(doneNote()); // transcript done 09:48:44
		assert.equal(derive(asked, new Date("2026-10-20T09:48:44+02:00")).agentOverdue, false);
		assert.equal(derive(asked, new Date("2026-10-20T09:48:45+02:00")).agentOverdue, true);
		const working = markAgentWorking(asked, { ...AGENT, at: "2026-10-19T11:00:00+02:00" });
		assert.equal(derive(working, new Date("2026-10-20T10:59:59+02:00")).agentOverdue, false);
		assert.equal(derive(working, new Date("2026-10-20T11:00:01+02:00")).agentOverdue, true);
	});

	it("a cancelled agent is cancelled, unless its answer already landed", () => {
		const asked = markAgentRequested(doneNote());
		const cancelled = setProperty(asked, "agent", "cancelled");
		assert.equal(derive(cancelled).agent, "cancelled");
		const landed = markAgentDone(
			markAgentWorking(cancelled, { ...AGENT, at: "2026-10-19T09:50:02+02:00" }),
			{ at: "2026-10-19T09:51:30+02:00", text: "a" },
		);
		assert.equal(derive(landed).agent, "done");
	});
});

describe("the published rule document", () => {
	const rule = readFileSync(path.join(process.cwd(), "docs", "hand-off-rule.md"), "utf8");

	it("names every property of the contract", () => {
		for (const key of PROPERTY_ORDER) {
			assert.ok(rule.includes(`\`${key}\``), `docs/hand-off-rule.md does not name \`${key}\``);
		}
	});

	it("names every word the properties take", () => {
		const words = [
			"daily-log", "cursor", "meeting", "requested", "cancelled", "taken", "done",
			"done-without-speaker-split", "failed", "working", "finished", "detect",
		];
		for (const word of words) {
			assert.ok(rule.includes(`\`${word}\``), `docs/hand-off-rule.md does not name \`${word}\``);
		}
	});

	it("gives both section headings and the shape of a turn", () => {
		for (const heading of Object.values(SECTION_HEADINGS)) {
			assert.ok(rule.includes(`\`${heading}\``), `no ${heading}`);
		}
		assert.ok(rule.includes("[00:12:34] **Speaker 1:** "));
	});

	it("links every fixture", () => {
		for (const name of readdirSync(FIXTURES)) {
			assert.ok(rule.includes(`hand-off-fixtures/${name}`), `${name} is not linked`);
		}
	});
});
