/**
 * The plugin's settings: the shape, and the defaults.
 *
 * Separate from `settings.ts`, which draws the settings panel and therefore
 * imports `obsidian`. That package is type definitions only — its `main` is an
 * empty string — so any module importing it cannot be loaded outside Obsidian,
 * and a Node test cannot reach it. Keeping the data here is what lets
 * `settings-migration.test.ts` assert the real merge against the real defaults
 * instead of a copy of them that could drift.
 */

/** The three ways of recording; the transcriber and agent are chosen per mode. */
export type RecordingModeKey = "dailyLog" | "cursor" | "meeting";

export const RECORDING_MODE_KEYS: readonly RecordingModeKey[] = [
	"dailyLog",
	"cursor",
	"meeting",
];

/** Every transcriber kind, the one list the type is made from. */
export const TRANSCRIBER_KINDS = ["none", "hand-off", "service", "on-device"] as const;
export type TranscriberKind = (typeof TRANSCRIBER_KINDS)[number];
/** Every agent kind, the one list the type is made from. */
export const AGENT_KINDS = ["none", "hand-off", "service"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * One mode's transcriber. Every field is a string, `""` when the kind does not
 * use it: `modelId` belongs to on-device, `address`, `keyName` and `modelName`
 * to service. `keyName` is the name a key is stored under, never the key.
 *
 * The whole union is defined here although only `"none"` can be chosen yet, so
 * adding a kind later is a settings-page change and never a type change.
 */
export interface TranscriberEntry {
	kind: TranscriberKind;
	modelId: string;
	address: string;
	keyName: string;
	modelName: string;
}

/** One mode's agent; the same rules as `TranscriberEntry`. */
export interface AgentEntry {
	kind: AgentKind;
	instruction: string;
	contextNotePath: string;
	address: string;
	keyName: string;
	modelName: string;
	/**
	 * The moment this mode's agent kind last changed to something other than
	 * `none`, as the notes write a time (`2026-10-22T11:00:00+02:00`); `""` when
	 * unknown or `none`. A transcript that finished at or after it is asked for
	 * the agent at any age (`shouldRequestAgent`); one that finished before it is
	 * never sent, so choosing an agent cannot send the vault's old transcripts
	 * to a service. It is saved with the settings, so every device judges alike.
	 */
	chosenAt: string;
}

export type TranscriberSettings = Record<RecordingModeKey, TranscriberEntry>;
export type AgentSettings = Record<RecordingModeKey, AgentEntry>;

/** The notes heading as the text and the level (1–6) a vault note writes it with. */
export interface NotesHeading {
	text: string;
	level: number;
}

/**
 * The plugin's data model.
 *
 * - `notesHeading`: the heading recordings are linked under in a daily log or
 *   a meeting note. A saved file without this key predates these settings and
 *   ran on the Swedish heading at level 1; `settings-migration.ts` says so.
 * - `useDailyNotesSettings`: when `true`, today's daily log is found where the
 *   Daily Notes core plugin puts it, and `dailyLogFolder` and `dailyLogFormat`
 *   are not read. When `false`, those two are used.
 * - `dailyLogFolder` + `dailyLogFormat`: the plugin's own pair, used only when
 *   `useDailyNotesSettings` is off. They were called `dagloggFolder` and
 *   `dagloggFormat` before the 2026-08-19 rename; `settings-migration.ts`
 *   carries a saved file across and says why that cannot be skipped.
 * - `participantsProperty`: the note property listing a meeting's participants.
 * - `ownerName`: the person recording; empty until typed.
 * - `language`: `"detect"`, or a language code such as `"en"`.
 * - `audioFolder`: an empty string means the vault default, Obsidian's
 *   attachmentFolderPath.
 * - `transcriptFolder`: an empty string means the same folder as the audio.
 * - `modelFolder`: where speech models are kept.
 * - `keepTimeDays`: `null` is empty, and then no audio is ever deleted.
 * - `overdueHours`: how long a recording waits before it counts as overdue.
 * - `transcribers` + `agents`: one entry per recording mode.
 * - `codecMimeType` + `codecExtension`: set at load by `detectCodec()` and shown
 *   read-only in settings, for troubleshooting.
 */
export interface VaultRecorderSettings {
	notesHeading: NotesHeading;
	useDailyNotesSettings: boolean;
	dailyLogFolder: string;
	dailyLogFormat: string;
	participantsProperty: string;
	ownerName: string;
	language: string;
	audioFolder: string;
	transcriptFolder: string;
	modelFolder: string;
	keepTimeDays: number | null;
	overdueHours: number;
	transcribers: TranscriberSettings;
	agents: AgentSettings;
	codecMimeType: string;
	codecExtension: "m4a" | "webm";
	/**
	 * When `true` (the default), the plugin takes a wake lock as a recording
	 * starts, so the screen does not go dark and the system does not lock
	 * while one is in progress. A saved file predating this field simply does
	 * not carry it, and `loadSettings` merges over `DEFAULT_SETTINGS`, so the
	 * default applies — no migration needed for a key that was only ever added.
	 */
	keepAwake: boolean;
}

function noTranscriber(): TranscriberEntry {
	return { kind: "none", modelId: "", address: "", keyName: "", modelName: "" };
}

function noAgent(): AgentEntry {
	return {
		kind: "none",
		instruction: "",
		contextNotePath: "",
		address: "",
		keyName: "",
		modelName: "",
		chosenAt: "",
	};
}

/**
 * Set a mode's agent kind the way the settings page does, and keep `chosenAt`
 * true: a change to a different agent stamps `chosenAt` with `at`, switching the
 * agent off clears it, and choosing the kind already set leaves it alone.
 */
export function chooseAgentKind(entry: AgentEntry, kind: AgentKind, at: string): void {
	if (kind === entry.kind) return;
	entry.kind = kind;
	entry.chosenAt = kind === "none" ? "" : at;
}

/**
 * The English defaults, which a fresh install gets. A vault upgraded from the
 * Swedish-defaulted version gets its own values instead — see
 * `settings-migration.ts`.
 *
 * Nested objects live here once; code that merges over these must clone first
 * (`structuredClone`), or editing a setting would edit the default.
 */
export const DEFAULT_SETTINGS: VaultRecorderSettings = {
	notesHeading: { text: "Notes", level: 1 },
	useDailyNotesSettings: true,
	dailyLogFolder: "",
	dailyLogFormat: "YYYY-MM-DD",
	participantsProperty: "participants",
	ownerName: "",
	language: "detect",
	audioFolder: "",
	transcriptFolder: "",
	modelFolder: "vault-recorder/models",
	keepTimeDays: null,
	overdueHours: 24,
	transcribers: {
		dailyLog: noTranscriber(),
		cursor: noTranscriber(),
		meeting: noTranscriber(),
	},
	agents: {
		dailyLog: noAgent(),
		cursor: noAgent(),
		meeting: noAgent(),
	},
	codecMimeType: "",
	codecExtension: "m4a",
	keepAwake: true,
};
