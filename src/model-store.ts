/**
 * The models on this device: which are present, fetching one, removing one.
 *
 * Touches the outside world only through the three ports below, so it runs
 * under Node with no Obsidian. `settings-models.ts` builds the real ports.
 *
 * A model lives in `<model folder>/<model id>/`, its files at the paths the
 * list gives them. It is present only when every file is there at exactly the
 * listed size. That is the whole rule: a file placed by hand counts, a model
 * Sync is still delivering (some files missing, or one still short) does not,
 * and so a download cut short never reads as a model.
 */

import { normalizeFolder } from "./lifecycle";
import {
	downloadAddress,
	MODEL_LIST,
	findModel,
	formatSize,
	totalBytes,
	type ModelEntry,
	type ModelFile,
} from "./model-list";

/**
 * The model folder, as the store needs it. Paths are vault-relative, with `/`.
 *
 * The real port reads the file system through Obsidian's adapter rather than
 * the vault's index: the index can lack a file Sync is still writing, or a
 * file placed by hand a moment ago, and an answer from it could call a short
 * file absent for the wrong reason or a present one missing.
 */
export interface ModelFolderPort {
	/** Size in bytes of the file at `path` on disk, or `null` when there is no such file. */
	fileSize(path: string): Promise<number | null>;
	/** Create a folder and the ones above it; nothing happens when it exists. */
	createFolder(path: string): Promise<void>;
	/** Write a file, replacing one that is there. */
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Add to the end of a file that exists. */
	appendBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Move a file to a path that is free. */
	rename(from: string, to: string): Promise<void>;
	/** Delete a file outright. Used only on this store's own half-finished downloads. */
	remove(path: string): Promise<void>;
}

/** Removal goes through the lifecycle's trash, which follows Obsidian's trash setting. */
export interface ModelTrashPort {
	trash(path: string): Promise<void>;
}

/** The one thing fetched from outside: a byte range of a file. */
export interface ModelDownloadPort {
	/** The bytes `start` to `end` inclusive of the file at `url`. Throws on any failure. */
	fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer>;
}

export interface ModelStoreDeps {
	/** The model folder setting, read live. */
	modelFolder: () => string;
	folder: ModelFolderPort;
	trash: ModelTrashPort;
	download: ModelDownloadPort;
	/** Largest range asked of the network in one request. */
	chunkBytes?: number;
}

/** 16 MiB: a hundred-megabyte file takes seven requests and never sits in memory whole. */
export const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;

export interface ModelStatus {
	/** Every file is there at its listed size. */
	present: boolean;
	/** The files that are absent or the wrong size. */
	missing: ModelFile[];
}

export interface DownloadProgress {
	/** Bytes of this model on disk or fetched so far. */
	doneBytes: number;
	totalBytes: number;
}

/** Which half of fetching a file failed: getting the bytes from the network, or putting them on disk. */
class DownloadStageError extends Error {
	constructor(
		readonly stage: "network" | "disk",
		readonly detail: string,
	) {
		super(detail);
	}
}

/**
 * The download failed. The message says whether the network or the local disk
 * failed, and names the other ways to get the model, including every file it
 * needs and the folder they go in, so the by-hand route can be followed from
 * the message alone.
 */
export class ModelDownloadError extends Error {
	constructor(entry: ModelEntry, folder: string, cause: unknown) {
		const stage = cause instanceof DownloadStageError ? cause.stage : "network";
		const reason = cause instanceof Error ? cause.message : String(cause);
		const what =
			stage === "disk"
				? `Could not save ${entry.name} in ${folder}: ${reason}`
				: `Could not download ${entry.name} from huggingface.co: ${reason}`;
		super(
			`${what}. ` +
				`Other ways to get it: download it on another device and let Sync carry it here, ` +
				`or put the ${entry.files.length} files by hand in ${folder}, keeping the sub-folder names: ` +
				`${entry.files.map((file) => file.path).join(", ")}.`,
		);
		this.name = "ModelDownloadError";
	}
}

