/**
 * The lifecycle's ports, built from Obsidian. Plumbing only: every rule lives
 * in `lifecycle.ts`, which cannot import Obsidian and is tested without it.
 */

import { Platform, TFile, type App } from "obsidian";

import { frontmatterText } from "./frontmatter-text";
import type {
	ClockPort,
	DevicePort,
	NotePropertiesPort,
	VaultPort,
} from "./lifecycle";

/** The per-device name lives in Obsidian's local storage for the vault, never in synced settings. */
export const DEVICE_NAME_KEY = "vault-recorder-device-name";
export const SERVING_DEVICE_KEY = "vault-recorder-serving-device";
export const DEVICE_ID_KEY = "vault-recorder-device-id";

/**
 * This device's stable id, made on first use and kept in local storage beside
 * the name. A claim carries it so devices on the same default name are told
 * apart and a rename does not strand a claim.
 */
export function readDeviceId(app: App): string {
	const stored: unknown =
		typeof app.loadLocalStorage === "function" ? app.loadLocalStorage(DEVICE_ID_KEY) : null;
	if (typeof stored === "string" && stored !== "") return stored;
	const made = crypto.randomUUID();
	app.saveLocalStorage(DEVICE_ID_KEY, made);
	return made;
}

/** This device's name as the user typed it, or `""` when none is set. */
export function readDeviceName(app: App): string {
	const name: unknown =
		typeof app.loadLocalStorage === "function" ? app.loadLocalStorage(DEVICE_NAME_KEY) : null;
	return typeof name === "string" ? name.trim() : "";
}

/** Save this device's name; an empty name removes it, so the default applies again. */
export function writeDeviceName(app: App, name: string): void {
	app.saveLocalStorage(DEVICE_NAME_KEY, name.trim() === "" ? null : name.trim());
}

/** Whether the user has made this device the vault's serving device. */
export function readServingDevice(app: App): boolean {
	const stored: unknown =
		typeof app.loadLocalStorage === "function" ? app.loadLocalStorage(SERVING_DEVICE_KEY) : null;
	return stored === "true";
}

/** Switch this device's serving role; off removes the value rather than storing "false". */
export function writeServingDevice(app: App, serving: boolean): void {
	app.saveLocalStorage(SERVING_DEVICE_KEY, serving ? "true" : null);
}

export function createVaultPort(app: App): VaultPort {
	const { vault, metadataCache } = app;
	const file = (path: string): TFile | null => {
		const found = vault.getAbstractFileByPath(path);
		return found instanceof TFile ? found : null;
	};

	return {
		async read(path) {
			const found = file(path);
			return found ? vault.read(found) : null;
		},
		async write(path, text) {
			const found = file(path);
			if (!found) throw new Error(`No such file: ${path}`);
			await vault.modify(found, text);
		},
		async create(path, text) {
			await vault.create(path, text);
		},
		async createBinary(path, data) {
			await vault.createBinary(path, data);
		},
		async createFolder(path) {
			if (vault.getAbstractFileByPath(path)) return; // a folder, or a file of that name: nothing to do
			try {
				await vault.createFolder(path);
			} catch {
				// A race, or the folder already exists — ignore. The write will
				// throw if the folder really is missing.
			}
		},
		async trash(path) {
			const found = vault.getAbstractFileByPath(path);
			if (!found) return;
			await app.fileManager.trashFile(found);
		},
		async fileSize(path) {
			const found = file(path);
			return found ? found.stat.size : null;
		},
		async listTranscriptNotes() {
			return vault
				.getMarkdownFiles()
				.filter(
					(note) =>
						metadataCache.getFileCache(note)?.frontmatter?.["rule-version"] !==
						undefined,
				)
				.map((note) => note.path);
		},
		linkText(path, fromPath) {
			const found = file(path);
			// A file the cache cannot find yet is linked by its full path.
			return found ? metadataCache.fileToLinktext(found, fromPath) : path;
		},
		availablePathForAttachment(filename, sourcePath) {
			return app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
		},
	};
}

export function createClockPort(): ClockPort {
	return {
		now: () => new Date(),
		utcOffsetMinutes: (at) => -at.getTimezoneOffset(),
	};
}

export function createDevicePort(app: App): DevicePort {
	return {
		id() {
			return readDeviceId(app);
		},
		name() {
			const name = readDeviceName(app);
			if (name !== "") return name;
			return Platform.isPhone ? "phone" : "desktop";
		},
		role() {
			return readServingDevice(app) ? "serving" : "ordinary";
		},
		isPhone() {
			return Platform.isPhone;
		},
	};
}

export function createNotePropertiesPort(app: App): NotePropertiesPort {
	return {
		list(path, property) {
			const note = app.vault.getAbstractFileByPath(path);
			if (!(note instanceof TFile)) return undefined;
			const value: unknown =
				app.metadataCache.getFileCache(note)?.frontmatter?.[property];
			if (value === undefined || value === null) return undefined;
			return Array.isArray(value) ? value.map((entry) => frontmatterText(entry)) : [frontmatterText(value)];
		},
	};
}
