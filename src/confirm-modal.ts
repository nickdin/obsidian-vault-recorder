/**
 * A yes/no question in Obsidian's own dialog. Plumbing only: the wording is
 * chosen by the caller (`lifecycle-actions.ts`), and the answer comes back as a
 * promise so the rules stay testable with a plain function in its place.
 */

import { Modal, type App } from "obsidian";

/** Ask `question`; resolves `true` on "Yes", `false` on "No" or when the dialog is closed. */
export function confirmInModal(app: App, question: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new Modal(app);
		const answer = (value: boolean): void => {
			answered = true;
			resolve(value);
			modal.close();
		};
		modal.contentEl.createEl("p", { text: question });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Yes", cls: "mod-cta" }).addEventListener("click", () => answer(true));
		buttons.createEl("button", { text: "No" }).addEventListener("click", () => answer(false));
		modal.onClose = () => {
			if (!answered) resolve(false);
		};
		modal.open();
	});
}
