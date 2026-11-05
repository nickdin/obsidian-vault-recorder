/**
 * Platform-specific wake-lock wrapper.
 *
 * It is meant to keep the system out of screen-off and sleep while a recording
 * is in progress, so the MediaRecorder stream does not silently go quiet when
 * the screen locks.
 *
 * **The failure it was built for was observed on Windows** — two lost meetings
 * — and the Swedish this replaced said so. Do not read it as platform-general:
 * on Debian the desktop branch below reports success while inhibiting nothing
 * at all, measured 2026-08-19. Only the mobile branch has been watched holding
 * a screen awake; see `acquireMobile`.
 *
 * - Desktop: Electron's `powerSaveBlocker.start("prevent-display-sleep")`,
 *   reached through `(window as any).electron?.remote?.powerSaveBlocker` and
 *   falling back to
 *   `(window as any).require?.("electron")?.remote?.powerSaveBlocker`.
 * - Mobile: the Web Wake Lock API, `navigator.wakeLock.request("screen")`.
 *   The platform may release the lock on its own when the document becomes
 *   hidden; a `visibilitychange` listener tries to re-acquire it when the
 *   document becomes visible again.
 *
 * The class is built for dependency injection so the tests never have to
 * mutate a global object — production uses defaults that read from window,
 * navigator and document.
 */

/** The slice of Electron Remote this needs. Written narrowly to avoid @types/electron. */
export interface PowerSaveBlockerLike {
	start(type: "prevent-display-sleep" | "prevent-app-suspension"): number;
	stop(id: number): void;
}

/** The minimal surface of the Web Wake Lock API. */
export interface WakeLockSentinelLike {
	released: boolean;
	release(): Promise<void>;
	addEventListener?: (
		type: "release",
		listener: () => void,
	) => void;
}

export interface WakeLockApiLike {
	request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/** The minimal surface of `document` needed for the visibility listener. */
export interface DocumentLike {
	/** "visible" or "hidden", as `document.visibilityState` gives it. */
	visibilityState: string;
	addEventListener: (
		type: "visibilitychange",
		listener: () => void,
	) => void;
	removeEventListener: (
		type: "visibilitychange",
		listener: () => void,
	) => void;
}

/**
 * The injectable dependencies. Production uses defaults from `obsidian` plus
 * window, navigator and document; the tests inject fakes.
 */
export interface WakeLockDeps {
	isDesktop: () => boolean;
	isMobile: () => boolean;
	getPowerSaveBlocker: () => PowerSaveBlockerLike | null;
	getWakeLockApi: () => WakeLockApiLike | null;
	getDocument: () => DocumentLike | null;
}

/**
 * Thrown by `acquire()` when the platform is there but the API could not be
 * located, or the request itself threw. `main.ts` catches it and shows a
 * notice — a failed wake lock never stops the recording.
 */
export class WakeLockUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WakeLockUnavailableError";
	}
}

/**
 * Locate Electron's `powerSaveBlocker` through the two known exposures.
 * Pure and testable — every input arrives as a parameter.
 */
export function resolvePowerSaveBlocker(
	win: unknown,
): PowerSaveBlockerLike | null {
	const w = win as {
		electron?: { remote?: { powerSaveBlocker?: PowerSaveBlockerLike } };
		require?: (mod: string) => unknown;
	} | null;
	if (!w) return null;

	const direct = w.electron?.remote?.powerSaveBlocker;
	if (direct && typeof direct.start === "function") return direct;

	try {
		const electron = w.require?.("electron") as
			| { remote?: { powerSaveBlocker?: PowerSaveBlockerLike } }
			| undefined;
		const viaRequire = electron?.remote?.powerSaveBlocker;
		if (viaRequire && typeof viaRequire.start === "function") {
			return viaRequire;
		}
	} catch {
		// require is missing or threw — ignore it, the null branch below is
		// already the answer.
	}
	return null;
}

/**
 * Build the production defaults for the web-API branches (powerSaveBlocker
 * through window, navigator.wakeLock, document). Platform detection is
 * injected separately so `wake-lock.ts` never has to import from `obsidian`,
 * which would break the Node unit tests — the `obsidian` package is types only.
 */
export function browserWakeLockDeps(): Omit<WakeLockDeps, "isDesktop" | "isMobile"> {
	return {
		getPowerSaveBlocker: () =>
			typeof window !== "undefined"
				? resolvePowerSaveBlocker(window)
				: null,
		getWakeLockApi: () => {
			if (typeof navigator === "undefined") return null;
			const api = (navigator as unknown as { wakeLock?: WakeLockApiLike })
				.wakeLock;
			return api && typeof api.request === "function" ? api : null;
		},
		getDocument: () =>
			typeof document !== "undefined"
				? document
				: null,
	};
}

/**
 * The wake-lock lifecycle for a recording in progress. It handles both desktop
 * (Electron `powerSaveBlocker`) and mobile (the Web Wake Lock API) behind one
 * `acquire`/`release` API.
 *
 * Both methods are idempotent — a double acquire still takes one lock, and a
 * release with no preceding acquire is a no-op.
 */
export class WakeLockManager {
	private readonly isEnabled: () => boolean;
	private readonly deps: WakeLockDeps;

	private desiredActive = false;
	private desktopId: number | null = null;
	private desktopBlocker: PowerSaveBlockerLike | null = null;
	private mobileSentinel: WakeLockSentinelLike | null = null;
	private mobileApi: WakeLockApiLike | null = null;
	private visibilityHandler: (() => void) | null = null;
	private boundDocument: DocumentLike | null = null;

