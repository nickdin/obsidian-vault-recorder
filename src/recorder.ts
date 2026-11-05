/**
 * MediaRecorder-based recorder for all three modes — the microphone alone for
 * quick capture and record-at-cursor, the microphone mixed with system audio
 * for the meeting mode.
 *
 * It runs entirely in the renderer process through Web APIs — no shelled-out
 * binary, no ffmpeg. It lives as long as the session does, and dies with
 * Obsidian, by accept-loss.
 *
 * API:
 *   - detectCodec(isTypeSupported?)      → picks .m4a or .webm once, at load
 *   - startRecording(mimeType)           → opens the mic, starts MediaRecorder + Analyser
 *   - startMeetingRecording(mimeType)    → mixes mic + system audio, starts MediaRecorder + Analyser
 *   - stopRecording(session)             → stops, closes tracks (sourceStreams included), returns a Blob
 *   - readLevel(session)                 → RMS 0.0–1.0 from time-domain data
 *   - captureOptions(kind, mimeType)     → the bitrate, channel count and mix every mode asks for
 *   - hasSystemAudio(audioTrackCount)    → guard: is there an audio track on the display stream?
 *
 * Pure where it can be: detectCodec, captureOptions, computeRms, mapLevelToDisplay and
 * hasSystemAudio are pure and testable through injected parameters or a direct
 * call. startRecording, startMeetingRecording, stopRecording and readLevel
 * need the DOM and MediaRecorder, and are tested by hand in Obsidian.
 */

export interface CodecChoice {
	mimeType: string;
	extension: "m4a" | "webm";
}

export interface RecordingSession {
	mediaRecorder: MediaRecorder;
	/**
	 * The stream the MediaRecorder records. In the microphone-only modes that
	 * is the microphone stream itself. In the meeting mode it is
	 * `MediaStreamDestination.stream`, the mix of microphone and system audio.
	 * Its tracks are always stopped in `stopRecording`.
	 */
	stream: MediaStream;
	audioContext: AudioContext;
	analyser: AnalyserNode;
	chunks: Blob[];
	startedAt: Date;
	mimeType: string;
	/**
	 * The highest RMS level seen during the session (0.0–1.0). Updated by
	 * `readLevel` on every tick. `stopCapture` uses it to decide whether the
	 * recording was silent.
	 */
	peakLevel: number;
	/**
	 * Source streams beyond `stream` that must be stopped at stop time (the
	 * meeting mode). For the meeting mode: [micStream, displayStream]. These
	 * are the actual microphone and system-audio streams feeding the Web Audio
	 * graph. `stopRecording` stops every track in them after stopping the
	 * tracks in `stream`.
	 *
	 * Not set for microphone-only sessions — their behaviour is unchanged.
	 */
	sourceStreams?: MediaStream[];
}

/**
 * What every recording asks for: 32 kbit/s and one channel. One fixed number,
 * in one place, no setting — an hour of speech is then about 14 MB. Nothing is
 * split or re-encoded afterwards; the browser's encoder is asked once.
 */
export const AUDIO_BITS_PER_SECOND = 32_000;
export const CHANNEL_COUNT = 1;

/**
 * Everything a recording mode asks the browser for, built in one pure place so
 * `recorder.test.ts` can assert it without a microphone.
 *
 * - `recorder`: the `MediaRecorder` options.
 * - `microphone`: the `getUserMedia` constraints for the microphone stream.
 * - `mix`: for the meeting mode only, the settings of the one-channel
 *   destination node the microphone and the system audio are mixed into.
 *   `channelCountMode: "explicit"` makes the node downmix to one channel
 *   whatever the inputs carry; the "max" default would follow the inputs.
 *
 * The daily-log and cursor modes both go through `startRecording`, so they
 * share the "microphone" kind.
 */
export interface CaptureOptions {
	recorder: MediaRecorderOptions;
	microphone: MediaStreamConstraints;
	mix?: { channelCount: number; channelCountMode: "explicit" };
}

