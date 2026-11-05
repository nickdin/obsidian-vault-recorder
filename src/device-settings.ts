/**
 * The "This device" section of the settings page: this
 * device's name, and the switch that makes it the vault's serving device.
 * Both live in Obsidian's local storage for the vault — never in the settings
 * file, so Sync never carries them to another device.
 */

import { Platform, Setting, type App } from "obsidian";

import {
	readDeviceName,
	readServingDevice,
	writeDeviceName,
	writeServingDevice,
} from "./obsidian-ports";

export function renderThisDevice(containerEl: HTMLElement, app: App): void {
	new Setting(containerEl).setName("This device").setHeading();

	new Setting(containerEl)
		.setName("Device name")
		.setDesc(
			"The name this device writes into a transcript note when it takes the note on. Kept on this device only. Leave it empty to be called \"desktop\" or \"phone\".",
		)
		.addText((text) =>
			text
				.setPlaceholder(Platform.isPhone ? "phone" : "desktop")
				.setValue(readDeviceName(app))
				.onChange((value) => writeDeviceName(app, value)),
		);

	new Setting(containerEl)
		.setName("Serving device")
		.setDesc(
			"Turn this on for the one device in this vault that stays running. After three minutes it takes over any waiting recording whose transcriber is a service or on this device, using its own key or speech model. It never takes a hand-off request. Choose only one serving device per vault. Kept on this device only.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(readServingDevice(app))
				.onChange((value) => writeServingDevice(app, value)),
		);
}
