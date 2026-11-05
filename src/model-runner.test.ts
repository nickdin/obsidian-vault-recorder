import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { audioOfSize } from "./lifecycle-fakes.js";
import { findModel, type ModelEntry } from "./model-list.js";
import { FakeModelRunner } from "./model-runner-fakes.js";
import { withDeadline, type TranscribeJob } from "./model-runner.js";

const MODEL = findModel("kb-whisper-tiny") as ModelEntry;

function jobWith(signal: AbortSignal): TranscribeJob {
	return { model: MODEL, language: "sv", audio: audioOfSize(1000), onProgress: () => {}, signal };
}

/** A run that goes on until it is told to stop, as a worker stuck waiting for a file does. */
function stuckUntilAborted(runner: FakeModelRunner): void {
	runner.script = (job) =>
		new Promise<void>((_, reject) => {
			job.signal.addEventListener("abort", () => reject(new DOMException("ended", "AbortError")), { once: true });
		});
}

const afterWork = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("a model run held to a deadline", () => {
	it("ends the run when the deadline passes, so no run is left alive and the model is released", async () => {
		const runner = new FakeModelRunner();
		stuckUntilAborted(runner);
		const wanted = new AbortController();

		await assert.rejects(
			withDeadline(20, "the speech model", wanted.signal, (signal) => runner.transcribe(jobWith(signal))),
			/the speech model gave no answer in 20 ms/,
		);
		await afterWork();

		assert.equal(runner.jobs.length, 1);
		assert.equal(runner.endedJobs, 1, "the job was ended, not left running");
		assert.equal(runner.inFlight, 0, "no run is left alive after the timeout");
		assert.equal(runner.abortedJobs, 1, "it was ended by its signal");
	});

	it("ends the run when the recording is no longer wanted", async () => {
		const runner = new FakeModelRunner();
		stuckUntilAborted(runner);
		const wanted = new AbortController();

		const run = withDeadline(60_000, "the speech model", wanted.signal, (signal) =>
			runner.transcribe(jobWith(signal)),
		);
		await afterWork();
		assert.equal(runner.inFlight, 1);
		wanted.abort();
		await assert.rejects(run, { name: "AbortError" });
		assert.equal(runner.inFlight, 0);
		assert.equal(runner.endedJobs, 1);
	});

	it("hands the result of a run that finished in time through, and leaves nothing alive", async () => {
		const runner = new FakeModelRunner();
		const result = await withDeadline(60_000, "the speech model", new AbortController().signal, (signal) =>
			runner.transcribe(jobWith(signal)),
		);
		assert.equal(result.text, "This is a spoken note.");
		assert.equal(runner.inFlight, 0);
		assert.equal(runner.endedJobs, 1);
	});
});
