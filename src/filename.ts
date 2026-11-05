/**
 * Generate a filename in the fixed pattern `Recording YYYYMMDDHHMMSS.<ext>`,
 * which is what whisper-transkribera's watcher expects to find.
 *
 * The extension is a parameter because the codec is chosen at plugin load, by
 * `detectCodec()` in recorder.ts.
 */
export function generateFilename(
	now: Date,
	extension: "m4a" | "webm",
): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	const y = now.getFullYear().toString().padStart(4, "0");
	const mo = pad(now.getMonth() + 1);
	const d = pad(now.getDate());
	const h = pad(now.getHours());
	const mi = pad(now.getMinutes());
	const s = pad(now.getSeconds());
	return `Recording ${y}${mo}${d}${h}${mi}${s}.${extension}`;
}
