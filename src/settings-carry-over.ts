/**
 * Find the saved settings to start from: the plugin's own file, or, on first
 * load of the renamed plugin, the old plugin id's file.
 *
 * The plugin was called `obsidian-motesinspelning` until 2026-08-19. Obsidian
 * keeps a plugin's settings in `<configDir>/plugins/<id>/data.json`, so a vault
 * that installs the renamed plugin sees no settings at all — `loadData()` returns
 * `null` — and would start from the defaults while the old file sits unread next
 * door. This module reads that file and hands it back; `mergeSavedSettings` then
 * runs the key rename and the upgrade rules on it exactly as it would on the
 * plugin's own file.
 *
 * It reads and never writes. The old folder is left as it is, so the old plugin
 * still works if it is switched back on, and nothing is lost if the carry is
 * wrong.
 *
 * Separate from `main.ts` so it runs under Node: the vault is reached through
 * the small port below, which Obsidian's `vault.adapter` satisfies as it stands.
 */

/** The plugin's id before the 2026-08-19 rename. */
export const OLD_PLUGIN_ID = "obsidian-motesinspelning";

/**
 * The two things this module needs from the vault's file adapter. Obsidian's
 * `app.vault.adapter` has both with these signatures, and reaches hidden
 * folders such as the configuration folder, which the vault's indexed files do
 * not.
 */
export interface VaultAdapterPort {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

export interface SavedSettings {
	/** What `mergeSavedSettings` takes. `null` means there was no file at all. */
	raw: unknown;
	/** Where it came from, so the caller can save the carried copy and say so. */
	source: "own" | "old-plugin" | "none";
}

/** Where the old plugin id kept its settings. `configDir` is `app.vault.configDir`. */
export function oldSettingsPath(configDir: string): string {
	return `${configDir}/plugins/${OLD_PLUGIN_ID}/data.json`;
}

/**
 * Choose the saved settings.
 *
 * - `ownData` is what the plugin's own `loadData()` returned. Anything but
 *   `null` or `undefined` is a file of its own, and it wins — also when it is
 *   empty, because a file that was written is a decision and not an absence.
 * - With none, the old id's file is read if it exists. A file that exists but
 *   cannot be read as JSON throws, naming the path: falling back to the
 *   defaults would be a silent reset of the user's settings, and the first save
 *   after it would make the reset permanent.
 */
export async function loadSavedSettings(
	ownData: unknown,
	configDir: string,
	adapter: VaultAdapterPort,
): Promise<SavedSettings> {
	if (ownData !== null && ownData !== undefined) {
		return { raw: ownData, source: "own" };
	}

	const path = oldSettingsPath(configDir);
	if (!(await adapter.exists(path))) return { raw: null, source: "none" };

	const text = await adapter.read(path);
	try {
		return { raw: JSON.parse(text), source: "old-plugin" };
	} catch (err) {
		throw new Error(
			`Vault Recorder could not carry the old plugin's settings across: ` +
				`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
				`Fix or move that file and reload the plugin; nothing has been changed.`,
		);
	}
}
