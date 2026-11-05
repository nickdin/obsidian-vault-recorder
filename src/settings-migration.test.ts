import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	LEGACY_SETTING_KEYS,
	mergeSavedSettings,
	migrateSettings,
	upgradeSavedSettings,
} from "./settings-migration.js";
import { DEFAULT_SETTINGS } from "./settings-data.js";

/**
 * The merge itself, not a copy of it. `loadSettings` in main.ts is one call to
 * `mergeSavedSettings` plus the Obsidian I/O, so deleting a step from the merge
 * turns these tests red — which a hand-kept reimplementation here could not do.
 */
const merge = (raw: unknown) => mergeSavedSettings(raw).settings;

describe("migrateSettings", () => {
	it("carries both old keys across when both are present", () => {
		const migrated = migrateSettings({
			dagloggFolder: "5. Journal/Dagloggar",
			dagloggFormat: "YYYYMMDD",
		});
		assert.deepEqual(migrated, {
			dailyLogFolder: "5. Journal/Dagloggar",
			dailyLogFormat: "YYYYMMDD",
		});
	});

	it("returns nothing when neither old key is present", () => {
		const migrated = migrateSettings({
			audioFolder: "Attachments/Audio",
			keepAwake: true,
		});
		assert.deepEqual(migrated, {});
	});

	it("carries only the folder when only the folder is present", () => {
		const migrated = migrateSettings({ dagloggFolder: "Journal" });
		assert.deepEqual(migrated, { dailyLogFolder: "Journal" });
	});

	it("carries only the format when only the format is present", () => {
		const migrated = migrateSettings({ dagloggFormat: "YYYY-MM-DD" });
		assert.deepEqual(migrated, { dailyLogFormat: "YYYY-MM-DD" });
	});

	it("returns nothing for an empty object", () => {
		assert.deepEqual(migrateSettings({}), {});
	});

	// The real production settings file, read at the audit on 2026-08-19. This
	// is the case the phase exists for: the configured folder must survive.
	it("carries the production vault's saved settings across intact", () => {
		const production = {
			audioFolder: "/",
			dagloggFolder: "5. Journal",
			dagloggFormat: "YYYY-MM-DD",
			codecMimeType: "audio/mp4",
			keepAwake: true,
		};
		assert.deepEqual(migrateSettings(production), {
			dailyLogFolder: "5. Journal",
			dailyLogFormat: "YYYY-MM-DD",
		});
	});

	it("leaves a new key already present alone rather than overwriting it", () => {
		const migrated = migrateSettings({
			dagloggFolder: "the old value",
			dailyLogFolder: "the new value",
			dagloggFormat: "YYYYMMDD",
		});
		assert.deepEqual(migrated, {
			dailyLogFormat: "YYYYMMDD",
		});
	});

	it("ignores an old value that is not a string", () => {
		const migrated = migrateSettings({
			dagloggFolder: 5,
			dagloggFormat: null,
		});
		assert.deepEqual(migrated, {});
	});

	// An empty folder is a real configuration, not a missing one: `resolveDailyLog`
	// reads it as the vault root, and clearing the Folder field in the settings
	// panel saves exactly that. Dropping it was this module's own bug, found by
	// `/code-review high` on 2026-08-19 — the silent reset it exists to prevent.
	it("carries an empty old value, because an empty folder means the vault root", () => {
		const migrated = migrateSettings({
			dagloggFolder: "",
			dagloggFormat: "   ",
		});
		assert.deepEqual(migrated, {
			dailyLogFolder: "",
			dailyLogFormat: "   ",
		});
	});

	it("returns an empty object for null and for a non-object", () => {
		assert.deepEqual(migrateSettings(null), {});
		assert.deepEqual(migrateSettings(undefined), {});
		assert.deepEqual(migrateSettings("dagloggFolder"), {});
		assert.deepEqual(migrateSettings(42), {});
	});

	it("does not mutate the object it was given", () => {
		const raw = { dagloggFolder: "Journal", dagloggFormat: "YYYY-MM-DD" };
		migrateSettings(raw);
		assert.deepEqual(raw, {
			dagloggFolder: "Journal",
			dagloggFormat: "YYYY-MM-DD",
		});
	});

	it("names exactly the two keys loadSettings has to strip", () => {
		// If a third key is ever renamed, this fails until LEGACY_SETTING_KEYS
		// is updated too — main.ts deletes by that list, not by the map.
		assert.deepEqual([...LEGACY_SETTING_KEYS], [
			"dagloggFolder",
			"dagloggFormat",
		]);
	});
});

