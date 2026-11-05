/**
 * The Web Worker that runs the speech model, so Obsidian's window stays
 * responsive. `esbuild.config.mjs` bundles this file, transformers.js and ONNX
 * Runtime's JavaScript into one text that `model-runner-obsidian.ts` starts a
 * worker from. It is never imported by the plugin's own code.
 *
 * It sends nothing to any address. Every model file is asked for from the
 * window, which reads it out of the model folder; ONNX Runtime's loader and
 * its WebAssembly binary arrive from the window too, as blob addresses; remote
 * model loading is switched off; and `fetch` is replaced by one that refuses
 * anything that is not a blob or data address.
 */

// Must run before the library's module body: see `hide-node.ts`.
import "./hide-node";
import { env, pipeline, type AutomaticSpeechRecognitionOutput } from "@huggingface/transformers";
import engineLoader from "../build/engine-loader.txt";
import type { RunnerReply, RunnerRequest, WorkerMessage } from "./model-runner";
import { chunkCount, matchModelFile } from "./model-runner";

const post = (message: WorkerMessage, transfer: Transferable[] = []): void =>
	self.postMessage(message, { transfer });

// --- Files out of the vault -----------------------------------------------------

let nextRequestId = 1;
const pendingFiles = new Map<number, (buffer: ArrayBuffer | null) => void>();

function requestFile(path: string): Promise<ArrayBuffer | null> {
	return new Promise((resolve) => {
		const requestId = nextRequestId++;
		pendingFiles.set(requestId, resolve);
		post({ type: "file-request", requestId, path });
	});
}

/** The files the library asked for and the vault did not have, for the failure message. */
const missedFiles: string[] = [];
/** Every file the library asked the cache for: the proof of which files a load really needs. */
const askedFor = new Set<string>();

/**
 * Stands in for the browser's Cache API. The library looks a file up here
 * before anything else, under its local path or its Hugging Face address; both
 * name the model's folder and the file below it, which is all the vault needs.
 */
function vaultCache(modelId: string) {
	return {
		async match(key: unknown): Promise<Response | undefined> {
			const path = matchModelFile(modelId, String(key));
			if (path === null) return undefined;
			askedFor.add(path);
			const buffer = await requestFile(path);
			if (buffer === null) {
				if (!missedFiles.includes(path)) missedFiles.push(path);
				return undefined;
			}
			return new Response(buffer);
		},
		async put(): Promise<void> {},
	};
}

// --- Nothing leaves the vault -----------------------------------------------------

const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
	const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (!address.startsWith("blob:") && !address.startsWith("data:")) {
		return Promise.reject(new Error(`the speech model may not fetch ${address}`));
	}
	return realFetch(input, init);
};

// --- Running -----------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 30;
const STRIDE_SECONDS = 5;

async function run(request: RunnerRequest): Promise<RunnerReply> {
	env.allowRemoteModels = false;
	env.allowLocalModels = true;
	env.useBrowserCache = false;
	env.useCustomCache = true;
	env.customCache = vaultCache(request.modelId);

	const wasm = env.backends.onnx.wasm!;
	// The loader is handed over as a blob: with a blob address the library
	// patches nothing, and the check in `engineLoader` is already switched off.
	wasm.wasmPaths = {
		mjs: URL.createObjectURL(new Blob([engineLoader], { type: "text/javascript" })),
		wasm: URL.createObjectURL(new Blob([request.engine], { type: "application/wasm" })),
	};
	// ONNX Runtime falls back to one thread whenever the page is not
	// cross-origin isolated, which Obsidian is not; threads work anyway, so the
	// count has to be asked for.
	wasm.numThreads = request.threads;

	const loadStarted = performance.now();
	const transcriber = await pipeline("automatic-speech-recognition", request.modelId, {
		device: "wasm",
		dtype: "q8",
	});
	const loadSeconds = (performance.now() - loadStarted) / 1000;
	post({ type: "loaded" });

	// The library gives no signal as each window finishes, so count the calls
	// it makes to the model: one `generate` per window.
	const windows = chunkCount(request.samples.length, SAMPLE_RATE, WINDOW_SECONDS, STRIDE_SECONDS);
	let finished = 0;
	const generate = transcriber.model.generate.bind(transcriber.model);
	transcriber.model.generate = async (...args: Parameters<typeof generate>) => {
		const output = await generate(...args);
		finished++;
		post({ type: "windows", finished, total: windows });
		return output;
	};

	const options: Record<string, unknown> = {
		task: "transcribe",
		chunk_length_s: WINDOW_SECONDS,
		stride_length_s: STRIDE_SECONDS,
	};
	if (request.language !== null) options.language = request.language;
	const transcribeStarted = performance.now();
	const output = await transcriber(request.samples, options);
	// One recording in gives one result out, by the library's own type; the
	// list form is still read in case a release ever answers with one.
	const result = Array.isArray(output) ? (output[0] as AutomaticSpeechRecognitionOutput) : output;
	const text = String(result.text).trim();
	return {
		text,
		loadSeconds,
		transcribeSeconds: (performance.now() - transcribeStarted) / 1000,
		threads: wasm.numThreads ?? 0,
		sharedMemory: typeof SharedArrayBuffer !== "undefined",
		windows,
		filesAskedFor: [...askedFor].sort(),
	};
}

self.onmessage = async (event: MessageEvent) => {
	const message = event.data as { type: string };
	if (message.type === "file-response") {
		const response = event.data as { requestId: number; buffer: ArrayBuffer | null };
		const resolve = pendingFiles.get(response.requestId);
		pendingFiles.delete(response.requestId);
		resolve?.(response.buffer);
		return;
	}
	if (message.type !== "run") return;
	try {
		const reply = await run(event.data as RunnerRequest);
		post({ type: "done", reply });
	} catch (error) {
		post({
			type: "failed",
			message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			missedFiles,
		});
	}
};
