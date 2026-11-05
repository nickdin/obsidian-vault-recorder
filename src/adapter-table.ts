/**
 * The lifecycle's table of transcriber and agent adapters as the plugin runs
 * it: `none` and `hand-off` from `defaultAdapters()`, plus the two kinds that
 * need ports of their own — `service` (a network call and the Keychain) and
 * `on-device` (the model folder and the model runner). `main.ts` builds the
 * ports and calls this; the tests call it with fakes, so the table the plugin
 * registers is the one they drive.
 */

import { withServiceAgent, type NoteReaderPort } from "./agent-service";
import { defaultAdapters, type Adapters } from "./lifecycle";
import { createOnDeviceTranscriber, type ModelPresence, type OnDevicePorts } from "./transcriber-on-device";
import { withServiceAdapter, type ServiceAdapterPorts } from "./transcriber-service";

export function pluginAdapters(
	service: ServiceAdapterPorts,
	models: ModelPresence,
	runner: OnDevicePorts["runner"],
	notes: NoteReaderPort,
): Adapters {
	const withService = withServiceAdapter(defaultAdapters(), service);
	// The service agent reads the linking note through `notes`. The port is
	// required: a table without it would have no service agent, and a mode set
	// to one would never run with nothing said.
	const withAgent = withServiceAgent(withService, { ...service, notes });
	return {
		...withAgent,
		transcribers: {
			...withAgent.transcribers,
			// The same vault, clock, device and audio as the service adapter: one
			// note, written the same way whichever kind transcribes it.
			"on-device": createOnDeviceTranscriber(models, {
				vault: service.vault,
				clock: service.clock,
				device: service.device,
				audio: service.audio,
				runner,
			}),
		},
	};
}
