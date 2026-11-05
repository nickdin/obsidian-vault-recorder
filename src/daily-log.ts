/**
 * A pure daily-log path resolver.
 *
 * It builds the file path of today's daily log from a folder and a date format
 * held in settings. No I/O — string composition only. main.ts uses the result
 * to look the `TFile` up in the vault and decide whether the daily log exists.
 *
 * `dailyLogConfigFor` chooses the folder and format: the Daily Notes plugin's
 * or this plugin's own, by the "use the Daily notes settings" switch.
 *
 * Supported format tokens: YYYY, MM, DD, HH, mm, ss.
 */

export interface DailyLogConfig {
	/** A folder in the vault, for example "5. Journal". Empty string = vault root. */
	folder: string;
	/** A date format, for example "YYYY-MM-DD" or "YYYYMMDD". */
	format: string;
}

/** The settings that decide where today's daily log is. */
export interface DailyLogSettings {
	useDailyNotesSettings: boolean;
	dailyLogFolder: string;
	dailyLogFormat: string;
}

/** The folder and format the Daily Notes core plugin is set to, as it stores them. */
export interface DailyNotesOptions {
	folder?: string;
	format?: string;
}

/**
 * The part of Obsidian's internal-plugins object this reads, typed narrowly so
 * this module needs no `obsidian` import. What `getEnabledPluginById` returns
 * differs by version: Obsidian 1.14.4 hands back the plugin instance itself
 * (`options` on it), older versions a wrapper holding it as `instance`.
 */
export interface InternalPluginsPort {
	getEnabledPluginById?: (id: string) => {
		options?: DailyNotesOptions;
		instance?: { options?: DailyNotesOptions };
	} | null;
}

/** The Daily Notes core plugin's folder and format, or `undefined` when it is off. */
export function readDailyNotesOptions(
	internalPlugins: InternalPluginsPort | undefined,
): DailyNotesOptions | undefined {
	const plugin = internalPlugins?.getEnabledPluginById?.("daily-notes");
	return plugin?.options ?? plugin?.instance?.options;
}

/** What the Daily Notes plugin itself uses for a blank format. */
const DAILY_NOTES_DEFAULT_FORMAT = "YYYY-MM-DD";

/**
 * Pick the folder and format today's daily log is looked up with.
 *
 * With `useDailyNotesSettings` on, the Daily Notes core plugin's own folder and
 * format. `dailyNotes` is `undefined` when that plugin is off or its options
 * cannot be read, and its folder may be blank; in both cases the plugin's own
 * pair, taken as saved, is the answer — the old code kept a saved pair then too,
 * and an upgraded vault keeps the behaviour it had. A fresh install's own
 * pair is the vault root and `YYYY-MM-DD`, so it lands where a freshly enabled
 * Daily Notes would write. A set folder with a blank format means `YYYY-MM-DD`,
 * as Daily Notes itself does. With the switch off, the plugin's own pair, taken
 * as saved.
 */
export function dailyLogConfigFor(
	settings: DailyLogSettings,
	dailyNotes: DailyNotesOptions | undefined,
): DailyLogConfig {
	if (!settings.useDailyNotesSettings) {
		return { folder: settings.dailyLogFolder, format: settings.dailyLogFormat };
	}
	const folder = typeof dailyNotes?.folder === "string" ? dailyNotes.folder.trim() : "";
	if (folder === "") {
		return { folder: settings.dailyLogFolder, format: settings.dailyLogFormat };
	}
	const format =
		typeof dailyNotes?.format === "string" && dailyNotes.format.trim() !== ""
			? dailyNotes.format.trim()
			: DAILY_NOTES_DEFAULT_FORMAT;
	return { folder, format };
}

export function resolveDailyLog(now: Date, config: DailyLogConfig): string {
	const formatted = formatDate(now, config.format);
	const normalizedFolder = config.folder.replace(/\/+$/, "").replace(/^\/+/, "");
	if (normalizedFolder === "") return `${formatted}.md`;
	return `${normalizedFolder}/${formatted}.md`;
}

function formatDate(d: Date, pattern: string): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return pattern
		.replace(/YYYY/g, d.getFullYear().toString().padStart(4, "0"))
		.replace(/MM/g, pad(d.getMonth() + 1))
		.replace(/DD/g, pad(d.getDate()))
		.replace(/HH/g, pad(d.getHours()))
		.replace(/mm/g, pad(d.getMinutes()))
		.replace(/ss/g, pad(d.getSeconds()));
}
