/**
 * The model runner the plugin uses: a Web Worker started for one recording,
 * thrown away when the text is written. Plumbing only; the rules are in
 * `transcriber-on-device.ts` and the shared pieces in `model-runner.ts`.
 *
 * - The worker's code (transformers.js, ONNX Runtime's JavaScript) and ONNX
 *   Runtime's WebAssembly binary are both inside `main.js`, put there by
 *   `esbuild.config.mjs`; nothing is read from outside the plugin and the vault.
 * - The window decodes the recording to one channel at 16 kHz, and answers the
 *   worker's requests for model files out of the model folder.
 * - Ending the worker is what releases the model: its memory goes with it.
 */

import { normalizePath, type App } from "obsidian";

import engineGzipped from "../build/engine.wasm.gz";
import workerSource from "../build/worker.bundle.txt";
import type { ModelEntry } from "./model-list";
import {
	PROGRESS,
	progressOfWindows,
	threadCount,
	withDeadline,
	type ModelRunner,
	type RunnerReply,
	type TranscribeJob,
	type TranscribeResult,
	type WorkerMessage,
} from "./model-runner";

const SAMPLE_RATE = 16000;

/** Time allowed on top of twice the recording's length: loading a model from a slow disk, and a slow processor. */
const SLACK_MS = 10 * 60 * 1000;

/** ONNX Runtime's binary, stored compressed inside the bundle, back to bytes. */
async function unpackEngine(): Promise<ArrayBuffer> {
	const bytes = Uint8Array.from(atob(engineGzipped), (c) => c.charCodeAt(0));
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}

/** One channel at 16 kHz, which is what the speech model takes. */
async function decodeToMono16k(audio: ArrayBuffer): Promise<Float32Array> {
	// decodeAudioData resamples to the context's rate, so the context only
	// names that rate; its own length is irrelevant.
	const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
	const decoded = await context.decodeAudioData(audio.slice(0));
	const samples = new Float32Array(decoded.length);
	for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
		const data = decoded.getChannelData(channel);
		for (let i = 0; i < data.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
	}
	return samples;
}

export interface ObsidianModelRunnerOptions {
	/** The model's folder in the vault, as `ModelStore.folderOf` says. */
	folderOf(model: ModelEntry): string;
	/** Called when a run is over, with what the worker measured; the drive and the logs read it. */
	onRan?(model: ModelEntry, reply: RunnerReply): void;
}

export function createObsidianModelRunner(app: App, options: ObsidianModelRunnerOptions): ModelRunner {
	return {
		async transcribe(job: TranscribeJob): Promise<TranscribeResult> {
			const samples = await decodeToMono16k(job.audio);
			job.signal.throwIfAborted();
			job.onProgress(PROGRESS.audioDecoded);

			const seconds = samples.length / SAMPLE_RATE;
			// The deadline ends the worker, not only the wait for it: a stuck worker
			// would otherwise keep the model in memory.
			const reply = await withDeadline(
				SLACK_MS + 2 * seconds * 1000,
				"the speech model",
				job.signal,
				(signal) => runInWorker(app, options, { ...job, signal }, samples),
			);
			options.onRan?.(job.model, reply);
			return {
				text: reply.text,
				loadSeconds: reply.loadSeconds,
				transcribeSeconds: reply.transcribeSeconds,
			};
		},
	};
}

async function runInWorker(
	app: App,
	options: ObsidianModelRunnerOptions,
	job: TranscribeJob,
	samples: Float32Array,
): Promise<RunnerReply> {
	const engine = await unpackEngine();
	job.signal.throwIfAborted();

	const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
	const worker = new Worker(url, { type: "module" });
	URL.revokeObjectURL(url);

	let reported = 0;
	const report = (percent: number): void => {
		if (percent <= reported) return;
		reported = percent;
		job.onProgress(percent);
	};

	try {
		return await new Promise<RunnerReply>((resolve, reject) => {
			const abort = (): void => reject(new DOMException("the transcription was cancelled", "AbortError"));
			if (job.signal.aborted) abort();
			else job.signal.addEventListener("abort", abort, { once: true });
			worker.onerror = (event) =>
				reject(new Error(`the speech model's worker failed: ${event.message} (${event.filename}:${event.lineno})`));
			worker.onmessage = async (event: MessageEvent<WorkerMessage>) => {
				const message = event.data;
				switch (message.type) {
					case "file-request": {
						// A file that cannot be read is answered as one that is not there:
						// the worker then fails with the files it missed, instead of
						// waiting for a reply that never comes.
						const buffer = await readModelFile(app, `${options.folderOf(job.model)}/${message.path}`).catch(
							(err) => {
								console.error(`[vault-recorder] could not read the model file '${message.path}':`, err);
								return null;
							},
						);
						worker.postMessage(
							{ type: "file-response", requestId: message.requestId, buffer },
							buffer === null ? [] : [buffer],
						);
						return;
					}
					case "loaded":
						report(PROGRESS.modelLoaded);
						return;
					case "windows":
						report(progressOfWindows(message.finished, message.total));
						return;
					case "done":
						resolve(message.reply);
						return;
					case "failed":
						reject(
							new Error(
								message.missedFiles.length === 0
									? message.message
									: `${message.message} (not in ${options.folderOf(job.model)}: ${message.missedFiles.join(", ")})`,
							),
						);
						return;
				}
			};
			worker.postMessage(
				{
					type: "run",
					modelId: job.model.id,
					engine,
					threads: threadCount(navigator.hardwareConcurrency),
					language: job.language,
					samples,
				},
				[engine, samples.buffer],
			);
		});
	} finally {
		// Ending the worker is what releases the model. Every way out of the
		// promise above passes here: the text, a failure, the abort the deadline
		// and the caller's cancel both arrive as.
		worker.terminate();
	}
}

/** One model file off the disk, or `null` when it is not there. */
async function readModelFile(app: App, path: string): Promise<ArrayBuffer | null> {
	const normalized = normalizePath(path);
	if (!(await app.vault.adapter.exists(normalized))) return null;
	return app.vault.adapter.readBinary(normalized);
}
