/**
 * The on-device model, on the settings page: the model list with a download
 * button, and the models on this device with a remove button. Thin views over
 * `model-store.ts`, plus the real ports it is handed.
 *
 * Imports `obsidian`, so Node cannot load it; every rule it shows lives in
 * `model-store.ts` and is tested there.
 */

import { Notice, Setting, requestUrl, requireApiVersion, type App, type ButtonComponent } from "obsidian";

import { MODEL_LIST, formatSize, totalBytes, type ModelEntry } from "./model-list";
import {
	ModelStore,
	downloadButtonLabel,
	type ModelDownloadPort,
	type ModelFolderPort,
	type ModelTrashPort,
} from "./model-store";
import type { TranscriberEntry } from "./settings-data";

// --- The real ports -------------------------------------------------------------

/**
 * The model folder through Obsidian's adapter, which reads the file system
 * itself: `stat` sees a file Sync has half written, or one placed by hand a
 * moment ago, which the vault's index may not know yet.
 */
export function createModelFolderPort(app: App): ModelFolderPort {
	const { adapter } = app.vault;
	return {
		async fileSize(path) {
			const stat = await adapter.stat(path);
			return stat !== null && stat.type === "file" ? stat.size : null;
		},
		async createFolder(path) {
			let built = "";
			for (const part of path.split("/").filter((segment) => segment !== "")) {
				built = built === "" ? part : `${built}/${part}`;
				if (!(await adapter.exists(built))) await adapter.mkdir(built);
			}
		},
		async writeBinary(path, data) {
			await adapter.writeBinary(path, data);
		},
		async appendBinary(path, data) {
			// The adapter's own append arrived in Obsidian 1.12.3, above this
			// plugin's minAppVersion. Before it, the file is read back and written
			// whole with the new bytes on the end. That rewrites the part file once
			// per chunk — for the largest listed file, 159 MB in 16 MB chunks, about
			// ten rewrites — which costs time on the download but no correctness.
			if (requireApiVersion("1.12.3")) {
				await adapter.appendBinary(path, data);
				return;
			}
			const before = await adapter.readBinary(path);
			const joined = new Uint8Array(before.byteLength + data.byteLength);
			joined.set(new Uint8Array(before), 0);
			joined.set(new Uint8Array(data), before.byteLength);
			await adapter.writeBinary(path, joined.buffer);
		},
		async rename(from, to) {
			await adapter.rename(from, to);
		},
		async remove(path) {
			if (await adapter.exists(path)) await adapter.remove(path);
		},
	};
}

/**
 * A byte range of a file through Obsidian's own `requestUrl`, which reaches
 * the address the way Obsidian does on every platform. A server that ignores
 * the range and answers 200 with the whole file is handled by cutting the
 * range out of it; one that answers anything else is an error naming the status.
 */
export function createModelDownloadPort(): ModelDownloadPort {
	return {
		async fetchRange(url, start, end) {
			const response = await requestUrl({
				url,
				headers: { Range: `bytes=${start}-${end}` },
				throw: false,
			});
			if (response.status === 206) return response.arrayBuffer;
			if (response.status === 200) return response.arrayBuffer.slice(start, end + 1);
			throw new Error(`${url} answered ${response.status}`);
		},
	};
}

/** The store, over the real ports. `trash` is the lifecycle's own, so removal follows Obsidian's trash setting. */
export function createModelStore(
	app: App,
	trash: ModelTrashPort,
	modelFolder: () => string,
): ModelStore {
	return new ModelStore({
		modelFolder,
		folder: createModelFolderPort(app),
		trash,
		download: createModelDownloadPort(),
	});
}

// --- The views ------------------------------------------------------------------

export interface ModelSettingsContext {
	models: ModelStore;
	/** Save the settings file. */
	save: () => Promise<void>;
	/** Draw the settings page again. */
	redraw: () => void;
}

function languageNote(model: ModelEntry): string {
	return model.language === "sv" ? "Swedish" : "other languages";
}

function optionLabel(model: ModelEntry): string {
	const recommended = model.recommended ? ", recommended" : "";
	return `${model.name} (${languageNote(model)}${recommended}, ${formatSize(totalBytes(model))})`;
}

/**
 * The model list for one mode whose transcriber is on-device: a choice among
 * the four models, and under it the chosen model's row with its download
 * button. Changing the choice keeps the old model on disk until it is removed.
 */