	constructor(isEnabled: () => boolean, deps?: Partial<WakeLockDeps>) {
		this.isEnabled = isEnabled;
		// Defaults: platform detection is false unless main.ts supplies it from
		// Obsidian's `Platform.isDesktopApp`/`isMobileApp`; the browser APIs are
		// read lazily from window, navigator and document.
		const base: WakeLockDeps = {
			isDesktop: () => false,
			isMobile: () => false,
			...browserWakeLockDeps(),
		};
		this.deps = { ...base, ...deps };
	}

	/**
	 * Try to take a wake lock if `isEnabled()` returns true. Idempotent: if a
	 * lock is already active this does nothing. Throws
	 * `WakeLockUnavailableError` when the platform is there but the API could
	 * not be used — the caller is expected to catch that and show a notice.
	 */
	async acquire(): Promise<void> {
		if (!this.isEnabled()) return;
		if (this.desiredActive) return; // idempotent

		this.desiredActive = true;

		if (this.deps.isDesktop()) {
			await this.acquireDesktop();
			return;
		}
		if (this.deps.isMobile()) {
			await this.acquireMobile();
			return;
		}
		// An unknown platform — give up quietly, no exception. There is nothing
		// to report: no lock was possible in the first place.
		this.desiredActive = false;
	}

	/**
	 * Release the active wake lock and drop the visibility listener.
	 * Idempotent — calling it without a preceding `acquire` is harmless.
	 */
	async release(): Promise<void> {
		this.desiredActive = false;
		this.unbindVisibility();

		if (this.desktopBlocker !== null && this.desktopId !== null) {
			try {
				this.desktopBlocker.stop(this.desktopId);
			} catch {
				// Best effort — if Electron has already dropped the id, carry on.
			}
			this.desktopBlocker = null;
			this.desktopId = null;
		}

		if (this.mobileSentinel) {
			try {
				if (!this.mobileSentinel.released) {
					await this.mobileSentinel.release();
				}
			} catch {
				// Best effort — the platform may already have released the
				// sentinel.
			}
			this.mobileSentinel = null;
		}
	}

	private async acquireDesktop(): Promise<void> {
		const blocker = this.deps.getPowerSaveBlocker();
		if (!blocker) {
			this.desiredActive = false;
			throw new WakeLockUnavailableError(
				"powerSaveBlocker could not be located",
			);
		}
		try {
			const id = blocker.start("prevent-display-sleep");
			this.desktopBlocker = blocker;
			this.desktopId = id;
		} catch (err) {
			this.desiredActive = false;
			throw new WakeLockUnavailableError(
				`powerSaveBlocker.start threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/**
	 * Verified live on 2026-08-19: this branch does hold a lock on a real
	 * phone. A 57-second recording ran with the screen staying lit past the
	 * point it would otherwise have locked, observed by the user. Before
	 * that the branch had unit tests against an injected API and nothing
	 * else, which is not the same thing — the desktop branch had exactly
	 * that status and turned out to report success while inhibiting nothing
	 * at all.
	 *
	 * So keep the reason it was worth testing: `wakeLock.request("screen")`
	 * resolving proves the call was accepted, not that the screen stayed on,
	 * the same way `powerSaveBlocker.start()` returning an id proved nothing
	 * on desktop. If this branch ever has to be re-verified, re-verify it by
	 * watching a screen.
	 */
	private async acquireMobile(): Promise<void> {
		const api = this.deps.getWakeLockApi();
		if (!api) {
			this.desiredActive = false;
			throw new WakeLockUnavailableError(
				"navigator.wakeLock is missing on this platform",
			);
		}
		this.mobileApi = api;
		try {
			const sentinel = await api.request("screen");
			this.mobileSentinel = sentinel;
			this.bindVisibility();
		} catch (err) {
			this.desiredActive = false;
			throw new WakeLockUnavailableError(
				`wakeLock.request threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private bindVisibility(): void {
		if (this.visibilityHandler) return;
		const doc = this.deps.getDocument();
		if (!doc) return;
		this.boundDocument = doc;
		const handler = (): void => {
			void this.handleVisibilityChange();
		};
		this.visibilityHandler = handler;
		doc.addEventListener("visibilitychange", handler);
	}

	private unbindVisibility(): void {
		if (this.visibilityHandler && this.boundDocument) {
			this.boundDocument.removeEventListener(
				"visibilitychange",
				this.visibilityHandler,
			);
		}
		this.visibilityHandler = null;
		this.boundDocument = null;
	}

	/**
	 * A mobile quirk: the platform releases the lock by itself when the
	 * document becomes hidden. When it becomes visible again and a lock is
	 * still wanted, try to take a new one.
	 */
	private async handleVisibilityChange(): Promise<void> {
		if (!this.desiredActive) return;
		const doc = this.boundDocument;
		if (!doc || doc.visibilityState !== "visible") return;
		if (!this.mobileApi) return;
		if (this.mobileSentinel && !this.mobileSentinel.released) return;

		try {
			const sentinel = await this.mobileApi.request("screen");
			this.mobileSentinel = sentinel;
		} catch {
			// Silent. The user already got a notice at the first attempt if
			// that one failed, and nothing is logged here either: a
			// spontaneous re-acquire that does not go through is normal API
			// behaviour.
		}
	}
}