export class ModelStore {
	private readonly present = new Map<string, boolean>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly progress = new Map<string, DownloadProgress>();
	private readonly listeners = new Map<string, Set<(progress: DownloadProgress | null) => void>>();

	constructor(private readonly deps: ModelStoreDeps) {}

	/** Where a model's files go: `<model folder>/<model id>`. */
	folderOf(entry: ModelEntry): string {
		const folder = normalizeFolder(this.deps.modelFolder().trim());
		return folder === "" ? entry.id : `${folder}/${entry.id}`;
	}

	/** Look at the disk: is every file of this model there at its full size? */
	async status(entry: ModelEntry): Promise<ModelStatus> {
		const missing: ModelFile[] = [];
		for (const file of entry.files) {
			if ((await this.deps.folder.fileSize(this.pathOf(entry, file))) !== file.bytes) {
				missing.push(file);
			}
		}
		const status = { present: missing.length === 0, missing };
		this.present.set(entry.id, status.present);
		return status;
	}

	/**
	 * What the last look at the disk found, for the model with this id. `false`
	 * for an id not on the list, and for a model not looked at yet: callers
	 * that need the truth call `refresh` first.
	 */
	isPresent(modelId: string): boolean {
		return this.present.get(modelId) ?? false;
	}

	/** Look at the disk for the model with this id; `false` for an id not on the list. */
	async refreshOne(modelId: string): Promise<boolean> {
		const entry = findModel(modelId);
		if (!entry) return false;
		return (await this.status(entry)).present;
	}

	/** Look at the disk for every model on the list; `main.ts` does this once at load. */
	async refreshAll(): Promise<void> {
		for (const entry of MODEL_LIST) await this.status(entry);
	}

	/** Fetch every file the model is missing, one after another. */
	download(entry: ModelEntry): Promise<void> {
		const running = this.inFlight.get(entry.id);
		if (running) return running;
		const started = this.fetchAll(entry).finally(() => {
			this.inFlight.delete(entry.id);
			this.progress.delete(entry.id);
			this.tell(entry.id, null);
		});
		this.inFlight.set(entry.id, started);
		return started;
	}

	/** The state of a download in progress, or `null` when none is running. */
	progressOf(modelId: string): DownloadProgress | null {
		return this.inFlight.has(modelId) ? (this.progress.get(modelId) ?? null) : null;
	}

	/**
	 * Be told as a download moves: with its progress after each chunk, and with
	 * `null` when it ends, by success or failure. Returns the way to stop.
	 */
	onProgress(modelId: string, listener: (progress: DownloadProgress | null) => void): () => void {
		const set = this.listeners.get(modelId) ?? new Set();
		set.add(listener);
		this.listeners.set(modelId, set);
		return () => void set.delete(listener);
	}

	/**
	 * Remove the model's whole subfolder through the trash port, which follows
	 * Obsidian's trash setting. Throws when files are still there afterwards:
	 * the trash port does nothing for a path Obsidian's index does not know yet,
	 * and a remove that quietly did nothing would be a lie.
	 */
	async remove(entry: ModelEntry): Promise<void> {
		await this.deps.trash.trash(this.folderOf(entry));
		const left = await this.anyFileOnDisk(entry);
		this.present.set(entry.id, false);
		if (left) {
			throw new Error(
				`${entry.name} is still in ${this.folderOf(entry)}: Obsidian did not trash it. Try again in a moment.`,
			);
		}
	}

