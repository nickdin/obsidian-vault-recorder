import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
	it("gives the answer of a call that finishes in time", async () => {
		assert.equal(await withTimeout(Promise.resolve("answer"), 1000, "send"), "answer");
	});

	it("throws, naming the call, when the call has not finished in time", async () => {
		const never = new Promise<string>(() => {});
		await assert.rejects(withTimeout(never, 20, "the transcription request"), /the transcription request.*20 ms/);
	});

	it("passes on the error of a call that fails in time", async () => {
		await assert.rejects(withTimeout(Promise.reject(new Error("refused")), 1000, "send"), /refused/);
	});
});
