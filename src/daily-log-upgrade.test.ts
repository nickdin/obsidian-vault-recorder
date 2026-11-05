import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { dailyLogConfigFor, resolveDailyLog } from "./daily-log.js";
import { mergeSavedSettings } from "./settings-migration.js";

// #70 says an upgraded vault "keeps the behaviour it had". The old code kept the
// saved daily-log pair when Daily Notes was off or its folder blank; the upgrade
// switches the vault to "use the Daily Notes settings", so that switch must fall
// back to the saved pair in those two cases, not to a literal vault root.
describe("a vault upgraded from the old default daily-log pair", () => {
	const settings = mergeSavedSettings({
		dagloggFolder: "5. Journal",
		dagloggFormat: "YYYY-MM-DD",
	}).settings;
	const day = new Date(2026, 9, 22);
	const pathFor = (dailyNotes: Parameters<typeof dailyLogConfigFor>[1]) =>
		resolveDailyLog(day, dailyLogConfigFor(settings, dailyNotes));

	it("has the switch on and its own pair kept", () => {
		assert.equal(settings.useDailyNotesSettings, true);
		assert.equal(settings.dailyLogFolder, "5. Journal");
	});

	it("still finds 5. Journal when Daily Notes is off", () => {
		assert.equal(pathFor(undefined), "5. Journal/2026-10-22.md");
	});

	it("still finds 5. Journal when Daily Notes' folder is blank", () => {
		assert.equal(pathFor({ folder: "" }), "5. Journal/2026-10-22.md");
	});
});
