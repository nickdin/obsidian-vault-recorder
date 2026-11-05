import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	WakeLockManager,
	WakeLockUnavailableError,
	resolvePowerSaveBlocker,
	type DocumentLike,
	type PowerSaveBlockerLike,
	type WakeLockApiLike,
	type WakeLockDeps,
	type WakeLockSentinelLike,
} from "./wake-lock.js";

interface FakeBlocker extends PowerSaveBlockerLike {
	startCalls: Array<"prevent-display-sleep" | "prevent-app-suspension">;
	stopCalls: number[];
	nextId: number;
}

function makeBlocker(): FakeBlocker {
	const blocker: FakeBlocker = {
		startCalls: [],
		stopCalls: [],
		nextId: 42,
		start(type) {
			blocker.startCalls.push(type);
			return blocker.nextId++;
		},
		stop(id) {
			blocker.stopCalls.push(id);
		},
	};
	return blocker;
}

interface FakeSentinel extends WakeLockSentinelLike {
	releaseCalls: number;
}

function makeSentinel(): FakeSentinel {
	const sentinel: FakeSentinel = {
		released: false,
		releaseCalls: 0,
		async release() {
			sentinel.releaseCalls += 1;
			sentinel.released = true;
		},
	};
	return sentinel;
}

interface FakeWakeLockApi extends WakeLockApiLike {
	requestCalls: Array<"screen">;
	nextSentinel: FakeSentinel | null;
	requestImpl?: () => Promise<WakeLockSentinelLike>;
}

function makeWakeLockApi(initial?: FakeSentinel): FakeWakeLockApi {
	const api: FakeWakeLockApi = {
		requestCalls: [],
		nextSentinel: initial ?? makeSentinel(),
		async request(type) {
			api.requestCalls.push(type);
			if (api.requestImpl) return api.requestImpl();
			if (!api.nextSentinel) throw new Error("no sentinel configured");
			return api.nextSentinel;
		},
	};
	return api;
}

function makeDocument(): DocumentLike & { listeners: Array<() => void> } {
	const doc = {
		visibilityState: "visible" as DocumentVisibilityState,
		listeners: [] as Array<() => void>,
		addEventListener(_type: "visibilitychange", listener: () => void) {
			doc.listeners.push(listener);
		},
		removeEventListener(_type: "visibilitychange", listener: () => void) {
			doc.listeners = doc.listeners.filter((l) => l !== listener);
		},
	};
	return doc;
}

function depsFor(
	platform: "desktop" | "mobile" | "unknown",
	overrides: Partial<WakeLockDeps> = {},
): WakeLockDeps {
	return {
		isDesktop: () => platform === "desktop",
		isMobile: () => platform === "mobile",
		getPowerSaveBlocker: () => null,
		getWakeLockApi: () => null,
		getDocument: () => null,
		...overrides,
	};
}