describe("the settings merge loadSettings performs", () => {
	// This is the failure the phase exists to prevent: a renamed key is not an
	// error, it is ignored, and the default silently replaces what the user
	// configured. Nothing goes red anywhere, so this test is the only alarm.
	it("keeps a configured daily-log folder that differs from the default", () => {
		const settings = merge({
			audioFolder: "Attachments/Audio",
			dagloggFolder: "5. Journal/Dagloggar",
			dagloggFormat: "YYYYMMDD",
			keepAwake: false,
		});
		assert.equal(settings.dailyLogFolder, "5. Journal/Dagloggar");
		assert.equal(settings.dailyLogFormat, "YYYYMMDD");
		assert.notEqual(settings.dailyLogFormat, DEFAULT_SETTINGS.dailyLogFormat);
	});

	it("leaves the two legacy keys out of what gets saved back", () => {
		const settings = merge({
			dagloggFolder: "Journal",
			dagloggFormat: "YYYY-MM-DD",
		});
		// saveSettings writes this object back verbatim, so a legacy key
		// surviving here would sit in data.json forever beside its replacement.
		assert.equal("dagloggFolder" in settings, false);
		assert.equal("dagloggFormat" in settings, false);
	});

	it("passes unknown keys through, as it always has", () => {
		const settings = merge({
			ffmpegPath: "",
			attachmentFolder: "Attachments/Audio",
		}) as unknown as Record<string, unknown>;
		assert.equal(settings.ffmpegPath, "");
		assert.equal(settings.attachmentFolder, "Attachments/Audio");
	});

	// A file with no `notesHeading` predates the English-default settings, so it
	// receives the values the plugin ran on for that user; every other setting
	// takes its default.
	it("gives a written empty settings file the predating Swedish values and every other default", () => {
		assert.deepEqual(merge({}), {
			...DEFAULT_SETTINGS,
			notesHeading: { text: "Anteckningar", level: 1 },
			participantsProperty: "deltagare",
			language: "sv",
		});
	});

	it("does not let a stale legacy key override a value already migrated", () => {
		const settings = merge({
			dagloggFolder: "the old value",
			dailyLogFolder: "the new value",
		});
		assert.equal(settings.dailyLogFolder, "the new value");
	});

	// The regression this module was written to prevent, in the one shape it
	// originally still had. A user keeping daily logs in the vault root has
	// `dagloggFolder: ""` saved; the default is `5. Journal`, so a dropped
	// empty value silently moves every future recording to a folder they never
	// chose — and their daily-log recording then refuses with "Today's daily
	// log is missing".
	it("keeps a vault-root daily log at the vault root", () => {
		const settings = merge({
			dagloggFolder: "",
			dagloggFormat: "YYYY-MM-DD",
		});
		assert.equal(settings.dailyLogFolder, "");
		// The old default folder; `DEFAULT_SETTINGS.dailyLogFolder` is the vault
		// root now, so it can no longer stand in for "what a dropped value becomes".
		assert.notEqual(settings.dailyLogFolder, "5. Journal");
		// And the saved pair is used, not the Daily Notes plugin's.
		assert.equal(settings.useDailyNotesSettings, false);
	});

	it("reports which keys it moved, and reports none on a later load", () => {
		assert.deepEqual(
			mergeSavedSettings({ dagloggFolder: "Journal" }).migrated,
			["dailyLogFolder"],
		);
		assert.deepEqual(
			mergeSavedSettings({ dailyLogFolder: "Journal" }).migrated,
			[],
		);
	});

	it("survives a settings file that is missing, or is not an object", () => {
		// `loadData()` returns null for a plugin that has never saved anything.
		assert.deepEqual(merge(null), DEFAULT_SETTINGS);
		assert.deepEqual(merge(undefined), DEFAULT_SETTINGS);
		assert.deepEqual(merge("nonsense"), DEFAULT_SETTINGS);
	});
});

