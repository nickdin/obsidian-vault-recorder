import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HAND_OFF_AGENT } from "./agent-hand-off.js";
import { Lifecycle, defaultAdapters } from "./lifecycle.js";
import { makeFakeWorld } from "./lifecycle-fakes.js";
import { RUN_AGENT_QUESTION, RecordingActions } from "./lifecycle-actions.js";
import { renameSpeaker } from "./naming.js";
import { ProgressMemory, buildQueue } from "./queue-model.js";
import { DEFAULT_SETTINGS } from "./settings-data.js";
import { stateLine } from "./state-line.js";
import {
	deriveState,
	markAgentDone,
	markAgentRequested,
	markAgentWorking,
	parseTranscriptNote,
	readInteger,
	readSection,
	readString,
	serializeTranscriptNote,
	setProperty,
	type TranscriptNote,
} from "./transcript-note.js";

/**
 * The hand-off agent through the lifecycle: the plugin
 * writes the request when the transcript is done and then only reads what the
 * program writes. The notes are the rule document's own fixtures, so the
 * program's lines in these tests are the ones the document shows.
 */

// `npm test` runs from the repository root.
const FIXTURES = path.join(process.cwd(), "docs", "hand-off-fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const NOTE = "Recording 20261019093539.md";
const DONE = "04-done.md";
const REQUESTED = "15-agent-requested.md";
const WORKING = "16-agent-working.md";
const ANSWERED = "17-agent-done.md";
const FAILED = "18-agent-failed.md";
const OLD = "19-agent-overdue.md";
const TRANSCRIBER_AT = "2026-10-19T09:48:44+02:00";

/** The fixture the plugin writes: 15 plus the `agent-for` line #156 added after it was drawn. */
const REQUESTED_FOR_TRANSCRIPT = fixture(REQUESTED).replace(
	"agent-attempt: 1\n",
	`agent-attempt: 1\nagent-for: ${TRANSCRIBER_AT}\n`,
);

function setUp(options: { start?: string; kind?: "none" | "hand-off"; seed?: string } = {}) {
	const world = makeFakeWorld();
	world.clock.set(options.start ?? "2026-10-19T09:50:00+02:00");
	world.currentSettings.agents.meeting = {
		...world.currentSettings.agents.meeting,
		kind: options.kind ?? "hand-off",
	};
	world.vault.seed(NOTE, options.seed ?? fixture(DONE));
	const lifecycle = new Lifecycle(world);
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
		refresh: (notePath) => lifecycle.look(notePath, world.clock.now()),
	});
	return { world, lifecycle, actions, asked, answer };
}

type Setup = ReturnType<typeof setUp>;

const tick = (s: Setup) => s.lifecycle.tick(s.world.clock.now());
const textOf = (s: Setup): string => s.world.vault.texts.get(NOTE) ?? "";
const noteOf = (s: Setup): TranscriptNote => {
	const note = parseTranscriptNote(textOf(s));
	assert.ok(note, "the transcript note exists");
	return note;
};
const stateOf = (s: Setup) => {
	const status = s.lifecycle.statusOf(NOTE);
	assert.ok(status, "the lifecycle has looked at the note");
	return status.state;
};
/** The program writes: its lines go into the note as they would by Sync. */
const program = (s: Setup, change: (note: TranscriptNote) => TranscriptNote): void => {
	s.world.vault.texts.set(NOTE, serializeTranscriptNote(change(noteOf(s))));
};

describe("the hand-off agent adapter", () => {
	it("is the one registered for the kind, takes nothing and gives no reason of its own", () => {
		assert.equal(defaultAdapters().agents["hand-off"], HAND_OFF_AGENT);
		assert.equal(HAND_OFF_AGENT.tick, undefined, "nothing to run: the program does the work");
		const s = setUp();
		assert.equal(HAND_OFF_AGENT.waitingReason(noteOf(s), DEFAULT_SETTINGS.agents.meeting, s.world.device), null);
	});
});

describe("the request", () => {
	it("is written when the transcript is done: agent requested, attempt 1, and the transcript it is about", async () => {
		const s = setUp();
		await tick(s);
		assert.equal(textOf(s), REQUESTED_FOR_TRANSCRIPT);
		assert.equal(stateOf(s).agent, "waiting");
	});

	it("is written once: a second tick leaves the note as it was", async () => {
		const s = setUp();
		await tick(s);
		await tick(s);
		s.world.clock.advance(60 * 60_000);
		await tick(s);
		assert.equal(textOf(s), REQUESTED_FOR_TRANSCRIPT);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 1);
	});

	it("carries no instruction: whatever the entry holds, the plugin writes only its own lines", async () => {
		const s = setUp();
		s.world.currentSettings.agents.meeting.instruction = "Summarise in French.";
		s.world.currentSettings.agents.meeting.contextNotePath = "Context.md";
		await tick(s);
		assert.equal(textOf(s), REQUESTED_FOR_TRANSCRIPT);
	});

	it("is not written before the transcript is done", async () => {
		const s = setUp({ seed: fixture("03-taken.md") });
		await tick(s);
		assert.equal(textOf(s), fixture("03-taken.md"));
	});

	it("is not written when the mode has no agent", async () => {
		const s = setUp({ kind: "none" });
		await tick(s);
		assert.equal(textOf(s), fixture(DONE));
	});
});

