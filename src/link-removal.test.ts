import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { removeRecordingLink, smallestEdit } from "./removal.js";

const AUDIO = "Audio/Recording 20261001090000.m4a";
const TRANSCRIPT = "Transcripts/Recording 20261001090000.md";

describe("removing a recording's link from a note's text", () => {
	it("takes the embed and the blank line the plugin put before it, and nothing else", () => {
		// What `insertRecordingLink` writes: a blank line, the embed, a blank line.
		const before = "# Notes\nWrote this myself.\n\n![[Recording 20261001090000.m4a]]\n\n## Overdue\n- [ ] a task\n";
		assert.equal(
			removeRecordingLink(before, AUDIO, []),
			"# Notes\nWrote this myself.\n\n## Overdue\n- [ ] a task\n",
		);
	});

	it("leaves a recording at the end of the note with the note's own final newline", () => {
		assert.equal(removeRecordingLink("# Notes\n\n![[Recording 20261001090000.m4a]]\n", AUDIO, []), "# Notes\n");
	});

	it("takes the transcript link beside the embed in a meeting note", () => {
		const before = "# Notes\n\n![[Recording 20261001090000.m4a]] [[Recording 20261001090000]]\n\n## Next\n";
		assert.equal(removeRecordingLink(before, AUDIO, [TRANSCRIPT]), "# Notes\n\n## Next\n");
	});

	it("takes only the embed when the link beside it is not the transcript's", () => {
		const before = "![[Recording 20261001090000.m4a]] [[Somebody else]]\n";
		assert.equal(removeRecordingLink(before, AUDIO, [TRANSCRIPT]), " [[Somebody else]]\n");
	});

	it("keeps the text around an embed that sits in a line of its own prose", () => {
		const before = "Listen: ![[Recording 20261001090000.m4a]] then act.\nNext line\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), "Listen:  then act.\nNext line\n");
	});

	it("matches an embed spelled with the full path, an alias or a heading", () => {
		const before = `![[${AUDIO}|the call]]\n![[Recording 20261001090000.m4a#t=5]]\nkept\n`;
		assert.equal(removeRecordingLink(before, AUDIO, []), "kept\n");
	});

	it("leaves another recording's embed alone", () => {
		const before = "# Notes\n\n![[Recording 20261001090000.m4a]]\n\n![[Recording 20261002100000.m4a]]\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), "# Notes\n\n![[Recording 20261002100000.m4a]]\n");
	});

	it("returns a note that has no such embed byte for byte", () => {
		const text = "# Notes\r\n\r\nSome text  \r\n";
		assert.equal(removeRecordingLink(text, AUDIO, [TRANSCRIPT]), text);
	});

	it("does not take a blank line the plugin did not put there", () => {
		// The embed follows text directly (cursor mode): there is no blank line to take.
		const before = "First line\n![[Recording 20261001090000.m4a]]\nLast line\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), "First line\nLast line\n");
	});
});

describe("a blank line only the plugin put there", () => {
	it("keeps the user's blank line above a cursor-mode embed that more text follows", () => {
		// The cursor was on an empty line below a blank line; the embed went into that line alone.
		const before = "Para A\n\n![[Recording 20261001090000.m4a]]\nPara B\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), "Para A\n\nPara B\n");
	});

	it("keeps it above a cursor-mode embed that ends the note without a newline", () => {
		const before = "Para A\n\n![[Recording 20261001090000.m4a]]";
		assert.equal(removeRecordingLink(before, AUDIO, []), "Para A\n");
	});

	it("takes the blank line above an embed the plugin wrote, with its blank line after it", () => {
		const before = "# Notes\nText\n\n![[Recording 20261001090000.m4a]]\n\nMore\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), "# Notes\nText\n\nMore\n");
	});
});

describe("a link inside a fenced code block", () => {
	const embed = "![[Recording 20261001090000.m4a]]";

	it("is left alone, byte for byte", () => {
		const before = `Syntax:\n\`\`\`\n${embed}\n\`\`\`\n`;
		assert.equal(removeRecordingLink(before, AUDIO, []), before);
	});

	it("is left alone in a tilde fence, and the real embed outside it still goes", () => {
		const before = `~~~md\n${embed}\n~~~\n\n${embed}\n\nafter\n`;
		assert.equal(removeRecordingLink(before, AUDIO, []), `~~~md\n${embed}\n~~~\n\nafter\n`);
	});

	it("is left alone when the fence is never closed, as the rest of the plugin reads it", () => {
		const before = `\`\`\`\n${embed}\n`;
		assert.equal(removeRecordingLink(before, AUDIO, []), before);
	});
});

describe("a link written some other way", () => {
	it("is taken as a plain link, a folder-path link or a Markdown link", () => {
		const before = `[[Recording 20261001090000.m4a]]\n![[${AUDIO}]]\n![the call](Audio/Recording%2020261001090000.m4a)\nkept\n`;
		assert.equal(removeRecordingLink(before, AUDIO, []), "kept\n");
	});

	it("matches a link by any folder when only the file's name is known", () => {
		const before = "![[Old/Recording 20261001090000.m4a]]\nkept\n";
		assert.equal(removeRecordingLink(before, "Recording 20261001090000.m4a", []), "kept\n");
	});

	it("leaves another folder's file of the same name alone when the audio's path is known", () => {
		const before = "![[Old/Recording 20261001090000.m4a]]\n";
		assert.equal(removeRecordingLink(before, AUDIO, []), before);
	});
});

describe("the smallest edit between two texts", () => {
	it("is the span that differs, so the editor changes only that", () => {
		const before = "aaa\n\n![[x.m4a]]\n\nbbb";
		const after = "aaa\n\nbbb";
		const edit = smallestEdit(before, after);
		assert.equal(before.slice(0, edit.from) + edit.insert + before.slice(edit.to), after);
		assert.ok(edit.to - edit.from <= "\n![[x.m4a]]\n".length);
	});

	it("is empty when nothing differs", () => {
		assert.deepEqual(smallestEdit("same", "same"), { from: 4, to: 4, insert: "" });
	});
});