// The pair every version before the English-default settings defaulted to. A
// literal here, not `DEFAULT_SETTINGS`, because the default moved on and the
// rule is about what an old file holds.
const OLD_FOLDER = "5. Journal";
const OLD_FORMAT = "YYYY-MM-DD";

describe("a settings file written before the English-default settings", () => {
	it("receives the Swedish heading at level 1, the Swedish participants property and Swedish when it has no notesHeading", () => {
		const settings = merge({ audioFolder: "Attachments/Audio", keepAwake: false });
		assert.deepEqual(settings.notesHeading, { text: "Anteckningar", level: 1 });
		assert.equal(settings.participantsProperty, "deltagare");
		assert.equal(settings.language, "sv");
		// What the file did carry is not touched.
		assert.equal(settings.audioFolder, "Attachments/Audio");
		assert.equal(settings.keepAwake, false);
	});

	it("leaves a file that has notesHeading alone, every one of the three", () => {
		const settings = merge({
			notesHeading: { text: "Notes", level: 2 },
			participantsProperty: "people",
			language: "en",
		});
		assert.deepEqual(settings.notesHeading, { text: "Notes", level: 2 });
		assert.equal(settings.participantsProperty, "people");
		assert.equal(settings.language, "en");
	});

	it("keeps a participants property or language the predating file already carries", () => {
		// Carry, do not judge: a value the file holds is the user's, whichever
		// rule would otherwise have filled it.
		const settings = merge({ participantsProperty: "attendees", language: "en" });
		assert.equal(settings.participantsProperty, "attendees");
		assert.equal(settings.language, "en");
		assert.deepEqual(settings.notesHeading, { text: "Anteckningar", level: 1 });
	});

	it("reports the keys the rules added, and none on a later load", () => {
		const first = mergeSavedSettings({ dagloggFolder: "Journal" });
		assert.deepEqual(first.upgraded.sort(), [
			"dailyLogFormat",
			"language",
			"notesHeading",
			"participantsProperty",
			"useDailyNotesSettings",
		]);
		const second = mergeSavedSettings(first.settings);
		assert.deepEqual(second.upgraded, []);
		assert.deepEqual(second.settings, first.settings);
	});

	it("turns the stale pair 5. Journal + YYYY-MM-DD into 'use the Daily Notes settings'", () => {
		// Under the old key names, as the production file holds them.
		assert.equal(
			merge({ dagloggFolder: OLD_FOLDER, dagloggFormat: OLD_FORMAT })
				.useDailyNotesSettings,
			true,
		);
		// And under the new names, in a file that already has a notes heading
		// but never saved the switch.
		assert.equal(
			merge({
				notesHeading: { text: "Notes", level: 1 },
				dailyLogFolder: OLD_FOLDER,
				dailyLogFormat: OLD_FORMAT,
			}).useDailyNotesSettings,
			true,
		);
	});

	it("keeps the behaviour of a pair the user changed: the switch is off and the pair stays", () => {
		const settings = merge({
			dagloggFolder: "5. Journal/Dagloggar",
			dagloggFormat: "YYYYMMDD",
		});
		assert.equal(settings.useDailyNotesSettings, false);
		assert.equal(settings.dailyLogFolder, "5. Journal/Dagloggar");
		assert.equal(settings.dailyLogFormat, "YYYYMMDD");
	});

	it("fills the half of a changed pair that was never saved with the old default it ran on", () => {
		const onlyFormat = merge({ dagloggFormat: "YYYYMMDD" });
		assert.equal(onlyFormat.useDailyNotesSettings, false);
		assert.equal(onlyFormat.dailyLogFolder, OLD_FOLDER);
		assert.equal(onlyFormat.dailyLogFormat, "YYYYMMDD");

		const onlyFolder = merge({ dagloggFolder: "Journal" });
		assert.equal(onlyFolder.useDailyNotesSettings, false);
		assert.equal(onlyFolder.dailyLogFolder, "Journal");
		assert.equal(onlyFolder.dailyLogFormat, OLD_FORMAT);
	});

	it("compares the pair exactly: a trailing slash is a pair the user chose", () => {
		const settings = merge({ dagloggFolder: "5. Journal/", dagloggFormat: OLD_FORMAT });
		assert.equal(settings.useDailyNotesSettings, false);
		assert.equal(settings.dailyLogFolder, "5. Journal/");
		// Whitespace is part of the value as well: nothing is trimmed on the way.
		const padded = merge({ dagloggFolder: "5. Journal ", dagloggFormat: OLD_FORMAT });
		assert.equal(padded.useDailyNotesSettings, false);
		assert.equal(padded.dailyLogFolder, "5. Journal ");
	});

	it("treats a predating file that never saved a pair as running on the old default, so the switch is on", () => {
		// The old code copied Daily Notes' folder and format over exactly this
		// pair, which is what the switch does now.
		const raw = { audioFolder: "Attachments/Audio" };
		// The new default is already `true`, so the merged value alone cannot tell
		// rule 2 from no rule: the rule must have *added* the key.
		assert.equal(upgradeSavedSettings(raw).useDailyNotesSettings, true);
		assert.ok(mergeSavedSettings(raw).upgraded.includes("useDailyNotesSettings"));
		const settings = merge(raw);
		assert.equal(settings.useDailyNotesSettings, true);
		assert.equal(settings.dailyLogFolder, DEFAULT_SETTINGS.dailyLogFolder);
		assert.equal(settings.dailyLogFormat, DEFAULT_SETTINGS.dailyLogFormat);
	});

	it("leaves a saved switch alone, even beside the stale pair", () => {
		const settings = merge({
			notesHeading: { text: "Notes", level: 1 },
			useDailyNotesSettings: false,
			dailyLogFolder: OLD_FOLDER,
			dailyLogFormat: OLD_FORMAT,
		});
		assert.equal(settings.useDailyNotesSettings, false);
	});

	it("upgrades the real production file", () => {
		const production = {
			audioFolder: "/",
			dagloggFolder: "5. Journal",
			dagloggFormat: "YYYY-MM-DD",
			codecMimeType: "audio/mp4",
			keepAwake: true,
		};
		assert.deepEqual(merge(production), {
			...DEFAULT_SETTINGS,
			notesHeading: { text: "Anteckningar", level: 1 },
			participantsProperty: "deltagare",
			language: "sv",
			useDailyNotesSettings: true,
			audioFolder: "/",
			dailyLogFolder: "5. Journal",
			dailyLogFormat: "YYYY-MM-DD",
			codecMimeType: "audio/mp4",
		});
	});
});