export function captureOptions(
	kind: "microphone" | "meeting",
	mimeType: string,
): CaptureOptions {
	const options: CaptureOptions = {
		recorder: { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND },
		microphone: { audio: { channelCount: CHANNEL_COUNT } },
	};
	if (kind === "meeting") {
		options.mix = {
			channelCount: CHANNEL_COUNT,
			channelCountMode: "explicit",
		};
	}
	return options;
}

const MP4_MIME = "audio/mp4";
const WEBM_MIME = "audio/webm;codecs=opus";

/**
 * Probe what MediaRecorder supports and choose between .m4a and .webm.
 *
 * Pure: it takes `isTypeSupported` as a parameter, defaulting to the global
 * `MediaRecorder.isTypeSupported` where one exists (the renderer process).
 *
 * The choice: `audio/mp4` first, because whisper-transkribera and most other
 * tools handle m4a natively, with webm/opus as the fallback.
 *
 * @throws Error if neither candidate is supported — a MediaRecorder that
 *   supports nothing is a hard failure.
 *
 * OPEN QUESTION: the `.webm` branch has never run. Every machine this plugin
 * has recorded on offered `audio/mp4`, so the fallback is untested end to end
 * — and anything downstream that picks recordings up by an `.m4a` suffix
 * would not see a `.webm` file at all, leaving it saved but never processed.
 * Answering it means forcing the probe to reject MP4 once and following the
 * resulting file through to whatever consumes it.
 */
export function detectCodec(
	isTypeSupported?: (mimeType: string) => boolean,
): CodecChoice {
	const probe =
		isTypeSupported ??
		((m: string): boolean => {
			if (
				typeof MediaRecorder !== "undefined" &&
				typeof MediaRecorder.isTypeSupported === "function"
			) {
				return MediaRecorder.isTypeSupported(m);
			}
			return false;
		});

	if (probe(MP4_MIME)) {
		return { mimeType: MP4_MIME, extension: "m4a" };
	}
	if (probe(WEBM_MIME)) {
		return { mimeType: WEBM_MIME, extension: "webm" };
	}
	throw new Error(
		`No supported audio codec found (probed ${MP4_MIME}, ${WEBM_MIME}).`,
	);
}

/**
 * Thrown by `startMeetingRecording` when the system-audio stream has no audio
 * track — the OS or a security policy blocked loopback capture, or there is no
 * active playback device to capture.
 *
 * The contract: if this is thrown, `startMeetingRecording` has already cleaned
 * up EVERY resource it allocated (microphone tracks, loopback tracks, the
 * AudioContext) and no recording has started. The caller only has to show a
 * notice.
 */
export class SystemAudioUnavailableError extends Error {
	constructor(message = "The system-audio stream has no audio track — loopback capture was blocked, or there is no active playback device.") {
		super(message);
		this.name = "SystemAudioUnavailableError";
	}
}

/**
 * Is this many audio tracks enough for the meeting mode?
 *
 * A pure function, extracted so it can be unit-tested. Used in
 * `startMeetingRecording` to detect a loopback stream that came back without
 * an audio track, because the OS or a policy blocked system-audio capture.
 *
 * @param audioTrackCount  Audio tracks on the loopback stream, from `getAudioTracks().length`.
 * @returns true if there is at least one audio track, false if the stream has no system audio.
 */
export function hasSystemAudio(audioTrackCount: number): boolean {
	return audioTrackCount > 0;
}

