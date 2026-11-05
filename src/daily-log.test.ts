import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	dailyLogConfigFor,
	readDailyNotesOptions,
	resolveDailyLog,
	type InternalPluginsPort,
} from "./daily-log.js";

// #94: Obsidian 1.14.4's getEnabledPluginById returns the plugin instance itself
// (options on it, no `instance` key); older versions return a wrapper holding
// `instance`. Both shapes are faked here as the drive read them back.
describe("readDailyNotesOptions", () => {
	const options = { folder: "Areas/Daily", format: "YYYYMMDD" };
	const portReturning = (
		plugin: ReturnType<NonNullable<InternalPluginsPort["getEnabledPluginById"]>>,
	): InternalPluginsPort => ({
		getEnabledPluginById: (id: string) => (id === "daily-notes" ? plugin : null),
	});

	it("reads .options from the object Obsidian 1.14.4 returns", () => {
		assert.deepEqual(readDailyNotesOptions(portReturning({ options })), options);
	});

	it("falls back to .instance.options for a wrapper from an older Obsidian", () => {
		assert.deepEqual(readDailyNotesOptions(portReturning({ instance: { options } })), options);
	});

	it("is undefined for a disabled plugin (null) and for an object holding no options", () => {
		assert.equal(readDailyNotesOptions(portReturning(null)), undefined);
		assert.equal(readDailyNotesOptions(portReturning({})), undefined);
	});

	it("is undefined when internalPlugins or its getter is missing", () => {
		assert.equal(readDailyNotesOptions(undefined), undefined);
		assert.equal(readDailyNotesOptions({}), undefined);
	});
});

describe("resolveDailyLog", () => {
	it("builds a YYYY-MM-DD path in the folder '5. Journal'", () => {
		const now = new Date(2026, 3, 22, 10, 15, 0); // April is month 3, zero-indexed
		const path = resolveDailyLog(now, { folder: "5. Journal", format: "YYYY-MM-DD" });
		assert.equal(path, "5. Journal/2026-04-22.md");
	});

	it("puts the file in the vault root for an empty folder", () => {
		const now = new Date(2026, 0, 1);
		const path = resolveDailyLog(now, { folder: "", format: "YYYY-MM-DD" });
		assert.equal(path, "2026-01-01.md");
	});

	it("normalises a folder with a trailing slash", () => {
		const now = new Date(2026, 3, 22);
		const path = resolveDailyLog(now, { folder: "5. Journal/", format: "YYYY-MM-DD" });
		assert.equal(path, "5. Journal/2026-04-22.md");
	});

	it("normalises a folder with a leading slash", () => {
		const now = new Date(2026, 3, 22);
		const path = resolveDailyLog(now, { folder: "/Journal", format: "YYYY-MM-DD" });
		assert.equal(path, "Journal/2026-04-22.md");
	});

	it("handles the alternative format YYYYMMDD", () => {
		const now = new Date(2026, 11, 5); // December, the 5th
		const path = resolveDailyLog(now, { folder: "Log", format: "YYYYMMDD" });
		assert.equal(path, "Log/20261205.md");
	});

	it("pads a single-digit month and day correctly", () => {
		const now = new Date(2026, 0, 3); // January, the 3rd
		const path = resolveDailyLog(now, { folder: "", format: "YYYY-MM-DD" });
		assert.equal(path, "2026-01-03.md");
	});

	it("pads a format carrying HH, mm and ss", () => {
		const now = new Date(2026, 3, 22, 7, 5, 9);
		const path = resolveDailyLog(now, { folder: "", format: "YYYY-MM-DD-HHmmss" });
		assert.equal(path, "2026-04-22-070509.md");
	});

	it("preserves a nested folder", () => {
		const now = new Date(2026, 3, 22);
		const path = resolveDailyLog(now, { folder: "Areas/Journal", format: "YYYY-MM-DD" });
		assert.equal(path, "Areas/Journal/2026-04-22.md");
	});
});

describe("dailyLogConfigFor", () => {
	const own = { dailyLogFolder: "Journal", dailyLogFormat: "YYYYMMDD" };

	it("takes the Daily Notes plugin's folder and format when the switch is on, ignoring the plugin's own pair", () => {
		const config = dailyLogConfigFor(
			{ ...own, useDailyNotesSettings: true },
			{ folder: "Areas/Daily", format: "YYYY-MM-DD" },
		);
		assert.deepEqual(config, { folder: "Areas/Daily", format: "YYYY-MM-DD" });
	});

	it("takes the plugin's own pair when the switch is off, ignoring Daily Notes", () => {
		const config = dailyLogConfigFor(
			{ ...own, useDailyNotesSettings: false },
			{ folder: "Areas/Daily", format: "YYYY-MM-DD" },
		);
		assert.deepEqual(config, { folder: "Journal", format: "YYYYMMDD" });
	});

	it("falls back to the plugin's own pair when Daily Notes is off or its folder is blank", () => {
		const on = { ...own, useDailyNotesSettings: true };
		const expected = { folder: "Journal", format: "YYYYMMDD" };
		assert.deepEqual(dailyLogConfigFor(on, undefined), expected);
		assert.deepEqual(dailyLogConfigFor(on, {}), expected);
		assert.deepEqual(dailyLogConfigFor(on, { folder: "  ", format: "" }), expected);
	});

	it("lands on the vault root and YYYY-MM-DD when the own pair is the fresh-install default", () => {
		const fresh = { dailyLogFolder: "", dailyLogFormat: "YYYY-MM-DD", useDailyNotesSettings: true };
		const expected = { folder: "", format: "YYYY-MM-DD" };
		assert.deepEqual(dailyLogConfigFor(fresh, undefined), expected);
		assert.deepEqual(dailyLogConfigFor(fresh, { folder: "" }), expected);
	});

	it("means YYYY-MM-DD for a blank Daily Notes format when its folder is set", () => {
		const on = { ...own, useDailyNotesSettings: true };
		assert.deepEqual(dailyLogConfigFor(on, { folder: "Areas/Daily", format: " " }), {
			folder: "Areas/Daily",
			format: "YYYY-MM-DD",
		});
	});

	it("resolves to the path of the Daily Notes plugin's log through resolveDailyLog", () => {
		const config = dailyLogConfigFor(
			{ ...own, useDailyNotesSettings: true },
			{ folder: "Daily/", format: "YYYYMMDD" },
		);
		assert.equal(resolveDailyLog(new Date(2026, 3, 22), config), "Daily/20260422.md");
	});
});