describe("a fresh install", () => {
	it("gets the English defaults, with no Swedish value anywhere", () => {
		const { settings, fresh, migrated, upgraded } = mergeSavedSettings(null);
		assert.equal(fresh, true);
		assert.deepEqual(migrated, []);
		assert.deepEqual(upgraded, []);
		assert.deepEqual(settings.notesHeading, { text: "Notes", level: 1 });
		assert.equal(settings.useDailyNotesSettings, true);
		assert.equal(settings.dailyLogFolder, "");
		assert.equal(settings.dailyLogFormat, "YYYY-MM-DD");
		assert.equal(settings.participantsProperty, "participants");
		assert.equal(settings.ownerName, "");
		assert.equal(settings.language, "detect");
		assert.equal(settings.audioFolder, "");
		assert.equal(settings.transcriptFolder, "");
		assert.equal(settings.modelFolder, "vault-recorder/models");
		assert.equal(settings.keepTimeDays, null);
		assert.equal(settings.overdueHours, 24);
	});

	it("is not fresh when a file exists, even an empty one", () => {
		assert.equal(mergeSavedSettings({}).fresh, false);
		assert.equal(mergeSavedSettings(null).fresh, true);
	});

	it("holds a transcriber and an agent entry of 'none' for each of the three modes, every field a string", () => {
		const { transcribers, agents } = merge(null);
		for (const mode of ["dailyLog", "cursor", "meeting"] as const) {
			assert.deepEqual(transcribers[mode], {
				kind: "none",
				modelId: "",
				address: "",
				keyName: "",
				modelName: "",
			});
			assert.deepEqual(agents[mode], {
				kind: "none",
				instruction: "",
				contextNotePath: "",
				address: "",
				keyName: "",
				modelName: "",
				chosenAt: "",
			});
		}
		assert.deepEqual(Object.keys(transcribers).sort(), ["cursor", "dailyLog", "meeting"]);
		assert.deepEqual(Object.keys(agents).sort(), ["cursor", "dailyLog", "meeting"]);
	});

	it("hands out a copy, so changing a setting never changes the defaults", () => {
		const settings = merge(null);
		settings.notesHeading.text = "changed";
		settings.transcribers.meeting.address = "changed";
		assert.equal(DEFAULT_SETTINGS.notesHeading.text, "Notes");
		assert.equal(DEFAULT_SETTINGS.transcribers.meeting.address, "");
		assert.equal(merge(null).notesHeading.text, "Notes");
	});
});

