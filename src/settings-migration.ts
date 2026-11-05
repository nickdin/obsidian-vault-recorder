import {
	DEFAULT_SETTINGS,
	type VaultRecorderSettings,
} from "./settings-data";
import { formatTimestamp } from "./transcript-note";

/**
 * Carry the two Swedish settings keys across to their English names, upgrade a
 * file written before the English-default settings existed, and build the
 * settings object the plugin runs on.
 *
 * The plugin was called `obsidian-motesinspelning` until 2026-08-19 and stored
 * the daily-log folder and filename pattern under `dagloggFolder` and
 * `dagloggFormat`. Those two are the only keys that changed name; the other
 * four were already English and are read straight through.
 *
 * Why this is dangerous enough to need its own module and its own tests:
 * `loadSettings` merges saved data over `DEFAULT_SETTINGS`, so a key that is no
 * longer recognised is not an error — it is silently ignored, and the default
 * takes its place. A user who had configured a daily-log folder would find it
 * quietly reset to `5. Journal`, with nothing red anywhere.
 *
 * The rule that follows from that, and the one to hold onto if this file is
 * ever edited: **a migration carries a value, it does not judge it.** Deciding
 * that some saved value is not worth keeping is the same silent reset in a
 * different coat.
 *
 * This code stays in the plugin permanently. A migration deleted one release
 * after it lands is a trap for anyone restoring an older vault backup, whose
 * `data.json` still carries the old keys.
 */

/**
 * The keys this migration consumes. `mergeSavedSettings` drops them from the
 * saved data after the migration has read them, so `data.json` is not left
 * carrying two spellings of the same setting with no way to tell which one is
 * live.
 */
export const LEGACY_SETTING_KEYS = ["dagloggFolder", "dagloggFormat"] as const;

/**
 * Old key → new key. Both targets are `string` fields, which is what lets the
 * loop below assign without a cast — widen this map to a key of another type
 * and the compiler will say so rather than letting a bad value through.
 */
const KEY_MAP: ReadonlyArray<
	readonly [
		(typeof LEGACY_SETTING_KEYS)[number],
		"dailyLogFolder" | "dailyLogFormat",
	]
> = [
	["dagloggFolder", "dailyLogFolder"],
	["dagloggFormat", "dailyLogFormat"],
];

/**
 * Read the old keys out of raw saved plugin data and return them under their
 * new names.
 *
 * Pure: no I/O, no logging, no mutation of `raw`.
 *
 * Two refusals, and only two:
 *
 * - a new key already present in `raw` wins, and the old one is dropped. That
 *   is the second-and-later load, after the migration has already been saved.
 * - a non-string old value is ignored rather than coerced. Both settings are
 *   text fields, so a number or a `null` here is not a value this plugin ever
 *   wrote, and there is no faithful reading of it.
 *
 * **An empty string is carried, not dropped.** It is a real configuration:
 * `resolveDailyLog` reads an empty folder as the vault root, and clearing the
 * Folder field in the settings panel saves exactly that. An earlier version of
 * this function skipped empty values so "the default applies" — which reset the
 * daily logs of anyone keeping them in the vault root to `5. Journal`, silently,
 * which is the one failure the whole module exists to prevent. Found by
 * `/code-review high` on 2026-08-19.
 *
 * The return value is a `Partial`, never a whole settings object, so the caller
 * keeps control of precedence between defaults, saved data and this result.
 */
export function migrateSettings(raw: unknown): Partial<VaultRecorderSettings> {
	if (typeof raw !== "object" || raw === null) return {};
	const data = raw as Record<string, unknown>;

	const migrated: Partial<VaultRecorderSettings> = {};
	for (const [oldKey, newKey] of KEY_MAP) {
		if (data[newKey] !== undefined) continue;
		const value = data[oldKey];
		if (typeof value !== "string") continue;
		migrated[newKey] = value;
	}
	return migrated;
}

/**
 * What the plugin did, for a user whose saved file predates the notes-heading
 * setting. These are data, not prose: they are the values that file ran on, and
 * they stay Swedish on purpose. The heading is also the one
 * `note-insert.ts` matches in notes already written.
 */
const PREDATING_SETTINGS = {
	notesHeading: { text: "Anteckningar", level: 1 },
	participantsProperty: "deltagare",
	language: "sv",
} as const;

/** The daily-log pair every version before this one defaulted to. */
const OLD_DEFAULT_DAILY_LOG_FOLDER = "5. Journal";
const OLD_DEFAULT_DAILY_LOG_FORMAT = "YYYY-MM-DD";