/**
 * Start the meeting mode's recording: mix microphone and system audio into one
 * stream through the Web Audio API and record that with the same MediaRecorder
 * pipeline as everything else.
 *
 * ## System audio through Electron's legacy constraint
 *
 * The system audio (loopback) is obtained with `getUserMedia` and Chromium's
 * legacy `chromeMediaSource: 'desktop'` constraint. This is a SEPARATE code
 * path from `getDisplayMedia`, which throws `NotSupportedError` in Obsidian
 * because Electron's main process never registers
 * `setDisplayMediaRequestHandler` (measured live, 2026-06-15). The legacy
 * constraint was verified workable in the Obsidian runtime by a spike (peak
 * RMS around 0.18). Unlike getDisplayMedia it shows no screen-sharing dialog —
 * the capture starts straight away.
 *
 * ## The contract
 *
 * If the loopback stream has no audio track (the OS or a policy blocked system
 * audio), EVERY allocated resource is cleaned up and
 * `SystemAudioUnavailableError` is thrown. No recording starts and no file is
 * created. The caller only has to catch it and show a notice.
 *
 * The same holds if any other step throws after the streams are open — the
 * try/catch in the function body cleans up the microphone, the loopback and
 * the AudioContext.
 *
 * ## The audio graph
 *
 * ```
 * micStream ─────► MediaStreamSource ─┬─► MediaStreamDestination ► MediaRecorder
 *                                      └─► AnalyserNode (level meter)
 * loopbackStream ► MediaStreamSource ─┬─► MediaStreamDestination
 *                                      └─► AnalyserNode
 * ```
 *
 * The level meter (`session.analyser`) reads the mixed level, because both
 * sources connect to the same AnalyserNode.
 *
 * @param mimeType             MIME type chosen by `detectCodec` (for example "audio/mp4").
 * @param onSystemAudioEnded   Optional callback, invoked if the system-audio
 *                             track ends part-way through a recording (the OS
 *                             changes its default audio device, a headset is
 *                             unplugged, or the loopback track is torn down).
 *                             `main.ts` uses it to stop the recording and show
 *                             a notice.
 * @throws SystemAudioUnavailableError if the loopback stream has no audio track.
 * @throws DOMException if getUserMedia was denied.
 */