describe("the moment an agent was chosen survives the settings merge", () => {
	const SAVED = {
		kind: "service",
		instruction: "Summarise.",
		contextNotePath: "",
		address: "http://127.0.0.1:11434/v1",
		keyName: "",
		modelName: "llama3.2",
	};
	const NONE = { ...SAVED, kind: "none", instruction: "", address: "", modelName: "" };
	const agentsOf = (meeting: Record<string, unknown>) => ({ dailyLog: NONE, cursor: NONE, meeting });

	it("carries a saved moment as it is", () => {
		const settings = merge({ agents: agentsOf({ ...SAVED, chosenAt: "2026-10-22T11:00:00+02:00" }) });
		assert.equal(settings.agents.meeting.chosenAt, "2026-10-22T11:00:00+02:00");
	});

	it("gives an entry with an agent, saved before the field, the moment of the load, and keeps the rest of the entry", () => {
		const { settings, upgraded } = mergeSavedSettings({ agents: agentsOf(SAVED) }, "2026-10-29T08:00:00+01:00");
		assert.equal(settings.agents.meeting.chosenAt, "2026-10-29T08:00:00+01:00");
		assert.equal(settings.agents.dailyLog.chosenAt, "");
		assert.equal(settings.agents.meeting.modelName, "llama3.2");
		assert.equal(settings.agents.meeting.kind, "service");
		assert.ok(upgraded.includes("agents"));
	});

	it("does not judge a moment: a value it cannot read is carried too", () => {
		const settings = merge({ agents: agentsOf({ ...SAVED, chosenAt: "last Tuesday" }) });
		assert.equal(settings.agents.meeting.chosenAt, "last Tuesday");
	});

	it("reports nothing on a later load", () => {
		const first = mergeSavedSettings({ agents: agentsOf(SAVED) });
		assert.deepEqual(mergeSavedSettings(first.settings).upgraded, []);
	});
});
