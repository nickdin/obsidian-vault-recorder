/**
 * The speech models the on-device transcriber can use, and nothing else: the
 * plugin runs no model outside this list.
 *
 * Each entry is pinned to one exact published revision on Hugging Face and
 * carries every file's size. A model counts as present only when every file is
 * on disk at exactly that size (`model-store.ts`), so a download cut short, a
 * file Sync is still delivering and a file of the wrong version all read as
 * absent.
 *
 * The files are the ones transformers.js loads for a speech-recognition
 * pipeline run at `dtype: "q8"` (read in @huggingface/transformers 3.7.6:
 * `models.js` loads `encoder_model` and `decoder_model_merged` with the
 * `_quantized` suffix that `q8` maps to, `generation_config.json`, and
 * `config.json`; the processor loads `preprocessor_config.json`; the tokenizer
 * loads `tokenizer.json` and `tokenizer_config.json`). The transcribing ticket
 * loads exactly these. Sizes and revisions were read from
 * `https://huggingface.co/api/models/<repo>/tree/<revision>?recursive=1` on
 * 2026-10-22.
 */

/** One file of a model: its path inside the repository, and its size in bytes. */
export interface ModelFile {
	path: string;
	bytes: number;
}

export interface ModelEntry {
	/** Saved in the settings as the transcriber's `modelId`, and the model's subfolder name. */
	id: string;
	/** What the settings page calls it. */
	name: string;
	/** `sv` for the Swedish models, `multi` for the ones that take other languages. */
	language: "sv" | "multi";
	/** The one entry of its language group the settings page marks recommended. */
	recommended: boolean;
	/** The Hugging Face repository. */
	repo: string;
	/** The full commit the files are pinned to. */
	revision: string;
	files: readonly ModelFile[];
}

export const MODEL_LIST: readonly ModelEntry[] = [
	{
		id: "kb-whisper-tiny",
		name: "KB-Whisper tiny",
		language: "sv",
		recommended: false,
		repo: "KBLab/kb-whisper-tiny",
		revision: "76d796af43a50fa34321efa562c9b9887a187463",
		files: [
			{ path: "config.json", bytes: 3562 },
			{ path: "generation_config.json", bytes: 3693 },
			{ path: "preprocessor_config.json", bytes: 339 },
			{ path: "tokenizer.json", bytes: 3931232 },
			{ path: "tokenizer_config.json", bytes: 282604 },
			{ path: "onnx/encoder_model_quantized.onnx", bytes: 10072852 },
			{ path: "onnx/decoder_model_merged_quantized.onnx", bytes: 109681506 },
		],
	},
	{
		id: "kb-whisper-base",
		name: "KB-Whisper base",
		language: "sv",
		recommended: true,
		repo: "KBLab/kb-whisper-base",
		revision: "1499d2d2f0c7ed545bd6f2eec85287cf8d8c8b38",
		files: [
			{ path: "config.json", bytes: 3622 },
			{ path: "generation_config.json", bytes: 3753 },
			{ path: "preprocessor_config.json", bytes: 339 },
			{ path: "tokenizer.json", bytes: 3931232 },
			{ path: "tokenizer_config.json", bytes: 282604 },
			{ path: "onnx/encoder_model_quantized.onnx", bytes: 23123019 },
			{ path: "onnx/decoder_model_merged_quantized.onnx", bytes: 158947697 },
		],
	},
	{
		id: "whisper-tiny",
		name: "Whisper tiny",
		language: "multi",
		recommended: false,
		repo: "onnx-community/whisper-tiny",
		revision: "ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
		files: [
			{ path: "config.json", bytes: 2243 },
			{ path: "generation_config.json", bytes: 3772 },
			{ path: "preprocessor_config.json", bytes: 339 },
			{ path: "tokenizer.json", bytes: 2480466 },
			{ path: "tokenizer_config.json", bytes: 282683 },
			{ path: "onnx/encoder_model_quantized.onnx", bytes: 10124990 },
			{ path: "onnx/decoder_model_merged_quantized.onnx", bytes: 30719241 },
		],
	},
	{
		id: "whisper-base",
		name: "Whisper base",
		language: "multi",
		recommended: true,
		repo: "onnx-community/whisper-base",
		revision: "1846881b6b3a3024392c1eea3ad983695bc23925",
		files: [
			{ path: "config.json", bytes: 2243 },
			{ path: "generation_config.json", bytes: 3832 },
			{ path: "preprocessor_config.json", bytes: 339 },
			{ path: "tokenizer.json", bytes: 2480466 },
			{ path: "tokenizer_config.json", bytes: 282682 },
			{ path: "onnx/encoder_model_quantized.onnx", bytes: 23201314 },
			{ path: "onnx/decoder_model_merged_quantized.onnx", bytes: 53693315 },
		],
	},
];

/** The entry with this id, or `undefined` for anything not on the list. */
export function findModel(id: string): ModelEntry | undefined {
	return MODEL_LIST.find((entry) => entry.id === id);
}

/** Every byte of every file of a model: what a full download fetches. */
export function totalBytes(entry: ModelEntry): number {
	return entry.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** "182 MB": decimal megabytes, as Hugging Face itself counts them. */
export function formatSize(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/** The one outside address the model download fetches from (a service transcriber's address is the user's own). */
export const MODEL_HOST = "https://huggingface.co";

/** Where one file of a model is fetched from: the pinned revision, never a branch name. */
export function downloadAddress(entry: ModelEntry, file: ModelFile): string {
	return `${MODEL_HOST}/${entry.repo}/resolve/${entry.revision}/${file.path}`;
}