describe("what the program writes is derived and shown", () => {
	it("working, done and failed are read from the program's lines, and the plugin writes nothing over them", async () => {
		for (const [name, agent] of [
			[WORKING, "working"],
			[ANSWERED, "done"],
			[FAILED, "failed"],
		] as const) {
			const s = setUp({ seed: fixture(name) });
			await tick(s);
			assert.equal(stateOf(s).agent, agent, name);
			assert.equal(textOf(s), fixture(name), `${name} is left exactly as the program wrote it`);
		}
	});

	it("pasting the done lines into a requested note shows the answer in place", async () => {
		const s = setUp();
		await tick(s);
		assert.equal(stateOf(s).agent, "waiting");
		// The program takes the request, then answers; the plugin sees each write.
		program(s, (n) => markAgentWorking(n, { name: "home-pc", at: "2026-10-19T09:50:02+02:00" }));
		await tick(s);
		assert.equal(stateOf(s).agent, "working");
		s.world.vault.texts.set(NOTE, fixture(ANSWERED));
		await tick(s);
		assert.equal(stateOf(s).agent, "done");
		assert.equal(readSection(noteOf(s), "agent")?.split("\n")[0], "The meeting agreed the schedule for the autumn.");
		assert.equal(textOf(s), fixture(ANSWERED), "not requested again for the transcript it has answered");
	});

	it("overdue is judged on this device's clock: working a day with no change, and a request nobody takes", async () => {
		const working = setUp({ seed: fixture(WORKING), start: "2026-10-20T09:50:02+02:00" });
		await tick(working);
		assert.equal(stateOf(working).agentOverdue, false, "exactly the overdue time is not yet");
		working.world.clock.advance(1000);
		await tick(working);
		assert.equal(stateOf(working).agent, "working");
		assert.equal(stateOf(working).agentOverdue, true);

		const old = setUp({ seed: fixture(OLD), start: "2026-10-19T12:00:00+02:00" });
		await tick(old);
		assert.equal(stateOf(old).agentOverdue, true);
		assert.equal(textOf(old), fixture(OLD), "overdue is shown, never rewritten");

		const unanswered = setUp();
		await tick(unanswered);
		unanswered.world.clock.set("2026-10-20T09:48:45+02:00");
		await tick(unanswered);
		assert.equal(stateOf(unanswered).agent, "waiting");
		assert.equal(stateOf(unanswered).agentOverdue, true);
		assert.equal(readInteger(noteOf(unanswered), "agent-attempt"), 1, "a late agent is not asked again by itself");
	});

	it("speaker labels the program replaced in the text itself stay, and only the labels left are asked about", async () => {
		const s = setUp({ seed: fixture(ANSWERED) });
		// The program knows Speaker 1 is the owner and writes the name as `owner` has it.
		program(s, (n) => renameSpeaker(n, "Speaker 1", "[[Robin Example]]"));
		const written = textOf(s);
		assert.ok(written.includes("**[[Robin Example]]:** Welcome, everyone."), "the label is replaced in the transcript");
		assert.ok(!written.includes("**Speaker 1:**"), "no label of the named speaker is left");
		assert.ok(written.includes("**Speaker 2:**"), "the speaker it did not know is left alone");

		await tick(s);
		assert.equal(textOf(s), written, "the plugin does not touch what the program wrote");
		const row = buildQueue({
			notes: [{ path: NOTE, note: noteOf(s), waitingReason: null }],
			clock: { now: s.world.clock.now(), utcOffsetMinutes: () => 120 },
			overdueHours: 24,
			progress: new ProgressMemory(),
			settings: DEFAULT_SETTINGS,
		}).flatMap((g) => g.rows)[0];
		assert.equal(row.unnamed, 1, "one speaker is still unnamed");
	});

	it("the panel groups working, failed and overdue, and the note's line says where the agent stands", () => {
		const clockAt = (now: string) => ({ now: new Date(now), utcOffsetMinutes: () => 120 });
		const queue = (names: string[], now: string) =>
			buildQueue({
				notes: names.map((name) => ({ path: name, note: parseTranscriptNote(fixture(name))!, waitingReason: null })),
				clock: clockAt(now),
				overdueHours: 24,
				progress: new ProgressMemory(),
				settings: DEFAULT_SETTINGS,
			});
		const byId = Object.fromEntries(queue([WORKING, FAILED, OLD], "2026-10-19T12:00:00+02:00").map((g) => [g.id, g]));
		assert.deepEqual(byId["agent-working"].rows.map((r) => r.path), [WORKING]);
		assert.deepEqual(byId["agent-failed"].rows.map((r) => r.path), [FAILED]);
		assert.deepEqual(byId["agent-overdue"].rows.map((r) => r.path), [OLD]);

		const now = "2026-10-19T12:00:00+02:00";
		const line = (name: string) => {
			const note = parseTranscriptNote(fixture(name))!;
			const state = deriveStateAt(note, now);
			return stateLine(note, { state, waitingReason: null }, clockAt(now));
		};
		assert.equal(line(REQUESTED), "done — agent waiting");
		assert.equal(line(WORKING), "done — agent working");
		assert.equal(line(FAILED), "done — agent failed: the model did not answer");
		assert.equal(line(OLD), "done — agent working (overdue)");
		assert.equal(line(ANSWERED), "done");
	});
});