/**
 * The four upgrade rules, applied to a saved file after the key rename. Returns
 * only keys the file did not already carry, so a value the user saved always
 * wins. There are two exceptions. The daily-log pair: a half saved with a value of
 * the wrong type counts as unsaved and is replaced. And `agents` (rule 4), which
 * is returned whole with a field added. `notesHeading`,
 * `participantsProperty` and `language` are kept whatever their type.
 *
 * 1. **A file without `notesHeading` predates these settings** and receives
 *    the Swedish heading at level 1, the Swedish participants property and `sv`,
 *    because that is what the plugin did for that user. Of the other two, a key
 *    the file does carry is kept.
 * 2. **A saved daily-log pair equal to the old default** (`5. Journal`,
 *    `YYYY-MM-DD`) becomes `useDailyNotesSettings: true`.
 * 3. **A pair the user changed becomes `useDailyNotesSettings: false`**, with
 *    the half they never saved filled in from the old default. Without this the
 *    new default (`true`) would silently ignore the folder they chose — the very
 *    reset this module exists to prevent. The old code kept a hand-set pair too:
 *    it copied Daily Notes' values only while both halves were still the default.
 *
 * A predating file that never saved a daily-log key ran on the old default
 * pair, so rule 2 applies to it as well: the old code replaced that pair with
 * the Daily Notes plugin's folder and format whenever that plugin was on, which
 * is what the switch now does. Its own pair keeps the new defaults, since
 * nothing was saved to carry.
 *
 * 4. **An agent entry saved without `chosenAt`**, returned as the whole
 *    saved `agents` object with the field added: the one place this returns a key
 *    the file already carries, because the merge is shallow and would otherwise
 *    leave the entry without the field. An entry with an agent chosen gets `at`,
 *    the moment of this load: the real moment is lost, the load is the
 *    latest it can have been, so nothing finished before it is ever sent and
 *    everything after it is asked. An entry with no agent gets `""`. The `""`
 *    that the interim build saved into an entry with an agent counts as absent,
 *    not as a value: `AgentEntry.chosenAt` documents `""` as "unknown", the
 *    build wrote it as a stand-in and no person chose it, and the settings page
 *    never writes it beside an agent. Taken as a value it would leave every
 *    setup this rule exists for on the 24-hour window. Text that is no time is a
 *    value somebody or something wrote, and stays.
 *
 * Almost nothing here is judged: equality is exact, with no trimming, so
 * `5. Journal/` is a pair the user chose. The one judgement is rule 4's: a saved
 * `chosenAt` of `""` beside an agent counts as absent, as that rule says.
 */
export function upgradeSavedSettings(
	data: Record<string, unknown>,
	at: string = loadMoment(),
): Record<string, unknown> {
	const added: Record<string, unknown> = {};

	const predates = data.notesHeading === undefined;
	if (predates) {
		added.notesHeading = { ...PREDATING_SETTINGS.notesHeading };
		if (data.participantsProperty === undefined) {
			added.participantsProperty = PREDATING_SETTINGS.participantsProperty;
		}
		if (data.language === undefined) added.language = PREDATING_SETTINGS.language;
	}

	const savedPair =
		data.dailyLogFolder !== undefined || data.dailyLogFormat !== undefined;
	if (data.useDailyNotesSettings === undefined && (predates || savedPair)) {
		const folder =
			typeof data.dailyLogFolder === "string"
				? data.dailyLogFolder
				: OLD_DEFAULT_DAILY_LOG_FOLDER;
		const format =
			typeof data.dailyLogFormat === "string"
				? data.dailyLogFormat
				: OLD_DEFAULT_DAILY_LOG_FORMAT;
		const stale =
			folder === OLD_DEFAULT_DAILY_LOG_FOLDER &&
			format === OLD_DEFAULT_DAILY_LOG_FORMAT;
		added.useDailyNotesSettings = stale;
		if (!stale) {
			if (typeof data.dailyLogFolder !== "string") added.dailyLogFolder = folder;
			if (typeof data.dailyLogFormat !== "string") added.dailyLogFormat = format;
		}
	}

	const agents = withAgentChosenAt(data.agents, at);
	if (agents !== null) added.agents = agents;
	return added;
}

/** The moment now, written the way the notes and the agent dropdown write one. */
function loadMoment(): string {
	const now = new Date();
	return formatTimestamp(now, -now.getTimezoneOffset());
}

/**
 * True for a saved agent entry that has an agent chosen and no moment for it:
 * `chosenAt` absent, or the `""` the interim build saved (#181, rule 4 above).
 */
