/**
 * In-memory stand-ins for the lifecycle's ports, for every lifecycle test.
 *
 * One pretend vault serves a whole flow: it holds text files and binary files
 * (with their sizes), folders, and what was trashed. It refuses to create a
 * path that is taken, as Obsidian does, so a test cannot pass on an overwrite.
 *
 * A later ticket does not edit this file: a fake for a port of its own
 * (network, key store, model runner) goes in a new file beside the ticket.
 */

import type {
	ClockPort,
	DevicePort,
	DeviceRole,
	LifecyclePorts,
	NotePropertiesPort,
	VaultPort,
} from "./lifecycle";
import { DEFAULT_SETTINGS, type VaultRecorderSettings } from "./settings-data";

export class FakeVault implements VaultPort {
	readonly texts = new Map<string, string>();
	readonly binaries = new Map<string, number>();
	readonly folders = new Set<string>();
	readonly trashed: string[] = [];
	attachmentFolder: string | null = null;
	/** Every `create` and `createBinary` call that succeeded, in order. */
	readonly created: string[] = [];

	async read(path: string): Promise<string | null> {
		return this.texts.get(path) ?? null;
	}

	async write(path: string, text: string): Promise<void> {
		if (!this.texts.has(path)) throw new Error(`No such file: ${path}`);
		this.texts.set(path, text);
	}

	async create(path: string, text: string): Promise<void> {
		this.assertFree(path);
		this.texts.set(path, text);
		this.created.push(path);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.assertFree(path);
		this.binaries.set(path, data.byteLength);
		this.created.push(path);
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async trash(path: string): Promise<void> {
		this.texts.delete(path);
		this.binaries.delete(path);
		this.trashed.push(path);
	}

	async fileSize(path: string): Promise<number | null> {
		const binary = this.binaries.get(path);
		if (binary !== undefined) return binary;
		const text = this.texts.get(path);
		return text === undefined ? null : new TextEncoder().encode(text).length;
	}

	async listTranscriptNotes(): Promise<string[]> {
		const notes: string[] = [];
		for (const [path, text] of this.texts) {
			if (path.endsWith(".md") && /^---\n(?:.*\n)*?rule-version:/.test(text)) {
				notes.push(path);
			}
		}
		return notes.sort();
	}

	linkText(path: string, _fromPath: string): string {
		const name = path.slice(path.lastIndexOf("/") + 1);
		return name.endsWith(".md") ? name.slice(0, -3) : name;
	}

	/**
	 * Obsidian's answer, imitated: the attachment folder setting (`null` or `""`
	 * the top of the vault, `./` and `./sub` relative to the source note), then
	 * ` 1`, ` 2`, … before the extension while the name is taken.
	 */
	async availablePathForAttachment(filename: string, sourcePath: string): Promise<string> {
		const setting = (this.attachmentFolder ?? "").replace(/\/+$/, "");
		const noteFolder = sourcePath.includes("/")
			? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
			: "";
		let folder = setting;
		if (setting === "." || setting.startsWith("./")) {
			folder = [noteFolder, setting.slice(2)].filter((part) => part !== "").join("/");
		}
		const dot = filename.lastIndexOf(".");
		const stem = dot < 0 ? filename : filename.slice(0, dot);
		const ext = dot < 0 ? "" : filename.slice(dot);
		const at = (name: string) => (folder === "" ? name : `${folder}/${name}`);
		let candidate = at(filename);
		for (let n = 1; this.texts.has(candidate) || this.binaries.has(candidate); n++) {
			candidate = at(`${stem} ${n}${ext}`);
		}
		return candidate;
	}

	/** Put a text file in the vault, as a test's starting state. */
	seed(path: string, text: string): void {
		this.texts.set(path, text);
	}

	private assertFree(path: string): void {
		if (this.texts.has(path) || this.binaries.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}
	}
}

/**
 * A clock a test sets by hand. `offsetMinutes` is the zone it pretends to be
 * in, so a test can run at an offset that is not the machine's own.
 */
export class FakeClock implements ClockPort {
	private current: Date;

	constructor(
		start: string = "2026-10-19T09:35:39+02:00",
		readonly offsetMinutes: number = 120,
	) {
		this.current = new Date(start);
	}

	now(): Date {
		return new Date(this.current.getTime());
	}

	utcOffsetMinutes(_at: Date): number {
		return this.offsetMinutes;
	}

	set(to: string): void {
		this.current = new Date(to);
	}

	advance(ms: number): void {
		this.current = new Date(this.current.getTime() + ms);
	}
}

export class FakeDevice implements DevicePort {
	constructor(
		public deviceName: string = "test-desktop",
		public deviceRole: DeviceRole = "ordinary",
		public phone: boolean = false,
	) {}

	name(): string {
		return this.deviceName;
	}

	role(): DeviceRole {
		return this.deviceRole;
	}

	isPhone(): boolean {
		return this.phone;
	}
}

/** Note properties a test sets by hand: `set(path, "participants", [...])`. */
export class FakeNoteProperties implements NotePropertiesPort {
	private readonly values = new Map<string, string[]>();

	set(path: string, property: string, value: string[]): void {
		this.values.set(`${path}\n${property}`, value);
	}

	list(path: string, property: string): string[] | undefined {
		return this.values.get(`${path}\n${property}`);
	}
}

export interface FakeWorld extends LifecyclePorts {
	vault: FakeVault;
	clock: FakeClock;
	device: FakeDevice;
	noteProperties: FakeNoteProperties;
	/** The settings the lifecycle reads; edit them in place. */
	currentSettings: VaultRecorderSettings;
}

/** A whole pretend world: vault, clock, device, note properties and settings. */
export function makeFakeWorld(): FakeWorld {
	const currentSettings = structuredClone(DEFAULT_SETTINGS);
	return {
		vault: new FakeVault(),
		clock: new FakeClock(),
		device: new FakeDevice(),
		noteProperties: new FakeNoteProperties(),
		currentSettings,
		settings: () => currentSettings,
	};
}

/** `size` bytes of pretend audio. */
export function audioOfSize(size: number): ArrayBuffer {
	return new ArrayBuffer(size);
}
