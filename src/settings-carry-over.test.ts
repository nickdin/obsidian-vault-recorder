import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	OLD_PLUGIN_ID,
	loadSavedSettings,
	oldSettingsPath,
	type VaultAdapterPort,
} from "./settings-carry-over.js";
import { mergeSavedSettings } from "./settings-migration.js";

/**
 * A vault folder in memory. The port has no way to write, so "never writes the
 * old folder" is held by the type; what is checked here is that the files are
 * all still there, unchanged, and which were read.
 */
function fakeVault(files: Record<string, string>) {
	const read: string[] = [];
	const adapter: VaultAdapterPort = {
		exists: async (path) => path in files,
		read: async (path) => {
			read.push(path);
			if (!(path in files)) throw new Error(`ENOENT: ${path}`);
			return files[path];
		},
	};
	return { adapter, read, files };
}

const CONFIG_DIR = "custom-config";
const OLD_PATH = `${CONFIG_DIR}/plugins/obsidian-motesinspelning/data.json`;

// The shape of the settings file the production vault holds under the old id.
const OLD_FILE = {
	audioFolder: "Attachments/Audio",
	dagloggFolder: "5. Journal/Dagloggar",
	dagloggFormat: "YYYYMMDD",
	codecMimeType: "audio/mp4",
	keepAwake: false,
};

describe("the old plugin id's settings", () => {
	it("are looked for in the configuration folder the vault names, not a hardcoded .obsidian", () => {
		assert.equal(OLD_PLUGIN_ID, "obsidian-motesinspelning");
		assert.equal(oldSettingsPath("custom-config"), OLD_PATH);
		assert.equal(
			oldSettingsPath(".obsidian"),
			".obsidian/plugins/obsidian-motesinspelning/data.json",
		);
	});

	it("are carried across when there is no file of its own, and merge like the old file migrated", async () => {
		const vault = fakeVault({ [OLD_PATH]: JSON.stringify(OLD_FILE) });
		const saved = await loadSavedSettings(null, CONFIG_DIR, vault.adapter);

		assert.equal(saved.source, "old-plugin");
		assert.deepEqual(vault.read, [OLD_PATH]);
		// The merged settings are the old file run through the rename and the
		// upgrade rules: literal values, not a second call of the same function.
		const merged = mergeSavedSettings(saved.raw).settings;
		assert.equal(merged.useDailyNotesSettings, false);
		assert.equal(merged.dailyLogFolder, "5. Journal/Dagloggar");
		assert.equal(merged.dailyLogFormat, "YYYYMMDD");
		assert.equal(merged.audioFolder, "Attachments/Audio");
		assert.equal(merged.keepAwake, false);
		assert.equal("dagloggFolder" in merged, false);
		assert.deepEqual(merged.notesHeading, { text: "Anteckningar", level: 1 });
		assert.equal(merged.language, "sv");
	});

	it("are left in place: the file is still there, byte for byte", async () => {
		const text = JSON.stringify(OLD_FILE);
		const vault = fakeVault({ [OLD_PATH]: text });
		await loadSavedSettings(null, CONFIG_DIR, vault.adapter);
		assert.deepEqual(Object.keys(vault.files), [OLD_PATH]);
		assert.equal(await vault.adapter.exists(OLD_PATH), true);
		assert.equal(vault.files[OLD_PATH], text);
	});

	it("lose to the plugin's own file, which is not even read past", async () => {
		const own = {
			notesHeading: { text: "Notes", level: 2 },
			useDailyNotesSettings: true,
			dailyLogFolder: "Journal",
		};
		const vault = fakeVault({ [OLD_PATH]: JSON.stringify(OLD_FILE) });
		const saved = await loadSavedSettings(own, CONFIG_DIR, vault.adapter);

		assert.equal(saved.source, "own");
		assert.deepEqual(vault.read, []);
		const merged = mergeSavedSettings(saved.raw).settings;
		assert.deepEqual(merged.notesHeading, { text: "Notes", level: 2 });
		assert.equal(merged.dailyLogFolder, "Journal");
		assert.equal(merged.audioFolder, "");
		assert.equal(merged.keepAwake, true);
	});

	it("lose to an own file that is empty, because a file that was written is a decision", async () => {
		const vault = fakeVault({ [OLD_PATH]: JSON.stringify(OLD_FILE) });
		const saved = await loadSavedSettings({}, CONFIG_DIR, vault.adapter);
		assert.equal(saved.source, "own");
		assert.deepEqual(vault.read, []);
	});

	it("give a fresh install when neither file exists", async () => {
		const vault = fakeVault({});
		const saved = await loadSavedSettings(null, CONFIG_DIR, vault.adapter);
		assert.deepEqual(saved, { raw: null, source: "none" });
		assert.equal(mergeSavedSettings(saved.raw).fresh, true);
	});

	it("stop with the path named when the old file is not JSON, rather than starting from the defaults", async () => {
		const vault = fakeVault({ [OLD_PATH]: "{ not json" });
		await assert.rejects(
			loadSavedSettings(null, CONFIG_DIR, vault.adapter),
			(err: Error) => err.message.includes(OLD_PATH) && /not valid JSON/.test(err.message),
		);
		assert.equal(vault.files[OLD_PATH], "{ not json");
	});
});