const deriveStateAt = (note: TranscriptNote, now: string) => deriveState(note, new Date(now), 24);

describe("run again raises the attempt", () => {
	it("after an answer: asks first, then raises agent-attempt to 2 and keeps the old section until the program answers", async () => {
		const s = setUp({ seed: fixture(ANSWERED) });
		await tick(s);
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, true);
		assert.deepEqual(s.asked, [RUN_AGENT_QUESTION]);
		const note = noteOf(s);
		assert.equal(readInteger(note, "agent-attempt"), 2);
		assert.equal(readString(note, "agent"), "requested");
		assert.equal(readInteger(note, "agent-attempt-answered"), 1, "the old answer is for attempt 1");
		assert.ok(readSection(note, "agent")?.includes("The schedule stands."), "the old section stays");
		assert.equal(stateOf(s).agent, "waiting");

		await tick(s);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2, "the plugin does not ask a third time");

		// The program answers attempt 2.
		program(s, (n) =>
			markAgentDone(markAgentWorking(n, { name: "home-pc", at: "2026-10-19T09:55:00+02:00" }), {
				at: "2026-10-19T09:56:00+02:00",
				text: "A second summary.",
			}),
		);
		await tick(s);
		assert.equal(stateOf(s).agent, "done");
		assert.equal(readSection(noteOf(s), "agent"), "A second summary.");
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);
	});

	it("declined, leaves the note as it was", async () => {
		const s = setUp({ seed: fixture(ANSWERED) });
		s.answer.yes = false;
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, false);
		assert.equal(textOf(s), fixture(ANSWERED));
	});

	it("after a failure: no question, the attempt is raised", async () => {
		const s = setUp({ seed: fixture(FAILED) });
		await tick(s);
		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, true);
		assert.deepEqual(s.asked, []);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);
		assert.equal(stateOf(s).agent, "waiting");
	});

	it("while the program is working it is refused; once overdue it is allowed", async () => {
		const s = setUp({ seed: fixture(WORKING) });
		await tick(s);
		const refused = await s.actions.runAgentAgain(NOTE);
		assert.equal(refused.changed, false);
		assert.equal(textOf(s), fixture(WORKING));

		const late = setUp({ seed: fixture(OLD), start: "2026-10-19T12:00:00+02:00" });
		await tick(late);
		const allowed = await late.actions.runAgentAgain(NOTE);
		assert.equal(allowed.changed, true);
		assert.equal(readInteger(parseTranscriptNote(late.world.vault.texts.get(NOTE) ?? "")!, "agent-attempt"), 2);
	});
});

