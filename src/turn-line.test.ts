import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { turnTargetAt } from "./turn-line.js";

describe("what a press on a turn's line means in Live Preview", () => {
	const line = "[00:01:05] **[[Anna Svensson#Work]]:** Hello.";

	it("is a play on the time, with its offset", () => {
		assert.deepEqual(turnTargetAt(line, 3), { kind: "time", seconds: 65 });
		assert.deepEqual(turnTargetAt(line, 10), { kind: "time", seconds: 65 });
	});

	it("is the label as written, linked or not, anywhere in the bold label", () => {
		const written = { kind: "label", label: "[[Anna Svensson#Work]]" };
		assert.deepEqual(turnTargetAt(line, 11), written);
		assert.deepEqual(turnTargetAt(line, 22), written, "inside the link's own words");
		assert.deepEqual(turnTargetAt(line, 11 + "**[[Anna Svensson#Work]]:**".length - 1), written);
		assert.deepEqual(turnTargetAt("[00:00:02] **Speaker 2:** Hi.", 14), { kind: "label", label: "Speaker 2" });
	});

	it("is nothing in the spoken text, or on a line that is not a turn", () => {
		assert.equal(turnTargetAt(line, 11 + "**[[Anna Svensson#Work]]:**".length), null);
		assert.equal(turnTargetAt(line, line.length), null);
		assert.equal(turnTargetAt("Some **bold:** prose", 8), null);
	});
});
