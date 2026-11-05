/**
 * The settings page's Troubleshooting lines: what each chosen transcriber and
 * agent kind sends where, in words, for the mode as set now.
 */

import {
	RECORDING_MODE_KEYS,
	type AgentKind,
	type RecordingModeKey,
	type TranscriberKind,
	type VaultRecorderSettings,
} from "./settings-data";

const MODE_LABELS: Record<RecordingModeKey, string> = {
	dailyLog: "Daily log",
	cursor: "Cursor",
	meeting: "Meeting",
};

/** The address as the person typed it, or a plain sign that none is set yet. */
function addressOrMissing(address: string): string {
	const trimmed = address.trim().replace(/\/+$/, "");
	return trimmed === "" ? "(no address set yet)" : trimmed;
}

/** What a transcriber of this kind sends where, in the words the troubleshooting section shows. */
export function describeTranscriberSends(entry: { kind: TranscriberKind; address: string }): string {
	switch (entry.kind) {
		case "none":
			return "nothing is sent; the recording is kept as audio only.";
		case "hand-off":
			return "nothing is sent from this device; a note asking for a transcript is written in your transcript folder when one is set, otherwise beside the recording, and your program reads it there. Obsidian Sync carries that note to your other devices, and the audio too unless it is over Sync's file limit (5 MB on Standard; see Sizes and limits in the README).";
		case "service":
			return `the recording itself is sent to ${addressOrMissing(entry.address)}/audio/transcriptions, with the model name and, when you set one, the language.`;
		case "on-device":
			return "nothing is sent; the speech model runs on this device. Model files are fetched from huggingface.co only when you press a download button.";
	}
}

/** What an agent of this kind sends where, in the words the troubleshooting section shows. */
export function describeAgentSends(entry: { kind: AgentKind; address: string }): string {
	switch (entry.kind) {
		case "none":
			return "no agent; nothing is sent.";
		case "hand-off":
			return "nothing is sent from this device; the transcript note is asked for an answer, and your program writes it there.";
		case "service":
			return `the transcript, the note that links the recording and, when you set one, your context note are sent to ${addressOrMissing(entry.address)}/chat/completions, with the model name and your instruction.`;
	}
}

/** The part of a list element the lines need; Obsidian's `HTMLElement` has both. */
export interface SendsListElement {
	createEl(tag: "li", options: { text: string }): { setText(text: string): void };
}

/** Every Troubleshooting line's text, in the order the page shows them. */
export function sendsLines(settings: Pick<VaultRecorderSettings, "transcribers" | "agents">): string[] {
	const lines: string[] = [];
	for (const mode of RECORDING_MODE_KEYS) {
		lines.push(`${MODE_LABELS[mode]} transcriber: ${describeTranscriberSends(settings.transcribers[mode])}`);
		lines.push(`${MODE_LABELS[mode]} agent: ${describeAgentSends(settings.agents[mode])}`);
	}
	return lines;
}

/**
 * Draw the lines into `list` and return a function that brings them up to
 * date with `settings` without drawing the page again.
 */
export function renderSendsList(
	list: SendsListElement,
	settings: Pick<VaultRecorderSettings, "transcribers" | "agents">,
): { refresh: () => void } {
	const items = sendsLines(settings).map((text) => list.createEl("li", { text }));
	return {
		refresh: () => {
			sendsLines(settings).forEach((text, index) => items[index].setText(text));
		},
	};
}
