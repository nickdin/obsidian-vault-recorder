import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { frontmatterText } from "./frontmatter-text.js";

describe("frontmatterText", () => {
	it("reads text as itself", () => {
		assert.equal(frontmatterText("2026-11-05"), "2026-11-05");
	});

	it("reads a number, a true/false and an empty value as YAML wrote them", () => {
		assert.equal(frontmatterText(20261105), "20261105");
		assert.equal(frontmatterText(true), "true");
		assert.equal(frontmatterText(null), "null");
	});

	it("reads a map as its JSON rather than [object Object]", () => {
		assert.equal(frontmatterText({ on: "2026-11-05" }), '{"on":"2026-11-05"}');
		assert.equal(frontmatterText(["a", "b"]), '["a","b"]');
	});
});