export function renderModelChoice(
	containerEl: HTMLElement,
	ctx: ModelSettingsContext,
	modeLabel: string,
	entry: TranscriberEntry,
): void {
	new Setting(containerEl)
		.setName(`${modeLabel} speech model`)
		.setDesc(
			"Fetched once from huggingface.co, the one outside address the model download uses (a service transcriber's address is your own), and kept in your vault. Swedish models are for Swedish only; the others take any language.",
		)
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Choose a model");
			for (const model of MODEL_LIST) dropdown.addOption(model.id, optionLabel(model));
			dropdown.setValue(MODEL_LIST.some((model) => model.id === entry.modelId) ? entry.modelId : "");
			dropdown.onChange(async (value) => {
				entry.modelId = value;
				await ctx.save();
				ctx.redraw();
			});
		});

	const chosen = MODEL_LIST.find((model) => model.id === entry.modelId);
	if (chosen) renderModelRow(containerEl, ctx, chosen, false);
}

/**
 * Every model that is on this device, each with a remove button. A model that
 * is only partly there shows too, so a stray half download can be cleared.
 */
export function renderModelsOnThisDevice(containerEl: HTMLElement, ctx: ModelSettingsContext): void {
	new Setting(containerEl).setName("Models on this device").setHeading();
	const holder = containerEl.createDiv();
	void (async () => {
		let shown = 0;
		for (const model of MODEL_LIST) {
			const status = await ctx.models.status(model);
			if (status.present || status.missing.length < model.files.length) {
				renderModelRow(holder, ctx, model, true);
				shown++;
			}
		}
		if (shown === 0) {
			holder.createEl("p", {
				text: "No speech model is on this device.",
				cls: "setting-item-description",
			});
		}
	})();
}

/**
 * One model: what it is, whether it is on this device, and one button — Remove
 * when it is (`withRemove`) or Download with its size when it is not.
 */
function renderModelRow(
	containerEl: HTMLElement,
	ctx: ModelSettingsContext,
	model: ModelEntry,
	withRemove: boolean,
): void {
	const { models } = ctx;
	const setting = new Setting(containerEl).setName(model.name);
	let button: ButtonComponent | undefined;
	// What a press of the button does now; set by `update`, run by the one click handler.
	let onPress: (() => Promise<void>) | null = null;
	setting.addButton((created) => {
		button = created;
		created.setButtonText("Checking…").setDisabled(true);
		created.onClick(() => void onPress?.());
	});
	const detail = `${languageNote(model)}; from huggingface.co/${model.repo}, version ${model.revision.slice(0, 10)}`;
	setting.setDesc(detail);

	const watchProgress = (): void => {
		const stop = models.onProgress(model.id, (progress) => {
			if (!button?.buttonEl.isConnected) return stop();
			if (progress === null) return stop();
			const percent = Math.floor((progress.doneBytes / progress.totalBytes) * 100);
			button.setButtonText(`Downloading… ${percent}%`);
		});
	};

	const update = async (): Promise<void> => {
		if (!button) return;
		if (models.progressOf(model.id) !== null) {
			button.setButtonText("Downloading…").setDisabled(true);
			watchProgress();
			return;
		}
		const status = await models.status(model);
		const folder = models.folderOf(model);
		button.setDisabled(false);
		button.buttonEl.toggleClass("mod-warning", withRemove);
		button.buttonEl.toggleClass("mod-cta", !withRemove && !status.present);
		onPress = withRemove ? remove : status.present ? null : download;
		if (status.present) {
			setting.setDesc(`On this device, in ${folder}. ${detail}.`);
			if (withRemove) {
				button.setButtonText("Remove");
			} else {
				button.setButtonText("On this device").setDisabled(true);
			}
		} else {
			const partial =
				status.missing.length < model.files.length
					? ` ${model.files.length - status.missing.length} of ${model.files.length} files are there; a model counts only when all are, at their full size.`
					: "";
			setting.setDesc(`Not on this device.${partial} ${detail}.`);
			if (withRemove) {
				button.setButtonText("Remove");
			} else {
				button.setButtonText(downloadButtonLabel(model));
			}
		}
	};

	const download = async (): Promise<void> => {
		if (!button) return;
		button.setButtonText("Downloading… 0%").setDisabled(true);
		watchProgress();
		try {
			await models.download(model);
			new Notice(`${model.name} downloaded`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(message, 20000);
			setting.setDesc(message);
			button.setButtonText(downloadButtonLabel(model)).setDisabled(false);
			return;
		}
		// The page draws again, so the list of models on this device gains this one too.
		ctx.redraw();
	};

	const remove = async (): Promise<void> => {
		try {
			await models.remove(model);
			new Notice(`${model.name} removed`);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error), 20000);
		}
		ctx.redraw();
	};

	void update();
}
