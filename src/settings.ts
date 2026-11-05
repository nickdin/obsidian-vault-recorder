import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultRecorderPlugin from "./main";
import {
	RECORDING_MODE_KEYS,
	chooseAgentKind,
	type AgentKind,
	type RecordingModeKey,
	type TranscriberKind,
} from "./settings-data";
import { parseLanguageEntry } from "./language-entry";
import { formatTimestamp } from "./transcript-note";
import { createObsidianKeyStore } from "./key-store";
import { renderThisDevice } from "./device-settings";
import { renderAgentFields } from "./settings-agent";
import { renderSendsList } from "./settings-sends";
import { renderServiceFields } from "./settings-service";
import {
	renderModelChoice,
	renderModelsOnThisDevice,
	type ModelSettingsContext,
} from "./settings-models";

/**
 * The transcriber and agent kinds the picker offers. The settings types
 * already hold every kind, so a later ticket adds its kind to these two lists
 * and nothing else.
 */
const OFFERED_TRANSCRIBER_KINDS: Record<string, string> = {
	none: "None",
	"hand-off": "Hand-off (a program of yours)",
	service: "Service (an address, a key and a model)",
};
/** On-device serves the cursor and daily-log modes only. */
const ON_DEVICE_KIND: Record<string, string> = {
	"on-device": "On this device (a speech model kept in your vault)",
};
const OFFERED_AGENT_KINDS: Record<string, string> = {
	none: "None",
	"hand-off": "Hand-off (a program of yours)",
	service: "A service (an address, a key and a model)",
};

const MODE_LABELS: Record<RecordingModeKey, string> = {
	dailyLog: "Daily log",
	cursor: "Cursor",
	meeting: "Meeting",
};

export class VaultRecorderSettingTab extends PluginSettingTab {
	private readonly plugin: VaultRecorderPlugin;

