import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAudioPath } from "./audio-path.js";

const FILE = "Recording 20261022101500.m4a";

function harness(helperAnswer = "unused") {
	const calls: { helper: [string, string][]; folders: string[] } = {
		helper: [],
		folders: [],
	};
	return {
		calls,
		getAvailablePathForAttachment: async (f: string, s: string) => {
			calls.helper.push([f, s]);
			return helperAnswer;
		},
		ensureFolder: async (folder: string) => {
			calls.folders.push(folder);
		},
	};
}

test("a typed audio folder gives <folder>/<filename> and skips the helper", async () => {
	const h = harness();
	const path = await decideAudioPath({
		filename: FILE,
		sourceNotePath: "Notes/a.md",
		audioFolder: "Audio",
		...h,
	});
	assert.equal(path, `Audio/${FILE}`);
	assert.deepEqual(h.calls.helper, []);
	assert.deepEqual(h.calls.folders, ["Audio"]);
});

test("a typed folder is trimmed of surrounding slashes and spaces", async () => {
	const h = harness();
	const path = await decideAudioPath({
		filename: FILE,
		sourceNotePath: "a.md",
		audioFolder: " /Media/Audio/ ",
		...h,
	});
	assert.equal(path, `Media/Audio/${FILE}`);
	assert.deepEqual(h.calls.folders, ["Media/Audio"]);
});

test("an empty audio folder delegates to the helper with the source note path", async () => {
	const answer = `Projects/x/${FILE}`;
	const h = harness(answer);
	const path = await decideAudioPath({
		filename: FILE,
		sourceNotePath: "Projects/x/meeting.md",
		audioFolder: "",
		...h,
	});
	assert.equal(path, answer);
	assert.deepEqual(h.calls.helper, [[FILE, "Projects/x/meeting.md"]]);
	assert.deepEqual(h.calls.folders, ["Projects/x"]);
});

test("the helper's answer is returned unchanged, ' 1' suffix included", async () => {
	const answer = `Projects/Recording 20261022101500 1.m4a`;
	const h = harness(answer);
	const path = await decideAudioPath({
		filename: FILE,
		sourceNotePath: "Projects/m.md",
		audioFolder: "   ",
		...h,
	});
	assert.equal(path, answer);
});

test("a path at the vault root creates no folder", async () => {
	const h = harness(FILE);
	await decideAudioPath({
		filename: FILE,
		sourceNotePath: "m.md",
		audioFolder: "",
		...h,
	});
	assert.deepEqual(h.calls.folders, []);
});

test("a typed folder of only slashes means the top of the vault, not Obsidian's folder", async () => {
	for (const typed of ["/", "//", " / "]) {
		const h = harness("Elsewhere/unused.m4a");
		const path = await decideAudioPath({
			filename: FILE,
			sourceNotePath: "Projects/m.md",
			audioFolder: typed,
			...h,
		});
		assert.equal(path, FILE, `typed ${JSON.stringify(typed)}`);
		assert.deepEqual(h.calls.helper, []);
		assert.deepEqual(h.calls.folders, []);
	}
});
