/**
 * The model runner: the port between the on-device transcriber's rules
 * (`transcriber-on-device.ts`) and the code that actually runs a speech model.
 *
 * The rules ask `ModelRunner.transcribe` for the text of one recording and
 * know nothing of transformers.js, workers or WebAssembly; the runner the plugin
 * uses (`model-runner-obsidian.ts`) starts a worker, loads the model into it,
 * runs it and throws the worker away, and the tests hand the rules a fake. This
 * file also holds the small pure pieces both halves of the real runner agree on:
 * the messages between the window and the worker, the thread count, how many
 * windows a recording is cut into, and which file a library cache key names.
 */

import type { ModelEntry } from "./model-list";

// --- The port ------------------------------------------------------------------------

export interface TranscribeJob {
	/** The model to run; its files are in the model folder. */
	model: ModelEntry;
	/**
	 * The language spoken, as a code such as `sv`, or `null` to let the model
	 * detect it. A Swedish-only model is always given `sv`, whatever the
	 * setting says (`languageFor`).
	 */
	language: string | null;
	/** The recording as stored in the vault (`.m4a`, `.webm`, …). */
	audio: ArrayBuffer;
	/** Where the job is, 0–100; called as the work moves, never with a smaller number than before. */
	onProgress(percent: number): void;
	/**
	 * Aborts the job when the recording is no longer wanted. The runner ends its
	 * worker, which releases the model, as soon as it sees the abort. Whoever
	 * holds the controller decides when that is: the on-device transcriber
	 * aborts at its next look at the note (a progress report), not at the
	 * moment the user clicks Cancel.
	 */
	signal: AbortSignal;
}

export interface TranscribeResult {
	text: string;
	/** Seconds the model took to load, and to run; for the record, not the rules. */
	loadSeconds: number;
	transcribeSeconds: number;
}

/**
 * Runs one speech model over one recording. Loads the model when the job
 * starts and releases it when the job ends, whether it ended with text, with a
 * failure or with an abort. Rejects with an `Error` whose message says what
 * went wrong in words the note can show.
 */
export interface ModelRunner {
	transcribe(job: TranscribeJob): Promise<TranscribeResult>;
}

/**
 * Run `work` and give up on it after `ms`, ending it. `work` is handed a
 * signal that is aborted when the deadline passes, when `wanted` is aborted,
 * and when `work` is over either way; it must end whatever it holds (a
 * worker, a loaded model) on that signal. A promise cannot be cancelled, so
 * a timeout that only rejected would leave the worker running with the model
 * loaded: this one rejects and aborts.
 */
export function withDeadline<T>(
	ms: number,
	what: string,
	wanted: AbortSignal,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const own = new AbortController();
	return new Promise<T>((resolve, reject) => {
		const onWanted = (): void => own.abort(wanted.reason);
		const finish = (): void => {
			clearTimeout(timer);
			wanted.removeEventListener("abort", onWanted);
			own.abort();
		};
		const timer = setTimeout(() => {
			finish();
			reject(new Error(`${what} gave no answer in ${ms} ms`));
		}, ms);
		if (wanted.aborted) onWanted();
		else wanted.addEventListener("abort", onWanted, { once: true });
		work(own.signal).then(
			(value) => {
				finish();
				resolve(value);
			},
			(err) => {
				finish();
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

/** What the language setting means to this model: a Swedish-only model ignores it. */
export function languageFor(model: ModelEntry, noteLanguage: string | undefined): string | null {
	if (model.language === "sv") return "sv";
	const language = noteLanguage?.trim();
	return language === undefined || language === "" ? null : language;
}

// --- Between the window and the worker ---------------------------------------------------

/** The window asks the worker to load a model and run a recording through it. */
export interface RunnerRequest {
	type: "run";
	/** The model's id: the folder name below the model folder, and the name the library is given. */
	modelId: string;
	/** ONNX Runtime's WebAssembly binary, handed over so the library never fetches it. */
	engine: ArrayBuffer;
	threads: number;
	language: string | null;
	/** One channel at 16 kHz. */
	samples: Float32Array;
}

export interface RunnerReply {
	text: string;
	loadSeconds: number;
	transcribeSeconds: number;
	/** The thread count the library ended up with. */
	threads: number;
	/** Whether shared memory was there; without it ONNX Runtime runs on one thread whatever it was asked. */
	sharedMemory: boolean;
	windows: number;
	/** Every model file the library asked the cache for, below the model's folder. */
	filesAskedFor: string[];
}

/** What the worker sends the window. */
export type WorkerMessage =
	| { type: "file-request"; requestId: number; path: string }
	| { type: "loaded" }
	| { type: "windows"; finished: number; total: number }
	| { type: "done"; reply: RunnerReply }
	| { type: "failed"; message: string; missedFiles: string[] };

/** How many threads ONNX Runtime is asked for: the processors there are, at most the four the speed measurements used. */
export function threadCount(hardwareConcurrency: number | undefined): number {
	const processors = Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency as number) : 1;
	return Math.min(4, Math.max(1, processors));
}

/**
 * How many windows the library cuts a recording into: windows of
 * `windowSeconds` that each start `windowSeconds - 2 * strideSeconds` after the
 * last, until one reaches the end (`_call_whisper` in transformers.js).
 */
export function chunkCount(
	samples: number,
	sampleRate: number,
	windowSeconds: number,
	strideSeconds: number,
): number {
	const window = sampleRate * windowSeconds;
	const jump = window - 2 * sampleRate * strideSeconds;
	if (samples <= window) return 1;
	return 1 + Math.ceil((samples - window) / jump);
}

/**
 * The path below the model's folder that a library cache key names, or `null`
 * for a key that is not one of this model's files. The library looks a file up
 * under its local path (`models/<id>/onnx/…`) and under its Hugging Face
 * address (`https://huggingface.co/<id>/resolve/main/onnx/…`); both hold the
 * model's id followed by the path.
 */
export function matchModelFile(modelId: string, key: string): string | null {
	const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|/)${escaped}/(?:resolve/[^/]+/)?(.+)$`).exec(key);
	return match ? match[1] : null;
}

/**
 * Progress across the whole job, in whole percent: preparing the recording
 * takes the first few, loading the model the next, and the model's windows
 * share the rest. Never reaches 100; the note says done when the text is there.
 */
export const PROGRESS = {
	audioDecoded: 3,
	modelLoaded: 20,
	last: 99,
} as const;

export function progressOfWindows(finished: number, total: number): number {
	const share = total <= 0 ? 0 : Math.min(1, finished / total);
	return Math.min(PROGRESS.last, Math.floor(PROGRESS.modelLoaded + share * (PROGRESS.last - PROGRESS.modelLoaded)));
}