	constructor(app: App, plugin: VaultRecorderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		// --- Section: notes ---
		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Notes heading")
			.setDesc(
				"The heading recordings will be linked under in a daily log or a meeting note: its text, and its level. Saved now, and used once recordings are linked under it; until then recordings keep going under the heading they always have.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Notes")
					.setValue(settings.notesHeading.text)
					.onChange(async (value) => {
						settings.notesHeading.text = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"1": "Level 1 (#)",
						"2": "Level 2 (##)",
						"3": "Level 3 (###)",
						"4": "Level 4 (####)",
						"5": "Level 5 (#####)",
						"6": "Level 6 (######)",
					})
					.setValue(String(settings.notesHeading.level))
					.onChange(async (value) => {
						settings.notesHeading.level = Number(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Participant list property")
			.setDesc(
				"The property in a meeting note that lists who took part, leaving you out. A hand-off transcriber is given the list as it stands when the recording stops.",
			)
			.addText((text) =>
				text
					.setPlaceholder("participants")
					.setValue(settings.participantsProperty)
					.onChange(async (value) => {
						settings.participantsProperty = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Your name")
			.setDesc("The name you are called in a meeting. Leave it empty if you do not want to give one. A hand-off transcriber is given it as typed here, without spaces at either end.")
			.addText((text) =>
				text.setValue(settings.ownerName).onChange(async (value) => {
					settings.ownerName = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		const languageSetting = new Setting(containerEl)
			.setName("Language spoken in recordings")
			.setDesc(
				"Type 'detect' to have it found automatically, a language code such as 'en' or 'sv', or a language's name such as 'Swedish' (it is saved as its code). A hand-off transcriber is told the code; 'detect' tells it nothing.",
			);
		// Beside the box, never silent: a value that is not understood is not saved, and this says so.
		const languageProblem = languageSetting.descEl.createDiv({ cls: "vault-recorder-picker-problem" });
		languageSetting.addText((text) =>
			text
				.setPlaceholder("detect")
				.setValue(settings.language)
				.onChange(async (value) => {
					const entry = parseLanguageEntry(value);
					languageProblem.setText(entry.ok ? "" : entry.reason);
					if (!entry.ok) return;
					settings.language = entry.value;
					await this.plugin.saveSettings();
				}),
		);

		// --- Section: daily log ---
		new Setting(containerEl).setName("Daily log").setHeading();

		new Setting(containerEl)
			.setName("Use the Daily notes settings")
			.setDesc(
				"Find today's daily log where the Daily notes plugin puts it. Turn this off to give a folder and filename pattern of your own.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.useDailyNotesSettings).onChange(async (value) => {
					settings.useDailyNotesSettings = value;
					await this.plugin.saveSettings();
					// The two fields below exist only while the switch is off.
					this.display();
				}),
			);

		if (!settings.useDailyNotesSettings) {
			new Setting(containerEl)
				.setName("Daily log folder")
				.setDesc(
					"The folder holding today's daily log, for example 'journal'. Leave it empty for the vault's top level.",
				)
				.addText((text) =>
					text
						.setPlaceholder("(Vault top level)")
						.setValue(settings.dailyLogFolder)
						.onChange(async (value) => {
							settings.dailyLogFolder = value.trim();
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Daily log filename pattern")
				.setDesc("Uses the tokens YYYY, MM and DD. For example: 'YYYY-MM-DD'.")
				.addText((text) =>
					text
						.setPlaceholder("YYYY-MM-DD")
						.setValue(settings.dailyLogFormat)
						.onChange(async (value) => {
							settings.dailyLogFormat = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		// --- Section: folders ---
		new Setting(containerEl).setName("Folders").setHeading();

		new Setting(containerEl)
			.setName("Audio file folder")
			.setDesc(
				"Leave this empty to use the vault's default attachment folder. Give a path, for example 'attachments/recordings', to send this plugin's recordings there instead.",
			)
			.addText((text) =>
				text
					.setPlaceholder("(Vault default)")
					.setValue(settings.audioFolder)
					.onChange(async (value) => {
						settings.audioFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Transcript folder")
			.setDesc("Leave this empty to keep transcripts in the same folder as the audio.")
			.addText((text) =>
				text
					.setPlaceholder("(Same as audio)")
					.setValue(settings.transcriptFolder)
					.onChange(async (value) => {
						settings.transcriptFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model folder")
			.setDesc("Where speech models are kept.")
			.addText((text) =>
				text
					.setPlaceholder("vault-recorder/models")
					.setValue(settings.modelFolder)
					.onChange(async (value) => {
						settings.modelFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// --- Section: keeping and waiting ---
		new Setting(containerEl).setName("Keeping and waiting").setHeading();

		const keepTime = new Setting(containerEl).setName("Keep time (days)");
		const keepTimeDesc =
			"How many days a recording's audio is kept once its transcript is finished; then it goes to the trash and the transcript stays. Leave it empty to never delete audio; 30 days is a good start. Turning it on or shortening it asks first, naming how many recordings lose their audio now.";
		keepTime.setDesc(keepTimeDesc);
		keepTime.addText((text) => {
			const shown = (): string =>
				settings.keepTimeDays === null ? "" : String(settings.keepTimeDays);
			text.setPlaceholder("30").setValue(shown());
			// The question is asked when the field is left or Enter is pressed, not on
			// every keystroke: typing "30" must not ask about "3". The setting is
			// assigned only after a yes, so a tick during the question never acts on
			// a value nobody confirmed.
			text.inputEl.addEventListener("change", () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					let days: number | null;
					if (trimmed === "") {
						days = null;
					} else if (/^\d+$/.test(trimmed)) {
						days = Number(trimmed);
					} else {
						keepTime.setDesc(`Not saved: type a whole number of days, or leave it empty. ${keepTimeDesc}`);
						return;
					}
					keepTime.setDesc(keepTimeDesc);
					if (days === settings.keepTimeDays) return;
					if (!(await this.plugin.confirmKeepTime(settings.keepTimeDays, days))) {
						text.setValue(shown());
						return;
					}
					settings.keepTimeDays = days;
					await this.plugin.saveSettings();
				})();
			});
		});

		const overdue = new Setting(containerEl).setName("Overdue time (hours)");
		const overdueDesc =
			"How long a recording may wait for its transcript before it is marked overdue. Saved now; nothing marks a recording overdue yet.";
		overdue.setDesc(overdueDesc);
		overdue.addText((text) =>
			text
				.setPlaceholder("24")
				.setValue(String(settings.overdueHours))
				.onChange(async (value) => {
					const hours = Number(value.trim());
					if (value.trim() === "" || !Number.isFinite(hours) || hours <= 0) {
						overdue.setDesc(`Not saved: type a number of hours above zero. ${overdueDesc}`);
						return;
					}
					settings.overdueHours = hours;
					overdue.setDesc(overdueDesc);
					await this.plugin.saveSettings();
				}),
		);

		// --- Section: transcription ---
		new Setting(containerEl).setName("Transcription").setHeading();

		containerEl.createEl("p", {
			text: "Each recording mode has its own transcriber, which turns a recording into text, and its own agent, which can act on that text. With a hand-off transcriber, each recording gets a note beside it in the transcript folder asking for a transcript, which a program of yours picks up and fills in; a hand-off agent works the same way once the transcript is done, and has no instruction box here because the program carries its own. The rule that program follows is in the plugin's docs. With 'None', recordings are saved as audio only.",
			cls: "setting-item-description",
		});

		// Drawn further down; an address typed above updates it in place, since a redraw would take the focus out of the field.
		let sendsList: { refresh: () => void } | null = null;
		const addressChanged = () => sendsList?.refresh();

		const modelCtx: ModelSettingsContext = {
			models: this.plugin.models,
			save: () => this.plugin.saveSettings(),
			redraw: () => this.display(),
		};
		for (const mode of RECORDING_MODE_KEYS) {
			new Setting(containerEl)
				.setName(`${MODE_LABELS[mode]} transcriber`)
				.addDropdown((dropdown) =>
					dropdown
						.addOptions(
							mode === "meeting"
								? OFFERED_TRANSCRIBER_KINDS
								: { ...OFFERED_TRANSCRIBER_KINDS, ...ON_DEVICE_KIND },
						)
						.setValue(settings.transcribers[mode].kind)
						.onChange(async (value) => {
							settings.transcribers[mode].kind = value as TranscriberKind;
							await this.plugin.saveSettings();
							// A kind's own fields exist only while it is chosen.
							this.display();
						}),
				);
			if (settings.transcribers[mode].kind === "service") {
				renderServiceFields(containerEl, mode, settings.transcribers[mode], {
					app: this.app,
					keys: createObsidianKeyStore(this.app),
					save: () => this.plugin.saveSettings(),
					redraw: () => this.display(),
					addressChanged,
				});
			}
			if (settings.transcribers[mode].kind === "on-device") {
				renderModelChoice(containerEl, modelCtx, MODE_LABELS[mode], settings.transcribers[mode]);
			}
			new Setting(containerEl)
				.setName(`${MODE_LABELS[mode]} agent`)
				.addDropdown((dropdown) =>
					dropdown
						.addOptions(OFFERED_AGENT_KINDS)
						.setValue(settings.agents[mode].kind)
						.onChange(async (value) => {
							const now = new Date();
							chooseAgentKind(
								settings.agents[mode],
								value as AgentKind,
								formatTimestamp(now, -now.getTimezoneOffset()),
							);
							await this.plugin.saveSettings();
							this.display();
						}),
				);
			if (settings.agents[mode].kind === "service") {
				renderAgentFields(containerEl, mode, settings.agents[mode], {
					app: this.app,
					keys: createObsidianKeyStore(this.app),
					save: () => this.plugin.saveSettings(),
					redraw: () => this.display(),
					addressChanged,
				});
			}
		}

		if (RECORDING_MODE_KEYS.some((mode) => settings.transcribers[mode].kind === "on-device")) {
			renderModelsOnThisDevice(containerEl, modelCtx);
		}

		// --- Section: this device ---
		renderThisDevice(containerEl, this.app);

		// --- Section: behaviour ---
		new Setting(containerEl).setName("Behaviour").setHeading();

		new Setting(containerEl)
			.setName("Keep the screen awake while recording")
			.setDesc(
				"Stops the screen going dark and the computer locking while a recording is in progress. Turn it off to save battery — the screen may then go dark, and the recording risks going silent.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.keepAwake).onChange(async (value) => {
					settings.keepAwake = value;
					await this.plugin.saveSettings();
				}),
			);

		// --- Section: troubleshooting ---
		new Setting(containerEl).setName("Troubleshooting").setHeading();

		const codecLabel = settings.codecMimeType
			? `${settings.codecExtension} (${settings.codecMimeType})`
			: "(not detected yet)";

		new Setting(containerEl)
			.setName("Current codec")
			.setDesc(
				"Chosen automatically when the plugin loads. Shown here for troubleshooting when recordings behave unexpectedly.",
			)
			.addText((text) => {
				text.setValue(codecLabel);
				text.inputEl.readOnly = true;
				text.inputEl.addClass("vault-recorder-readonly");
			});

		containerEl.createEl("p", {
			text: "What each chosen kind sends where, as you have set it now. A service send comes from the device that does the work, which may not be this one:",
			cls: "setting-item-description",
		});
		const sends = containerEl.createEl("ul", { cls: "setting-item-description" });
		sendsList = renderSendsList(sends, settings);
		containerEl.createEl("p", {
			text: "A key is read from this device's Keychain and sent only as the Authorization header to the address it belongs to; it is never written into the vault.",
			cls: "setting-item-description",
		});
	}
}