describe("run again on an overdue agent", () => {
	const RAISED = "2026-10-19T12:00:00+02:00";

	it("stamps when it was raised, and reads waiting, not overdue, until the overdue time has passed again", async () => {
		const s = setUp({ seed: fixture(OLD), start: RAISED });
		await tick(s);
		assert.equal(stateOf(s).agentOverdue, true, "the agent the user is giving up on is overdue");

		const result = await s.actions.runAgentAgain(NOTE);
		assert.equal(result.changed, true);
		const note = noteOf(s);
		assert.equal(readString(note, "agent-requested-at"), RAISED, "stamped with this device's clock, in the shape of `recorded`");
		assert.equal(readString(note, "agent-at"), "2026-10-18T08:13:00+02:00", "the program's own line is not touched");
		assert.equal(readInteger(note, "agent-attempt"), 2);
		assert.equal(stateOf(s).agent, "waiting");
		assert.equal(stateOf(s).agentOverdue, false, "immediately after, it is not overdue");

		// So the click cannot be repeated for free: the second one is refused.
		const again = await s.actions.runAgentAgain(NOTE);
		assert.equal(again.changed, false);
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 2);

		s.world.clock.set("2026-10-20T12:00:00+02:00");
		await tick(s);
		assert.equal(stateOf(s).agentOverdue, false, "exactly the overdue time later is not yet");
		s.world.clock.advance(1000);
		await tick(s);
		assert.equal(stateOf(s).agent, "waiting");
		assert.equal(stateOf(s).agentOverdue, true, "overdue again once the overdue time has passed");
		assert.equal((await s.actions.runAgentAgain(NOTE)).changed, true, "and it is offered again");
		assert.equal(readInteger(noteOf(s), "agent-attempt"), 3);
		assert.equal(readString(noteOf(s), "agent-requested-at"), "2026-10-20T12:00:01+02:00", "restamped");
	});

	it("is stamped after a failure and after an answer too, because every run-again is a new request", async () => {
		for (const seed of [FAILED, ANSWERED]) {
			const s = setUp({ seed: fixture(seed), start: "2026-10-19T10:30:00+02:00" });
			await tick(s);
			await s.actions.runAgentAgain(NOTE);
			assert.equal(readString(noteOf(s), "agent-requested-at"), "2026-10-19T10:30:00+02:00", seed);
		}
	});

	it("leaves a first-time request alone: no stamp, counted from the transcript as before", async () => {
		const s = setUp();
		await tick(s);
		assert.equal(readString(noteOf(s), "agent-requested-at"), undefined);
		assert.equal(textOf(s), REQUESTED_FOR_TRANSCRIPT);
		s.world.clock.set("2026-10-20T09:48:44+02:00");
		await tick(s);
		assert.equal(stateOf(s).agentOverdue, false);
		s.world.clock.advance(1000);
		await tick(s);
		assert.equal(stateOf(s).agentOverdue, true);
	});
});

describe("the run-again stamp keeps the rule's property order", () => {
	it("keep-audio and agent-requested-at give the same text in either order of writing", () => {
		const base = parseTranscriptNote(fixture(ANSWERED))!;
		const stamp = (n: TranscriptNote) => markAgentRequested(n, { raisedAt: "2026-10-19T12:00:00+02:00" });
		const keep = (n: TranscriptNote) => setProperty(n, "keep-audio", "true");
		const one = serializeTranscriptNote(keep(stamp(base)));
		const other = serializeTranscriptNote(stamp(keep(base)));
		assert.equal(one, other);
	});

	it("the stamp follows agent-for, as the rule's table has it", () => {
		// An answered note, so the program's own lines follow agent-for and the stamp has to land before them.
		const base = setProperty(parseTranscriptNote(fixture(ANSWERED))!, "agent-for", TRANSCRIBER_AT);
		const text = serializeTranscriptNote(markAgentRequested(base, { raisedAt: "2026-10-19T12:00:00+02:00" }));
		const keys = text.split("\n").map((l) => l.split(":")[0]);
		assert.equal(keys[keys.indexOf("agent-for") + 1], "agent-requested-at");
	});
});

describe("a program that does not know the run-again stamp", () => {
	const RUN_AGAIN = "21-agent-run-again.md";
	const STAMP = "agent-requested-at: 2026-10-19T12:00:00+02:00";

	it("takes the job, writes its answer and leaves the line byte-identical", async () => {
		const s = setUp({ seed: fixture(RUN_AGAIN), start: "2026-10-19T12:00:00+02:00" });
		await tick(s);
		assert.equal(stateOf(s).agent, "waiting");
		// The program is the one the other tests use: it writes only its own lines.
		program(s, (n) => markAgentWorking(n, { name: "home-pc", at: "2026-10-19T12:00:02+02:00" }));
		await tick(s);
		assert.equal(stateOf(s).agent, "working");
		program(s, (n) => markAgentDone(n, { at: "2026-10-19T12:01:00+02:00", text: "The answer." }));
		await tick(s);
		assert.equal(stateOf(s).agent, "done");
		assert.equal(readSection(noteOf(s), "agent")?.split("\n")[0], "The answer.");
		const lines = textOf(s).split("\n");
		assert.equal(lines.filter((l) => l === STAMP).length, 1, "the stamp line is still there, byte for byte");
		assert.equal(lines.indexOf(STAMP), fixture(RUN_AGAIN).split("\n").indexOf(STAMP), "and where the rule puts it");
	});
});
