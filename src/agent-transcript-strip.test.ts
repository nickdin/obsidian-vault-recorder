import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transcriptForAgent } from "./agent-service.js";
import { markAgentRequested, parseTranscriptNote } from "./transcript-note.js";

/** `npm test` runs from the repository root. */
const FIXTURES = path.join(process.cwd(), "docs", "hand-off-fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

describe("the transcript sent to the agent", () => {
	it("has no agent-requested-at line after a run-again, in the fixture or through markAgentRequested", () => {
		const fromFixture = parseTranscriptNote(fixture("21-agent-run-again.md"));
		assert.ok(fromFixture);
		assert.match(fixture("21-agent-run-again.md"), /^agent-requested-at: /m, "the fixture carries the line, so the check is not vacuous");
		assert.doesNotMatch(transcriptForAgent(fromFixture), /agent-requested-at/);

		const overdue = parseTranscriptNote(fixture("19-agent-overdue.md"));
		assert.ok(overdue);
		const raised = markAgentRequested(overdue, { raisedAt: "2026-10-19T12:00:00+02:00" });
		assert.ok(raised.properties.some((p) => p.key === "agent-requested-at"), "the stamp was written");
		assert.doesNotMatch(transcriptForAgent(raised), /agent-requested-at/);
	});

	it("still carries the recording's own lines and the transcript", () => {
		const note = parseTranscriptNote(fixture("21-agent-run-again.md"));
		assert.ok(note);
		const text = transcriptForAgent(note);
		assert.match(text, /^recorded: 2026-10-18T08:00:00\+02:00$/m);
		assert.match(text, /\*\*Speaker 1:\*\*/);
	});
});
