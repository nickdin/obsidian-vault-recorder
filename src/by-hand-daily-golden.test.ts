import { it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { makeFakeWorld } from "./lifecycle-fakes.js";
import { RecordingActions } from "./lifecycle-actions.js";

// #122's box "one embedded in a daily log gets the daily-log request, unchanged
// from today": the notice and the whole request note, compared with what the
// code before #122 wrote for the same recording (`src/goldens/by-hand-daily-log.json`,
// made at commit 0bbcead), plus the `transcribe-kind` line #200 added to every request.

it("a recording in a daily log gets the request and notice it got before #122, byte for byte", async () => {
	const world = makeFakeWorld();
	for (const mode of ["dailyLog", "cursor", "meeting"] as const) {
		world.currentSettings.transcribers[mode].kind = "hand-off";
	}
	world.vault.binaries.set("Recording 20261019091200.m4a", 2_314_752);
	world.vault.seed("2026-10-19.md", "# Notes\n![[Recording 20261019091200.m4a]]\n");
	const actions = new RecordingActions({
		vault: world.vault,
		clock: world.clock,
		settings: world.settings,
		exclusively: async (_path, step) => ({ ran: true, value: await step() }),
		noteProperties: world.noteProperties,
		confirm: async () => true,
		refresh: async () => {},
	});
	const result = await actions.transcribe("Recording 20261019091200.m4a", { linkedFrom: "2026-10-19.md" });
	const golden = JSON.parse(readFileSync(new URL("./goldens/by-hand-daily-log.json", import.meta.url), "utf8"));
	assert.deepEqual({ message: result.message, note: world.vault.texts.get("Recording 20261019091200.md") }, golden);
});