function needsChosenAt(entry: Record<string, unknown>): boolean {
	return entry.kind !== "none" && (entry.chosenAt === undefined || entry.chosenAt === "");
}

/** The modes whose saved agent entry the upgrade stamps with the moment of this load. */
export function modesToStamp(saved: unknown): string[] {
	if (typeof saved !== "object" || saved === null) return [];
	return Object.entries(saved)
		.filter(([, entry]) => typeof entry === "object" && entry !== null && needsChosenAt(entry as Record<string, unknown>))
		.map(([mode]) => mode);
}

/**
 * A saved `agents` object with `chosenAt` added to each mode's entry that lacks
 * it, or `null` when there is nothing to add. The merge is
 * shallow, so a saved `agents` replaces the default one whole: without this an
 * entry saved before the field existed would come back with no `chosenAt` at all.
 * An entry with an agent and no usable moment gets `at`; one with no agent gets
 * `""`. Whatever an entry does carry — a time, or text that is no time — is kept
 * as it is, and an entry or `agents` that is not an object is left alone.
 */
function withAgentChosenAt(saved: unknown, at: string): Record<string, unknown> | null {
	if (typeof saved !== "object" || saved === null) return null;
	const filled: Record<string, unknown> = { ...(saved as Record<string, unknown>) };
	let added = false;
	for (const [mode, entry] of Object.entries(filled)) {
		if (typeof entry !== "object" || entry === null) continue;
		const fields = entry as Record<string, unknown>;
		if (needsChosenAt(fields)) {
			filled[mode] = { ...fields, chosenAt: at };
		} else if (fields.chosenAt === undefined) {
			filled[mode] = { ...fields, chosenAt: "" };
		} else continue;
		added = true;
	}
	return added ? filled : null;
}

/** What `mergeSavedSettings` returns: the settings, and what was moved or added. */
export interface MergedSettings {
	/** The object the plugin runs on, and that `saveSettings` writes back. */
	settings: VaultRecorderSettings;
	/** New key names the Swedish-key rename filled in. Empty on every later load. */
	migrated: string[];
	/**
	 * Keys the upgrade rules added. Empty on every later load for most keys; the
	 * `agents` key ("filled in agents") repeats on every load until the settings
	 * are saved, because the saved file still lacks `chosenAt`.
	 */
	upgraded: string[];
	/**
	 * Modes whose agent entry got the moment of this load as `chosenAt`.
	 * Not empty means the settings must be saved, or the next load stamps again.
	 */
	stamped: string[];
	/** True when there was no saved file at all: the English defaults apply. */
	fresh: boolean;
}

/**
 * Build the settings object from whatever `loadData()` returned.
 *
 * `null` (or anything that is not an object) means no settings file: a fresh
 * install, which gets the English defaults untouched. Otherwise the order
 * matters. Defaults first, then the saved data with the two consumed legacy
 * keys removed, then the renamed keys so a value carried across always beats
 * the default it would otherwise fall back to, then what the upgrade rules
 * added. The removal matters too — `saveSettings` writes the result back
 * verbatim, so without it `data.json` would end up holding two spellings of the
 * same setting with nothing to say which is live.
 *
 * Any other key the saved file carries is passed through untouched. This has
 * never been the place that decides what a settings key is, and a settings file
 * written by an older iteration still holds keys nothing reads.
 *
 * Does no I/O and changes nothing it is given, so the same `raw` and `at` always
 * give the same result. Only the default of `at` reads the clock. Exported, so
 * the tests exercise the real merge rather than a copy of it kept in step by
 * hand. `loadSettings` in main.ts is the only caller: it supplies the I/O and
 * announces what moved. `at` is the moment of this load, which an agent entry
 * with no usable `chosenAt` is stamped with; it defaults to now when not given,
 * and `loadSettings` passes it in.
 */
export function mergeSavedSettings(raw: unknown, at: string = loadMoment()): MergedSettings {
	if (typeof raw !== "object" || raw === null) {
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			migrated: [],
			upgraded: [],
			stamped: [],
			fresh: true,
		};
	}

	const migrated = migrateSettings(raw);
	const carried: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of LEGACY_SETTING_KEYS) delete carried[key];
	const upgraded = upgradeSavedSettings({ ...carried, ...migrated }, at);
	const stamped = modesToStamp(carried.agents);

	return {
		settings: Object.assign(
			structuredClone(DEFAULT_SETTINGS),
			carried,
			migrated,
			upgraded,
		),
		migrated: Object.keys(migrated),
		upgraded: Object.keys(upgraded),
		stamped,
		fresh: false,
	};
}