export async function startMeetingRecording(
	mimeType: string,
	onSystemAudioEnded?: () => void,
): Promise<RecordingSession> {
	// Step 1: open the microphone stream. If this fails (denied, no
	// microphone) the exception propagates straight out — nothing has been
	// allocated yet, so there is nothing to clean up.
	const options = captureOptions("meeting", mimeType);
	const micStream = await navigator.mediaDevices.getUserMedia(
		options.microphone,
	);

	// Step 2: open the system-audio stream through Electron's legacy
	// constraint (chromeMediaSource: 'desktop'). Chromium requires video to be
	// requested before it will hand over loopback audio; the video track is not
	// recorded, but it is stopped through sourceStreams at stop time. The
	// constraint shape is not typed in lib.dom, so mediaDevices is cast to a
	// minimal getUserMedia signature.
	let displayStream: MediaStream | null = null;
	let audioContext: AudioContext | null = null;
	try {
		displayStream = await (
			navigator.mediaDevices as unknown as {
				getUserMedia: (constraints: unknown) => Promise<MediaStream>;
			}
		).getUserMedia({
			audio: { mandatory: { chromeMediaSource: "desktop" } },
			video: { mandatory: { chromeMediaSource: "desktop" } },
		});

		// Step 3: check that the loopback stream really carries audio. The
		// constraint can return a valid stream with no audio track when the OS
		// or a security policy blocks system-audio capture.
		if (!hasSystemAudio(displayStream.getAudioTracks().length)) {
			// Clean up both streams before throwing — nothing may leak.
			micStream.getTracks().forEach((track) => track.stop());
			displayStream.getTracks().forEach((track) => track.stop());
			throw new SystemAudioUnavailableError();
		}

		// The two platforms behave oppositely here, and the note below is
		// written from the Windows one. Both measured live.
		//
		// Windows, 2026-06-16: changing the default playback device leaves the
		// loopback track bound to the old device. "ended" never fires, and the
		// recording continues silently with the microphone alone — the exact
		// silent loss this listener exists to prevent. That is the known bug.
		//
		// Linux, 2026-08-19: it fires, and the guard works. The capture is
		// mediated by the Wayland screen-share portal, whose session does not
		// survive the default sink changing, so the track ends, this handler
		// runs, and the recording is stopped, saved and announced. Measured
		// with sound playing through the machine and audible in the saved
		// file, so the system-audio half was genuinely live when the device
		// changed. Two things do NOT trigger it here: changing the microphone
		// (the recording continues and the input follows), and any device
		// change during a microphone-only recording, which has no loopback
		// track for this listener to attach to. A saved file tells the modes
		// apart — the mixed meeting stream is two channels, microphone-only
		// is one.
		//
		// The consequence on Linux is a limitation rather than a loss: a
		// meeting recording cannot outlive a change of speakers. It ends
		// cleanly and keeps everything up to that point.
		//
		// Step 3b: listen for the audio track's "ended" event. Chromium fires
		// "ended" on the loopback audio track when system-audio capture breaks
		// part-way through a session. Without this listener the MediaRecorder
		// carries on silently with the microphone alone.
		// Guard: the hasSystemAudio check above proves the audio track exists.
		if (onSystemAudioEnded) {
			const audioTrack = displayStream.getAudioTracks()[0];
			audioTrack.addEventListener("ended", () => {
				onSystemAudioEnded();
			});
		}

		// Step 4: build the Web Audio graph. An AudioContext can start
		// "suspended" under some autoplay policies.
		audioContext = new AudioContext();
		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}

		const micSource = audioContext.createMediaStreamSource(micStream);
		const displaySource = audioContext.createMediaStreamSource(displayStream);

		// The destination node produces the mixed MediaStream the
		// MediaRecorder records.
		// It is one channel, whatever the sources carry (see captureOptions).
		const destination = audioContext.createMediaStreamDestination();
		if (options.mix) {
			destination.channelCount = options.mix.channelCount;
			destination.channelCountMode = options.mix.channelCountMode;
		}

		// AnalyserNode (fftSize 2048, the same as startRecording) for the level
		// meter. Both sources connect here so readLevel() reads the mixed level.
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;

		// Connect micSource → destination + analyser.
		micSource.connect(destination);
		micSource.connect(analyser);

		// Connect displaySource → destination + analyser.
		displaySource.connect(destination);
		displaySource.connect(analyser);

		// Step 5: start the MediaRecorder on the mixed stream, through the same
		// pipeline as startRecording (timeslice 1000 ms, dataavailable
		// handling).
		const mediaRecorder = new MediaRecorder(
			destination.stream,
			options.recorder,
		);
		const chunks: Blob[] = [];
		mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
			if (event.data && event.data.size > 0) {
				chunks.push(event.data);
			}
		});
		mediaRecorder.start(1000);

		return {
			mediaRecorder,
			stream: destination.stream,
			sourceStreams: [micStream, displayStream],
			audioContext,
			analyser,
			chunks,
			startedAt: new Date(),
			mimeType,
			peakLevel: 0,
		};
	} catch (err) {
		// If anything throws after the streams are open, clean up everything
		// that was allocated. SystemAudioUnavailableError already cleans up
		// before throwing; this catch covers every other failure (AudioContext
		// problems and the like).
		micStream.getTracks().forEach((track) => track.stop());
		if (displayStream) {
			displayStream.getTracks().forEach((track) => track.stop());
		}
		if (audioContext) {
			await audioContext.close().catch(() => {});
		}
		throw err;
	}
}

/**
 * Open the microphone stream and start a new recording session.
 *
 * Throws if `getUserMedia` fails (the user denies it, there is no microphone,
 * and so on). The caller is responsible for catching that and showing a notice.
 */
