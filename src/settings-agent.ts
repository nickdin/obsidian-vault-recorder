/**
 * The settings page's part for a service agent: the instruction in the user's
 * words, an optional context note, and an address, a key name and a model name
 * for one recording mode.
 *
 * The key is picked from Obsidian's Keychain exactly as for a service
 * transcriber; the settings hold only its name.
 */

import { SecretComponent, Setting } from "obsidian";

import { defaultInstructionFor } from "./agent-service";
import type { AgentEntry, RecordingModeKey } from "./settings-data";
import { keyNameNotice, type ServiceSettingsContext } from "./settings-service";

const MODE_LABELS: Record<RecordingModeKey, string> = {
	dailyLog: "Daily log",
	cursor: "Cursor",
	meeting: "Meeting",
};

/**
 * Draw the fields of a service agent under the mode's agent picker. Called by
 * the settings page when the mode's agent kind is `service`.
 */
export function renderAgentFields(
	containerEl: HTMLElement,
	mode: RecordingModeKey,
	entry: AgentEntry,
	context: ServiceSettingsContext,
): void {
	const label = MODE_LABELS[mode];

	new Setting(containerEl)
		.setName(`${label} agent instruction`)
		.setDesc(
			"What you want done with the transcript, in your own words and language. Left empty, the agent gets the default shown here for this mode.",
		)
		.addTextArea((area) =>
			area
				.setPlaceholder(defaultInstructionFor(mode))
				.setValue(entry.instruction)
				.onChange(async (value) => {
					entry.instruction = value;
					await context.save();
				}),
		);

	new Setting(containerEl)
		.setName(`${label} agent context note`)
		.setDesc(
			"Optional. The path of a note in this vault whose text is sent with the instruction, for example to explain your workplace's abbreviations.",
		)
		.addText((text) =>
			text
				.setPlaceholder("Context/Workplace.md")
				.setValue(entry.contextNotePath)
				.onChange(async (value) => {
					entry.contextNotePath = value.trim();
					await context.save();
				}),
		);

	new Setting(containerEl)
		.setName(`${label} agent address`)
		.setDesc(
			"The service's API address, without the final '/chat/completions' — for example 'https://api.openai.com/v1', or 'http://127.0.0.1:11434/v1' for Ollama on the same machine. The transcript is sent there from the device that runs the agent.",
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
		.setName(`${label} agent key`)
		.setDesc(keyNameNotice(entry, context.keys));
	keySetting.addComponent((el) =>
		new SecretComponent(context.app, el).setValue(entry.keyName).onChange(async (value) => {
			entry.keyName = (value ?? "").trim();
			await context.save();
			keySetting.setDesc(keyNameNotice(entry, context.keys));
		}),
	);

	new Setting(containerEl)
		.setName(`${label} agent model`)
		.setDesc("The model name the service expects, for example 'gpt-4o-mini' or 'llama3.2'.")
		.addText((text) =>
			text.setValue(entry.modelName).onChange(async (value) => {
				entry.modelName = value.trim();
				await context.save();
			}),
		);
}
