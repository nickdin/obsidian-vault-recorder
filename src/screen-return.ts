/**
 * When this device lets go of its own unanswered sends.
 *
 * `Lifecycle.returnedToScreen` does the letting go; this module says when it
 * runs: once the workspace is ready, which is the only moment a phone that
 * Obsidian was killed on gets (a cold start fires no visibility change), and
 * each time the window is shown again, which is when a phone that only
 * suspended Obsidian comes back. A send still under way in this run is not let
 * go of by the start-up release (`Lifecycle.returnedToScreen`); on return, a
 * phone lets go of a send begun before the window was hidden even while its
 * promise is pending, and a desktop leaves a send under way alone.
 */

import type { Lifecycle } from "./lifecycle";

/** The parts of Obsidian's window this module watches, so a test can stand in for them. */
export interface ScreenPort {
	isHidden(): boolean;
	/** Call `callback` each time the window is hidden or shown. */
	onVisibilityChange(callback: () => void): void;
	/** Call `callback` once the workspace layout is ready. */
	whenReady(callback: () => void): void;
}

export function releaseLostSends(lifecycle: Lifecycle, screen: ScreenPort, now: () => Date): void {
	const release = (): void => void lifecycle.returnedToScreen(now());
	screen.whenReady(release);
	screen.onVisibilityChange(() => {
		if (screen.isHidden()) lifecycle.leftTheScreen();
		else release();
	});
}
