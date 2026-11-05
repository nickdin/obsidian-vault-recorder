/**
 * Stand-ins for the serving-device tests: a device with a stable id of its
 * own, a service whose answer a test releases by hand, and two devices'
 * copies of one synced vault. They live beside the serving-device ticket, not
 * in `lifecycle-fakes.ts`.
 */

/* global setImmediate -- only the tests import this file, and they run in Node, which has it */

import type { DeviceRole } from "./lifecycle";
import { FakeDevice } from "./lifecycle-fakes";
import type { NetworkPort, NetworkRequest, NetworkResponse } from "./transcriber-service";

/** A device whose name can change while its id stays: what a rename does. */
export class IdentifiedDevice extends FakeDevice {
	constructor(
		name: string,
		role: DeviceRole,
		private readonly deviceId: string,
	) {
		super(name, role);
	}

	id(): string {
		return this.deviceId;
	}
}

/** A service that answers when the test says so; until then a send stays pending. */
export class HeldNetwork implements NetworkPort {
	readonly requests: NetworkRequest[] = [];
	private readonly waiting: Array<(response: NetworkResponse) => void> = [];

	async reach(): Promise<void> {}

	send(request: NetworkRequest): Promise<NetworkResponse> {
		this.requests.push(request);
		return new Promise((resolve) => this.waiting.push(resolve));
	}

	/** Answer every send still waiting with a transcript. */
	answerAll(text = "Spoken words."): void {
		for (const resolve of this.waiting.splice(0)) {
			resolve({ status: 200, text: JSON.stringify({ text }) });
		}
	}
}

/** Let every promise that can run, run: for a test to look at a send that is under way. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}
