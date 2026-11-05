import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIO_BITS_PER_SECOND, captureOptions, computeRms, detectCodec, hasSystemAudio, mapLevelToDisplay } from "./recorder.js";

test("detectCodec picks audio/mp4 and .m4a when mp4 is supported", () => {
	const probe = (mimeType: string): boolean => mimeType === "audio/mp4";
	const result = detectCodec(probe);
	assert.equal(result.mimeType, "audio/mp4");
	assert.equal(result.extension, "m4a");
});

test("detectCodec falls back to audio/webm and .webm when mp4 is missing", () => {
	const probe = (mimeType: string): boolean =>
		mimeType === "audio/webm;codecs=opus";
	const result = detectCodec(probe);
	assert.equal(result.mimeType, "audio/webm;codecs=opus");
	assert.equal(result.extension, "webm");
});

test("detectCodec prefers mp4 even when both are supported", () => {
	const probe = (): boolean => true;
	const result = detectCodec(probe);
	assert.equal(result.extension, "m4a");
});

test("detectCodec throws when no supported codec is found", () => {
	const probe = (): boolean => false;
	assert.throws(() => detectCodec(probe), /No supported audio codec/);
});

// --- computeRms ----------------------------------------------------------

test("computeRms gives 0 for pure silence (every sample = 128)", () => {
	const buffer = new Uint8Array(2048).fill(128);
	const rms = computeRms(buffer);
	assert.equal(rms, 0);
});

test("computeRms gives about 1.0 at maximum negative amplitude (every sample = 0)", () => {
	const buffer = new Uint8Array(2048).fill(0);
	const rms = computeRms(buffer);
	// Deviation = (0-128)/128 = -1, squared = 1, RMS = 1. Clamped to 1.
	assert.ok(Math.abs(rms - 1) < 0.001, `expected about 1, got ${rms}`);
});

test("computeRms gives about 1.0 at maximum positive amplitude (every sample = 255)", () => {
	const buffer = new Uint8Array(2048).fill(255);
	const rms = computeRms(buffer);
	// Deviation = (255-128)/128 ≈ 0.9922, squared ≈ 0.9844, RMS ≈ 0.9922.
	assert.ok(rms > 0.99 && rms <= 1, `expected about 0.99-1.0, got ${rms}`);
});

test("computeRms gives about 0.5 at half amplitude (alternating 64/192)", () => {
	const buffer = new Uint8Array(2048);
	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = i % 2 === 0 ? 64 : 192;
	}
	const rms = computeRms(buffer);
	// Deviation: ±64/128 = ±0.5, squared = 0.25, mean = 0.25, RMS = 0.5.
	assert.ok(
		Math.abs(rms - 0.5) < 0.001,
		`expected about 0.5, got ${rms}`,
	);
});

test("computeRms gives 0 for an empty buffer (edge case)", () => {
	const buffer = new Uint8Array(0);
	const rms = computeRms(buffer);
	assert.equal(rms, 0);
});

// --- mapLevelToDisplay ---------------------------------------------------

test("mapLevelToDisplay(0) returns 0 (silence stays silent)", () => {
	assert.equal(mapLevelToDisplay(0), 0);
});

test("mapLevelToDisplay(1) returns at least 0.95 (full scale reaches the top)", () => {
	const display = mapLevelToDisplay(1);
	assert.ok(
		display >= 0.95,
		`expected at least 0.95 for rms=1, got ${display}`,
	);
});

test("mapLevelToDisplay(0.05) lifts normal speech near the mic to at least 0.20", () => {
	// About 0.05 is a typical RMS for normal speech at 50 cm. Identity gives an
	// invisible response; sqrt(0.05) ≈ 0.2236.
	const display = mapLevelToDisplay(0.05);
	assert.ok(
		display >= 0.2,
		`expected at least 0.20 for rms=0.05, got ${display}`,
	);
});

test("mapLevelToDisplay(0.15) lifts speech at room distance to at least 0.35", () => {
	// About 0.15 is a typical RMS for speech carrying across a room.
	// sqrt(0.15) ≈ 0.3873.
	const display = mapLevelToDisplay(0.15);
	assert.ok(
		display >= 0.35,
		`expected at least 0.35 for rms=0.15, got ${display}`,
	);
});

test("mapLevelToDisplay is monotonically non-decreasing across a sample", () => {
	const samples = [0, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0];
	let prev = -Infinity;
	for (const rms of samples) {
		const display = mapLevelToDisplay(rms);
		assert.ok(
			display >= prev,
			`monotonicity broke: f(${rms})=${display} < previous ${prev}`,
		);
		prev = display;
	}
});

test("mapLevelToDisplay clamps negative input to 0", () => {
	// Guards against NaN from Math.sqrt of a negative — and semantically, there
	// is nothing below silence, so it should simply be 0.
	assert.equal(mapLevelToDisplay(-0.5), 0);
});

test("mapLevelToDisplay clamps input above 1 to 1", () => {
	// computeRms already clamps to [0,1], but the mapping should be defensive
	// against an upstream error: 1.5 in should give 1, not sqrt(1.5).
	assert.equal(mapLevelToDisplay(1.5), 1);
});

// --- hasSystemAudio (the guard) ----------------------------------------------

test("hasSystemAudio returns false when there are 0 audio tracks", () => {
	// The case where the loopback stream arrives but has no audio track,
	// because the OS or a policy blocked system audio.
	assert.equal(hasSystemAudio(0), false);
});

test("hasSystemAudio returns true when there is 1 audio track", () => {
	// The normal case — system audio was captured.
	assert.equal(hasSystemAudio(1), true);
});

test("hasSystemAudio returns true when there are 2 audio tracks", () => {
	// Defensive — more tracks are still acceptable, not a failure case.
	assert.equal(hasSystemAudio(2), true);
});

// --- captureOptions ------------------------------------------------------

test("captureOptions: the microphone modes ask for 32 kbit/s and one channel", () => {
	const options = captureOptions("microphone", "audio/mp4");
	assert.deepEqual(options.recorder, {
		mimeType: "audio/mp4",
		audioBitsPerSecond: 32000,
	});
	assert.deepEqual(options.microphone, { audio: { channelCount: 1 } });
	assert.equal(options.mix, undefined);
});

test("captureOptions: the meeting mode asks for 32 kbit/s, a mono microphone and a one-channel mix", () => {
	const options = captureOptions("meeting", "audio/webm;codecs=opus");
	assert.deepEqual(options.recorder, {
		mimeType: "audio/webm;codecs=opus",
		audioBitsPerSecond: 32000,
	});
	assert.deepEqual(options.microphone, { audio: { channelCount: 1 } });
	assert.deepEqual(options.mix, {
		channelCount: 1,
		channelCountMode: "explicit",
	});
});

test("AUDIO_BITS_PER_SECOND is the one number every mode shares", () => {
	for (const kind of ["microphone", "meeting"] as const) {
		assert.equal(
			captureOptions(kind, "audio/mp4").recorder.audioBitsPerSecond,
			AUDIO_BITS_PER_SECOND,
		);
	}
});