describe("WakeLockManager", () => {
	it("acquire respects keepAwake=false", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => false,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.acquire();
		assert.equal(blocker.startCalls.length, 0);
	});

	it("acquireDesktop calls powerSaveBlocker.start and stores the id", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.acquire();
		assert.deepEqual(blocker.startCalls, ["prevent-display-sleep"]);
	});

	it("acquireMobile calls wakeLock.request('screen')", async () => {
		const api = makeWakeLockApi();
		const doc = makeDocument();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("mobile", {
				getWakeLockApi: () => api,
				getDocument: () => doc,
			}),
		);
		await mgr.acquire();
		assert.deepEqual(api.requestCalls, ["screen"]);
	});

	it("release after acquireDesktop calls powerSaveBlocker.stop(id)", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.acquire();
		await mgr.release();
		assert.deepEqual(blocker.stopCalls, [42]);
	});

	it("release after acquireMobile calls sentinel.release", async () => {
		const sentinel = makeSentinel();
		const api = makeWakeLockApi(sentinel);
		const doc = makeDocument();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("mobile", {
				getWakeLockApi: () => api,
				getDocument: () => doc,
			}),
		);
		await mgr.acquire();
		await mgr.release();
		assert.equal(sentinel.releaseCalls, 1);
	});

	it("an acquire that throws does not swallow the error — it reaches the caller", async () => {
		// A design choice: the manager throws a typed error so main.ts can show a
		// notice. The caller (main.ts) is where the try/catch and the swallowing
		// live.
		const blocker = makeBlocker();
		blocker.start = () => {
			throw new Error("simulated electron failure");
		};
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await assert.rejects(
			() => mgr.acquire(),
			(err: unknown) => err instanceof WakeLockUnavailableError,
		);
	});

	it("acquire with no powerSaveBlocker available throws WakeLockUnavailableError", async () => {
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => null }),
		);
		await assert.rejects(
			() => mgr.acquire(),
			(err: unknown) => err instanceof WakeLockUnavailableError,
		);
	});

	it("a double acquire with no release is idempotent (one lock)", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.acquire();
		await mgr.acquire();
		assert.equal(blocker.startCalls.length, 1);
	});

	it("release with no preceding acquire is a no-op", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.release(); // must not throw
		assert.equal(blocker.stopCalls.length, 0);
	});

	it("a double release does not throw and calls stop only once", async () => {
		const blocker = makeBlocker();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("desktop", { getPowerSaveBlocker: () => blocker }),
		);
		await mgr.acquire();
		await mgr.release();
		await mgr.release();
		assert.equal(blocker.stopCalls.length, 1);
	});

	it("acquire on an unknown platform is a no-op (it does not throw)", async () => {
		const mgr = new WakeLockManager(() => true, depsFor("unknown"));
		await mgr.acquire(); // must not throw
	});

	it("mobile: visibilitychange to 'visible' re-acquires after the sentinel was released", async () => {
		const sentinel = makeSentinel();
		const api = makeWakeLockApi(sentinel);
		const doc = makeDocument();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("mobile", {
				getWakeLockApi: () => api,
				getDocument: () => doc,
			}),
		);
		await mgr.acquire();
		assert.equal(api.requestCalls.length, 1);

		// Simulate the platform releasing the lock (the document went hidden).
		sentinel.released = true;

		// The document becomes visible again; a new sentinel should be taken.
		const sentinel2 = makeSentinel();
		api.nextSentinel = sentinel2;
		doc.visibilityState = "visible";
		for (const listener of doc.listeners) listener();
		// A microtask, to let the async handler run.
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(api.requestCalls.length, 2);
	});

	it("release removes the visibilitychange listener", async () => {
		const sentinel = makeSentinel();
		const api = makeWakeLockApi(sentinel);
		const doc = makeDocument();
		const mgr = new WakeLockManager(
			() => true,
			depsFor("mobile", {
				getWakeLockApi: () => api,
				getDocument: () => doc,
			}),
		);
		await mgr.acquire();
		assert.equal(doc.listeners.length, 1);
		await mgr.release();
		assert.equal(doc.listeners.length, 0);
	});
});

describe("resolvePowerSaveBlocker", () => {
	it("returns null when there is no window at all", () => {
		assert.equal(resolvePowerSaveBlocker(null), null);
	});

	it("returns null when neither electron.remote nor require is present", () => {
		assert.equal(resolvePowerSaveBlocker({}), null);
	});

	it("picks it up from window.electron.remote.powerSaveBlocker when available", () => {
		const blocker = makeBlocker();
		const win = { electron: { remote: { powerSaveBlocker: blocker } } };
		assert.equal(resolvePowerSaveBlocker(win), blocker);
	});

	it("falls back to require('electron') when the direct path is missing", () => {
		const blocker = makeBlocker();
		const win = {
			require: (mod: string) =>
				mod === "electron"
					? { remote: { powerSaveBlocker: blocker } }
					: undefined,
		};
		assert.equal(resolvePowerSaveBlocker(win), blocker);
	});

	it("returns null when require throws", () => {
		const win = {
			require: () => {
				throw new Error("nope");
			},
		};
		assert.equal(resolvePowerSaveBlocker(win), null);
	});
});
