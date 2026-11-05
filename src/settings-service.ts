/**
 * The settings page's part for a service transcriber: an address, a key name
 * and a model name for one recording mode.
 *
 * The key itself is never typed into a settings box. `SecretComponent` lets
 * the user pick or create an entry in Obsidian's Keychain, and the settings
 * hold only that entry's name. The page marks a name that has no key on this
 * device, since a name syncs with the settings and the key does not.
 */

import { SecretComponent, Setting, type App } from "obsidian";

import { keyNameProblem, type KeyStore } from "./key-store";
import type { RecordingModeKey, TranscriberEntry } from "./settings-data";

const MODE_LABELS: Record<RecordingModeKey, string> = {
	dailyLog: "Daily log",
	cursor: "Cursor",
	meeting: "Meeting",
};

export interface ServiceSettingsContext {
	app: App;
	keys: KeyStore;
	/** Persist the settings after a change. */
	save: () => Promise<void>;
	/** Draw the page again, after a change that alters what it shows. */
	redraw: () => void;
	/** Bring the lines that quote the address up to date, without drawing the page again. */
	addressChanged?: () => void;
}

/** What the page says about the key name in `entry`: empty when there is nothing to say. */
export function keyNameNotice(entry: Pick<TranscriberEntry, "keyName">, keys: KeyStore): string {
	const name = entry.keyName.trim();
	if (name === "") return "No key is sent.";
	const problem = keyNameProblem(name);
	if (problem !== null) return problem;
	return keys.get(name) === null
		? `Missing: there is no key called '${name}' in this device's Keychain. Recordings for this mode wait until you pick or create it here.`
		: `The key '${name}' is in this device's Keychain.`;
}

/**
 * Draw the three fields of a service transcriber under the mode's picker.
 * Called by the settings page when the mode's kind is `service`.
 */
export function renderServiceFields(
	containerEl: HTMLElement,
	mode: RecordingModeKey,
	entry: TranscriberEntry,
	context: ServiceSettingsContext,
): void {
	const label = MODE_LABELS[mode];

	new Setting(containerEl)
		.setName(`${label} service address`)
		.setDesc(
			"The service's API address, without the final '/audio/transcriptions' — for example 'https://api.openai.com/v1'. The recording is sent there from this device.",
		)
		.addText((text) =>
			text
				.setPlaceholder("https://api.openai.com/v1")
				.setValue(entry.address)
				.onChange(async (value) => {
					entry.address = value.trim();
					await context.save();
					context.addressChanged?.();
				}),
		);

	const keySetting = new Setting(containerEl)
		.setName(`${label} service key`)
		.setDesc(keyNameNotice(entry, context.keys));
	keySetting.addComponent((el) =>
		new SecretComponent(context.app, el).setValue(entry.keyName).onChange(async (value) => {
			entry.keyName = (value ?? "").trim();
			await context.save();
			keySetting.setDesc(keyNameNotice(entry, context.keys));
		}),
	);

	new Setting(containerEl)
		.setName(`${label} service model`)
		.setDesc("The model name the service expects, for example 'whisper-1'.")
		.addText((text) =>
			text.setValue(entry.modelName).onChange(async (value) => {
				entry.modelName = value.trim();
				await context.save();
			}),
		);

	if (mode === "meeting") {
		containerEl.createEl("p", {
			text: "A meeting sent to a service comes back as plain text, without speakers.",
			cls: "setting-item-description",
		});
	}
}