export async function startRecording(
	mimeType: string,
): Promise<RecordingSession> {
	const options = captureOptions("microphone", mimeType);
	const stream = await navigator.mediaDevices.getUserMedia(options.microphone);

	// If anything after getUserMedia throws, the microphone tracks have to be
	// released and the AudioContext closed by hand — otherwise the OS
	// recording indicator stays lit and audio resources leak until the window
	// closes.
	let audioContext: AudioContext | null = null;
	try {
		audioContext = new AudioContext();
		// Electron can start an AudioContext "suspended" under some autoplay
		// policies. Without resume() the AnalyserNode reports nothing but
		// silence.
		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);

		const mediaRecorder = new MediaRecorder(stream, options.recorder);
		const chunks: Blob[] = [];
		mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
			if (event.data && event.data.size > 0) {
				chunks.push(event.data);
			}
		});

		// timeslice=1000 ms makes dataavailable fire continuously rather than
		// only at stop. Not critical given accept-loss, but it keeps memory use
		// down on a long session.
		mediaRecorder.start(1000);

		return {
			mediaRecorder,
			stream,
			audioContext,
			analyser,
			chunks,
			startedAt: new Date(),
			mimeType,
			peakLevel: 0,
		};
	} catch (err) {
		stream.getTracks().forEach((track) => track.stop());
		if (audioContext) {
			await audioContext.close().catch(() => {});
		}
		throw err;
	}
}

/**
 * Stop the recording and return the complete audio Blob.
 *
 * It waits for the `stop` event, so the last chunk is guaranteed to be in
 * before the Blob is built. Then it closes the microphone tracks and the
 * AudioContext to release the OS resources — the red recording indicator in
 * the taskbar among them.
 */
export async function stopRecording(
	session: RecordingSession,
): Promise<Blob> {
	// If the recorder has already stopped (after an external error, say), skip
	// the wait.
	if (session.mediaRecorder.state !== "inactive") {
		await new Promise<void>((resolve) => {
			session.mediaRecorder.addEventListener("stop", () => resolve(), {
				once: true,
			});
			session.mediaRecorder.stop();
		});
	}

	// Stop the recorded stream (microphone-only: the microphone stream; meeting
	// mode: the destination stream).
	session.stream.getTracks().forEach((track) => track.stop());

	// Stop the source streams where there are any (the meeting mode:
	// [micStream, displayStream]). They are separate from `session.stream`, the
	// destination stream, and have to be stopped explicitly to release the
	// microphone indicator and the system-audio capture.
	if (session.sourceStreams) {
		for (const src of session.sourceStreams) {
			src.getTracks().forEach((track) => track.stop());
		}
	}

	try {
		await session.audioContext.close();
	} catch {
		// The AudioContext can already be closed in an edge case — ignore.
	}

	return new Blob(session.chunks, { type: session.mimeType });
}

/**
 * Compute the RMS amplitude (0.0–1.0) of a time-domain buffer.
 *
 * `getByteTimeDomainData` gives unsigned 8-bit samples centred on 128
 * (silence). The RMS is computed on the deviation from 128 and normalised by
 * /128, so full scale gives 1.0. Clamped for safety.
 *
 * A pure function, extracted from `readLevel` so it can be unit-tested.
 */
export function computeRms(timeDomainData: Uint8Array): number {
	if (timeDomainData.length === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < timeDomainData.length; i++) {
		const deviation = (timeDomainData[i] - 128) / 128;
		sumSquares += deviation * deviation;
	}
	const rms = Math.sqrt(sumSquares / timeDomainData.length);
	return Math.min(1, Math.max(0, rms));
}

/**
 * Read the current RMS amplitude (0.0–1.0) from the AnalyserNode's time domain
 * and update the session's `peakLevel` (a monotonic maximum over the lifetime
 * of the session).
 *
 * Safe to call in a requestAnimationFrame loop — one Uint8Array allocation per
 * tick, which is cheap next to the RAF tick rate itself.
 */
export function readLevel(session: RecordingSession): number {
	const buffer = new Uint8Array(session.analyser.fftSize);
	session.analyser.getByteTimeDomainData(buffer);
	const rms = computeRms(buffer);
	if (rms > session.peakLevel) {
		session.peakLevel = rms;
	}
	return rms;
}

