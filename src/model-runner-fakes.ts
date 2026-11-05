/**
 * An in-memory model runner for the on-device transcriber's tests. It lives in
 * a file of its own because `lifecycle-fakes.ts` is not edited by a later
 * ticket.
 */

import type { ModelEntry } from "./model-list";
import type { ModelRunner, TranscribeJob, TranscribeResult } from "./model-runner";

/** What the runner was asked for. */
export interface RecordedJob {
	model: ModelEntry;
	language: string | null;
	audioBytes: number;
}

/** What a scripted run does between being asked and answering. */
export type RunnerScript = (job: TranscribeJob) => Promise<void>;

/**
 * A runner that never loads a model. It records each job, runs a script that
 * may report progress, wait, or throw, and answers with `text`.
 */
export class FakeModelRunner implements ModelRunner {
	readonly jobs: RecordedJob[] = [];
	/** Jobs whose signal was aborted by the time they ended. */
	abortedJobs = 0;
	/** Jobs started and not yet ended: a real run holds a worker and a model for as long as it is one of these. */
	inFlight = 0;
	/** The most jobs that were in flight at the same moment. */
	maxInFlight = 0;
	/** Jobs that ended, with text, a failure or an abort: the worker was ended and the model released. */
	endedJobs = 0;
	text = "This is a spoken note.";
	script: RunnerScript = async () => {};

	async transcribe(job: TranscribeJob): Promise<TranscribeResult> {
		this.jobs.push({ model: job.model, language: job.language, audioBytes: job.audio.byteLength });
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			await this.script(job);
			job.signal.throwIfAborted();
		} catch (err) {
			if (job.signal.aborted) this.abortedJobs++;
			throw err;
		} finally {
			this.inFlight--;
			this.endedJobs++;
		}
		return { text: this.text, loadSeconds: 0, transcribeSeconds: 0 };
	}
}

/** The recordings a device holds, by link; a link not set is a recording Sync has not delivered. */
export class FakeAudio {
	readonly recordings = new Map<string, ArrayBuffer>();

	async read(link: string, _fromPath: string): Promise<ArrayBuffer | null> {
		return this.recordings.get(link) ?? null;
	}
}
