/**
 * In-memory stand-ins for the model store's ports, for the model store's tests
 * and the on-device transcriber's. They live in a file of their own because
 * `lifecycle-fakes.ts` is not edited by a later ticket.
 */

import type { ModelEntry } from "./model-list";
import type { ModelDownloadPort, ModelFolderPort, ModelTrashPort } from "./model-store";

/**
 * An in-memory model folder: files by path with their sizes, the folders
 * created, and what was trashed. Trashing a folder takes everything under it,
 * as Obsidian's trash does.
 */
export class FakeModelDisk implements ModelFolderPort, ModelTrashPort {
	readonly files = new Map<string, number>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	/** When set, `trash` records the call and deletes nothing: Obsidian not knowing the path yet. */
	trashDoesNothing = false;
	/** When set, writing a file fails: a full disk or a folder Obsidian cannot write to. */
	writesFail: string | null = null;

	async fileSize(path: string): Promise<number | null> {
		return this.files.get(path) ?? null;
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		if (this.writesFail !== null) throw new Error(this.writesFail);
		this.files.set(path, data.byteLength);
	}
	async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
		const current = this.files.get(path);
		if (current === undefined) throw new Error(`No such file: ${path}`);
		this.files.set(path, current + data.byteLength);
	}
	async rename(from: string, to: string): Promise<void> {
		const size = this.files.get(from);
		if (size === undefined) throw new Error(`No such file: ${from}`);
		if (this.files.has(to)) throw new Error(`Destination file already exists: ${to}`);
		this.files.delete(from);
		this.files.set(to, size);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
	async trash(path: string): Promise<void> {
		this.trashed.push(path);
		if (this.trashDoesNothing) return;
		for (const file of [...this.files.keys()]) {
			if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
		}
	}

	/** Put every file of `entry` in its subfolder at its listed size, as a hand-placed model would be. */
	place(entry: ModelEntry, folder = "vault-recorder/models"): void {
		for (const file of entry.files) this.files.set(`${folder}/${entry.id}/${file.path}`, file.bytes);
	}
}

/** A network that serves any range of any file as zero bytes, and keeps what it was asked. */
export class FakeNetwork implements ModelDownloadPort {
	readonly asked: { url: string; start: number; end: number }[] = [];
	/** Throw when asked for the n-th range (1-based). */
	failOnRequest: number | null = null;
	/** Answer every range with this many bytes fewer than asked. */
	shortBy = 0;

	async fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
		this.asked.push({ url, start, end });
		if (this.failOnRequest === this.asked.length) throw new Error("connection reset");
		return new ArrayBuffer(end - start + 1 - this.shortBy);
	}
}
