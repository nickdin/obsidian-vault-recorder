/**
 * The key store: where a service's secret key is read from.
 *
 * The secret lives in Obsidian's Keychain (`app.secretStorage`) on the device
 * where it was entered and nowhere else; the plugin's settings hold only its
 * name. There is no fallback to the settings file, so a device without the
 * key cannot send, and says so.
 *
 * The interface is kept free of Obsidian so the service adapter is tested
 * with a fake; only `createObsidianKeyStore` touches the application.
 */

import type { App } from "obsidian";

export interface KeyStore {
	/** The secret stored under `name` on this device, or `null` when there is none. */
	get(name: string): string | null;
}

export function createObsidianKeyStore(app: App): KeyStore {
	return {
		get(name) {
			const secret = app.secretStorage.getSecret(name);
			return secret === null || secret === "" ? null : secret;
		},
	};
}

/**
 * The Keychain accepts lowercase letters, digits and single dashes as a name.
 * Returns what is wrong with `name`, or `null` when it is a usable name.
 */
export function keyNameProblem(name: string): string | null {
	if (name === "") return null;
	if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null;
	return "A key name uses lowercase letters, digits and single dashes only, for example 'openai-key'.";
}