	private async fetchAll(entry: ModelEntry): Promise<void> {
		const folder = this.folderOf(entry);
		const total = totalBytes(entry);
		let done = 0;
		try {
			for (const file of entry.files) {
				const path = this.pathOf(entry, file);
				if ((await this.deps.folder.fileSize(path)) === file.bytes) {
					done += file.bytes; // already whole: a repeat press carries on from here
					this.report(entry.id, { doneBytes: done, totalBytes: total });
					continue;
				}
				await this.fetchFile(entry, file, path, (fetched) =>
					this.report(entry.id, { doneBytes: done + fetched, totalBytes: total }),
				);
				done += file.bytes;
			}
		} catch (cause) {
			this.present.set(entry.id, false);
			throw new ModelDownloadError(entry, folder, cause);
		}
		const status = await this.status(entry);
		if (!status.present) {
			throw new ModelDownloadError(
				entry,
				folder,
				new DownloadStageError(
					"disk",
					`${status.missing.map((file) => file.path).join(", ")} not at its listed size after the download`,
				),
			);
		}
	}

	/**
	 * Fetch one file in ranges into `<path>.part`, then move it into place once
	 * the part file is exactly the listed size. The final path therefore never
	 * holds a half file that this store wrote, whatever stops the download.
	 */
	private async fetchFile(
		entry: ModelEntry,
		file: ModelFile,
		path: string,
		onChunk: (fetchedBytes: number) => void,
	): Promise<void> {
		const { folder, download } = this.deps;
		const chunk = this.deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
		const part = `${path}.part`;
		try {
			await folder.createFolder(path.slice(0, path.lastIndexOf("/")));
			await folder.remove(part); // a leftover of an earlier failure; nothing when there is none
		} catch (cause) {
			throw new DownloadStageError("disk", cause instanceof Error ? cause.message : String(cause));
		}
		const url = downloadAddress(entry, file);
		let fetched = 0;
		try {
			while (fetched < file.bytes) {
				const end = Math.min(fetched + chunk, file.bytes) - 1;
				const data = await download.fetchRange(url, fetched, end).catch((cause: unknown) => {
					throw new DownloadStageError("network", cause instanceof Error ? cause.message : String(cause));
				});
				if (data.byteLength !== end - fetched + 1) {
					throw new DownloadStageError(
						"network",
						`${file.path}: asked for bytes ${fetched}-${end} and got ${data.byteLength} bytes`,
					);
				}
				try {
					if (fetched === 0) await folder.writeBinary(part, data);
					else await folder.appendBinary(part, data);
				} catch (cause) {
					throw new DownloadStageError("disk", cause instanceof Error ? cause.message : String(cause));
				}
				fetched += data.byteLength;
				onChunk(fetched);
			}
			const onDisk = await folder.fileSize(part);
			if (onDisk !== file.bytes) {
				throw new DownloadStageError("disk", `${file.path}: ${onDisk ?? 0} bytes written, ${file.bytes} expected`);
			}
			try {
				await folder.remove(path); // a short file of the same name, from Sync or an earlier press
				await folder.rename(part, path);
			} catch (cause) {
				throw new DownloadStageError("disk", cause instanceof Error ? cause.message : String(cause));
			}
		} catch (cause) {
			await folder.remove(part).catch(() => undefined);
			throw cause;
		}
	}

	private async anyFileOnDisk(entry: ModelEntry): Promise<boolean> {
		for (const file of entry.files) {
			if ((await this.deps.folder.fileSize(this.pathOf(entry, file))) !== null) return true;
		}
		return false;
	}

	private pathOf(entry: ModelEntry, file: ModelFile): string {
		return `${this.folderOf(entry)}/${file.path}`;
	}

	private report(modelId: string, progress: DownloadProgress): void {
		this.progress.set(modelId, progress);
		this.tell(modelId, progress);
	}

	private tell(modelId: string, progress: DownloadProgress | null): void {
		for (const listener of this.listeners.get(modelId) ?? []) listener(progress);
	}
}

/** "Download 182 MB": the button's label, naming what one press fetches. */
export function downloadButtonLabel(entry: ModelEntry): string {
	return `Download ${formatSize(totalBytes(entry))}`;
}
