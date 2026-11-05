/**
 * The service transcriber's ports, built from Obsidian. Plumbing only: every
 * rule lives in `transcriber-service.ts`, which is tested without Obsidian.
 */

import { TFile, requestUrl, type App } from "obsidian";

import type { NoteReaderPort } from "./agent-service";
import type { AudioPort, NetworkPort, ServiceAdapterPorts } from "./transcriber-service";
import { createObsidianKeyStore } from "./key-store";
import type { LifecyclePorts } from "./lifecycle";
import { withTimeout } from "./with-timeout";

/**
 * How long one send may take, upload and transcription together. A long
 * recording on a slow service can take many minutes; a connection that has
 * given no answer after this is treated as one nobody answers at.
 */
/** How long the "does anybody answer?" question waits. */
const REACH_TIMEOUT_MS = 15 * 1000;

const SEND_TIMEOUT_MS = 30 * 60 * 1000;

/** The send, on Obsidian's `requestUrl`, which sees error statuses as answers and a lost connection as a throw. */
export function createRequestUrlNetworkPort(): NetworkPort {
	return {
		async reach(url) {
			// Any status is an answer; only a lost connection (or silence) throws.
			await withTimeout(requestUrl({ url, method: "GET", throw: false }), REACH_TIMEOUT_MS, "the address");
		},
		async send(request) {
			const { "Content-Type": contentType, ...headers } = request.headers;
			const response = await withTimeout(
				requestUrl({
					url: request.url,
					method: request.method,
					headers,
					contentType,
					body: request.body,
					throw: false,
				}),
				SEND_TIMEOUT_MS,
				"the transcription request",
			);
			return { status: response.status, text: response.text };
		},
	};
}

/** The recording a transcript note names, resolved the way Obsidian resolves a link written in that note. */
export function createVaultAudioPort(app: App): AudioPort {
	return {
		async read(link, fromPath) {
			const file = app.metadataCache.getFirstLinkpathDest(link, fromPath);
			return file instanceof TFile ? app.vault.readBinary(file) : null;
		},
	};
}

/** The note a link names, resolved the way Obsidian resolves a link written in the note at `fromPath`. */
export function createVaultNoteReader(app: App): NoteReaderPort {
	return {
		async read(link, fromPath) {
			const file = app.metadataCache.getFirstLinkpathDest(link, fromPath);
			return file instanceof TFile ? app.vault.cachedRead(file) : null;
		},
	};
}

/** Everything the service adapter needs, given the lifecycle's own ports. */
export function createServiceAdapterPorts(
	app: App,
	lifecyclePorts: Pick<LifecyclePorts, "vault" | "clock" | "device">,
): ServiceAdapterPorts {
	return {
		vault: lifecyclePorts.vault,
		clock: lifecyclePorts.clock,
		device: lifecyclePorts.device,
		network: createRequestUrlNetworkPort(),
		keys: createObsidianKeyStore(app),
		audio: createVaultAudioPort(app),
	};
}
