/**
 * The naming list: a short list opened by a click on a speaker's
 * label. The owner first, then the participants not yet used, then the names
 * already in the note, then a box for any name. A dialog, not a menu: it has an
 * input, and it works the same with a finger as with a mouse.
 *
 * The order and the words written are `naming.ts`'s, tested without Obsidian;
 * this file only shows them and hands back the choice.
 */

import { Modal, type App } from "obsidian";

import { typedName, type SpeakerChoice } from "./naming";

const GROUP_TITLES: Record<SpeakerChoice["group"], string> = {
	owner: "You",
	participant: "Participants",
	other: "Already in this note",
};

export interface PickerRequest {
	/** What the label looks like in the note, for the title. */
	label: string;
	choices: SpeakerChoice[];
}

/**
 * Show the list; resolves to what is to be written in place of the label, or
 * `null` when the dialog is closed without a choice.
 */
export function pickSpeaker(app: App, request: PickerRequest): Promise<string | null> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new Modal(app);
		const answer = (written: string | null): void => {
			answered = true;
			resolve(written);
			modal.close();
		};
		modal.titleEl.setText(`Who is ${request.label}?`);
		const list = modal.contentEl.createDiv({ cls: "vault-recorder-picker" });

		let group: SpeakerChoice["group"] | null = null;
		for (const choice of request.choices) {
			if (choice.group !== group) {
				group = choice.group;
				list.createDiv({ cls: "vault-recorder-picker-group", text: GROUP_TITLES[group] });
			}
			const row = list.createEl("button", {
				cls: "vault-recorder-picker-choice",
				text: choice.display,
			});
			row.dataset.written = choice.written;
			row.addEventListener("click", () => answer(choice.written));
		}

		list.createDiv({ cls: "vault-recorder-picker-group", text: "Any other name" });
		const form = list.createDiv({ cls: "vault-recorder-picker-form" });
		const input = form.createEl("input", {
			cls: "vault-recorder-picker-box",
			attr: { type: "text", placeholder: "Type a name" },
		});
		const use = form.createEl("button", { cls: "mod-cta", text: "Use this name" });
		const problem = list.createDiv({ cls: "vault-recorder-picker-problem" });
		const submit = (): void => {
			const typed = typedName(input.value);
			if (typed.ok) answer(typed.written);
			else problem.setText(typed.reason);
		};
		use.addEventListener("click", submit);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				submit();
			}
		});

		modal.onClose = () => {
			if (!answered) resolve(null);
		};
		modal.open();
	});
}