/**
 * Return the highest RMS level seen during the session. `stopCapture` uses it
 * to filter out silent recordings. It only reads the stored value and never
 * calls the AnalyserNode, so it is safe to use after `stopRecording` has closed
 * the audio graph.
 */
export function getPeakLevel(session: RecordingSession): number {
	return session.peakLevel;
}

/**
 * Perceptual scaling from raw RMS amplitude (0.0–1.0) to the display value of
 * the CSS variable `--vr-level` in the level-meter ribbon.
 *
 * ## Why it is needed
 *
 * `computeRms` returns a linear RMS amplitude. Normal speech close to the
 * microphone (about 50 cm) typically lands at 0.05–0.15; at room distance
 * (2–3 m) more like 0.02–0.06. The value used to be mapped straight onto
 * `--vr-level`, and the CSS effects (color-mix muted→warning, scale up to
 * 1.08, VU fill through scaleY) are all linear in that variable. The result:
 * at 0.05 the scale is 1.004x and the fill is vanishingly small — visually
 * "nothing".
 *
 * That does not match how the ear experiences sound, which is logarithmic.
 * Lifting the low decimals into a range where the CSS effects are visible is
 * the whole point of this function.
 *
 * ## Choosing the curve: square root
 *
 * Three candidates were compared:
 *
 * | rms  | identity  | √x    | ∛x    | dBFS-norm (-60..0) |
 * |------|-----------|-------|-------|--------------------|
 * | 0.00 | 0.000     | 0.000 | 0.000 | 0.000              |
 * | 0.02 | 0.020     | 0.141 | 0.271 | 0.434              |
 * | 0.05 | 0.050     | 0.224 | 0.368 | 0.566              |
 * | 0.15 | 0.150     | 0.387 | 0.531 | 0.726              |
 * | 0.50 | 0.500     | 0.707 | 0.794 | 0.900              |
 * | 1.00 | 1.000     | 1.000 | 1.000 | 1.000              |
 *
 * - Identity gives back the muted experience the curve was introduced to get
 *   rid of: normal speech is barely visible.
 * - Cube root and dBFS lift even quiet levels (0.005–0.015 of background
 *   noise) far enough that the ribbon colour and fill move visibly. That
 *   breaks the rule that silence must stay still, and risks looking shrill at
 *   moderate volume.
 * - Square root lifts 0.05 to 0.224 and 0.15 to 0.387 — visible through the
 *   CSS pipeline (scale about 1.018–1.031, VU fill scaleY 0.224–0.387,
 *   opacity 0.46–0.54) — while 0.005–0.015 give 0.071–0.122, still close to
 *   invisible (scale about 1.006, fill scaleY 0.07–0.12 at opacity
 *   0.39–0.41). So the curve meets both requirements: a visible response to
 *   speech, still nothing at silence.
 *
 * ## Properties
 *
 * - `mapLevelToDisplay(0) === 0`
 * - `mapLevelToDisplay(1) === 1`
 * - Monotonically non-decreasing
 * - Clamped to [0, 1], including for negative input and input above 1
 *
 * ## The layering rule
 *
 * Pure and testable. It **must NOT be called from `readLevel`, `computeRms` or
 * `getPeakLevel`** — those have to go on returning and storing raw linear RMS,
 * because `session.peakLevel` is what `stopCapture` uses for the
 * silent-microphone guard (peak < SILENT_THRESHOLD = 0.02 → no file saved).
 * Scaling that level would be semantically wrong: the threshold is calibrated
 * against linear RMS. This mapping belongs only in the rendering pipeline in
 * `main.ts:startLevelLoop`, between `readLevel`'s return value and the CSS
 * write.
 */
export function mapLevelToDisplay(rms: number): number {
	// Clamp the input BEFORE the square root — sqrt of a negative is NaN, and
	// both rms < 0 and rms > 1 should be read as clamped endpoints rather than
	// propagating an error up into the CSS.
	const clamped = Math.min(1, Math.max(0, rms));
	return Math.sqrt(clamped);
}
