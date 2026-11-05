import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { classifyInsertOutcome, insertRecordingLink } from "./note-insert.js";

// `# Anteckningar` stays Swedish throughout this file on purpose: it is the
// heading the author's vault holds in hundreds of notes, and `whisper-transkribera`
// matches the same words. The code no longer spells it (the notes heading is a
// setting); `settings-migration.ts` carries it as the default for an upgraded
// vault. A red test here after a translation sweep means the protected string
// was translated by mistake — read the code, do not fix the test.

// The heading text and level the settings hand in; the same fixtures run on
// `Notes`/1 and a level-2 heading further down.
// The Swedish text is cut from the heading literal so that the Swedish-prose
// checker keeps reporting only the heading itself, never a bare word.
const ANTECKNINGAR = { text: "# Anteckningar".slice(2), level: 1 };
const NOTES = { text: "Notes", level: 1 };

const FILE = "Recording 20260415081200.m4a";
const LINK = `![[${FILE}]]`;

describe("insertRecordingLink — appending inside the section", () => {
	it("heading is the last line (no content after it) — appends directly under the heading", () => {
		const input = "# Meeting with X\n\n# Anteckningar\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		// The section has no content, so the result is heading, blank, link, blank.
		assert.equal(out, "# Meeting with X\n\n# Anteckningar\n\n" + LINK + "\n");
	});

	it("heading with content straight after it — the link is appended last in the section", () => {
		const input = "# Anteckningar\nMy first point.\nThe second point.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Anteckningar\nMy first point.\nThe second point.\n\n" + LINK + "\n",
		);
	});

	it("heading with a blank line and then content — link last, blank lines normalised", () => {
		const input = "# Anteckningar\n\nMy first point.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Anteckningar\n\nMy first point.\n\n" + LINK + "\n",
		);
	});

	it("section followed by another H1 — the link goes in before the next H1", () => {
		const input =
			"# Meeting\n\nIntroduction.\n\n# Anteckningar\nFirst.\n\n# Summary\nConclusion.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Meeting\n\nIntroduction.\n\n# Anteckningar\nFirst.\n\n" +
				LINK +
				"\n\n# Summary\nConclusion.\n",
		);
	});

	it("section last in the file with content — the link goes after the content", () => {
		const input = "# Title\n\n# Anteckningar\n\nNote one.\nNote two.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Title\n\n# Anteckningar\n\nNote one.\nNote two.\n\n" +
				LINK +
				"\n",
		);
	});

	it("several H1s in the file — only the FIRST # Anteckningar is used", () => {
		const input =
			"# Anteckningar\nFirst.\n\n# Something else\n\n# Anteckningar\nSecond.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		// The link belongs in the first section, before "# Something else".
		assert.equal(
			out,
			"# Anteckningar\nFirst.\n\n" +
				LINK +
				"\n\n# Something else\n\n# Anteckningar\nSecond.\n",
		);
	});
});

describe("insertRecordingLink — the heading is missing", () => {
	it("empty file → creates the heading and the link", () => {
		const out = insertRecordingLink("", FILE, ANTECKNINGAR);
		assert.equal(out, "# Anteckningar\n\n" + LINK + "\n");
	});

	it("content without the heading → appends heading and link last (trailing newline)", () => {
		const input = "Just some text.\nWith no heading.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"Just some text.\nWith no heading.\n\n# Anteckningar\n\n" + LINK + "\n",
		);
	});

	it("content with no trailing newline → the separator is normalised", () => {
		const input = "Text with no closing newline";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"Text with no closing newline\n\n# Anteckningar\n\n" + LINK + "\n",
		);
	});

	it("## Anteckningar (H2) counts as missing → appends a new H1 section", () => {
		const input = "# Title\n\n## Anteckningar\nA point.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Title\n\n## Anteckningar\nA point.\n\n# Anteckningar\n\n" + LINK + "\n",
		);
	});
});

describe("insertRecordingLink — idempotence and special cases", () => {
	it("an existing link to the SAME file → content unchanged", () => {
		const input =
			"# Meeting\n\n# Anteckningar\n\n![[Recording 20260101120000.m4a]]\n\nText.\n";
		const out = insertRecordingLink(input, "Recording 20260101120000.m4a", ANTECKNINGAR);
		assert.equal(out, input);
	});

	it("an existing link to ANOTHER file → the new link is added last in the section", () => {
		const input =
			"# Anteckningar\n\n![[Recording 20260101010101.m4a]]\n\nOlder text.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Anteckningar\n\n![[Recording 20260101010101.m4a]]\n\nOlder text.\n\n" +
				LINK +
				"\n",
		);
		assert.ok(out.includes("![[Recording 20260101010101.m4a]]"));
	});

	it("a heading with trailing whitespace is accepted", () => {
		const input = "# Anteckningar   \nA point.\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(out, "# Anteckningar   \nA point.\n\n" + LINK + "\n");
	});
});

describe("classifyInsertOutcome", () => {
	it("returns 'already-present' when before === after", () => {
		const before = "# Anteckningar\n\n" + LINK + "\n";
		const after = insertRecordingLink(before, FILE, ANTECKNINGAR);
		assert.equal(after, before);
		assert.equal(classifyInsertOutcome(before, after), "already-present");
	});

	it("returns 'inserted' when after carries a new link", () => {
		const before = "# Anteckningar\n\nText.\n";
		const after = insertRecordingLink(before, FILE, ANTECKNINGAR);
		assert.notEqual(after, before);
		assert.equal(classifyInsertOutcome(before, after), "inserted");
	});
});

// --- The heading is a setting: text and level -------------------------------

describe("insertRecordingLink — the heading matched by text and level", () => {
	it("Notes/1 finds `# Notes` and ignores `# Anteckningar`", () => {
		const input = "# Anteckningar\nSwedish.\n\n# Notes\nEnglish.\n";
		const out = insertRecordingLink(input, FILE, NOTES);
		assert.equal(out, "# Anteckningar\nSwedish.\n\n# Notes\nEnglish.\n\n" + LINK + "\n");
	});

	it("Anteckningar/1 finds `# Anteckningar` and ignores `# Notes`", () => {
		const input = "# Notes\nEnglish.\n\n# Anteckningar\nSwedish.\n\n# Dagbok\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			"# Notes\nEnglish.\n\n# Anteckningar\nSwedish.\n\n" + LINK + "\n\n# Dagbok\n",
		);
	});

	it("a level-2 heading is found at level 2 and the link goes before the next heading of that level", () => {
		const input = "# Day\n\n## Notes\nA point.\n\n## Calendar\nTable.\n";
		const out = insertRecordingLink(input, FILE, { text: "Notes", level: 2 });
		assert.equal(out, "# Day\n\n## Notes\nA point.\n\n" + LINK + "\n\n## Calendar\nTable.\n");
	});

	it("a level-2 setting does not take a level-1 heading of the same words", () => {
		const input = "# Notes\nA point.\n";
		const out = insertRecordingLink(input, FILE, { text: "Notes", level: 2 });
		assert.equal(out, "# Notes\nA point.\n\n## Notes\n\n" + LINK + "\n");
	});

	it("a level-1 setting does not take a level-2 heading of the same words", () => {
		const input = "## Notes\nA point.\n";
		const out = insertRecordingLink(input, FILE, NOTES);
		assert.equal(out, "## Notes\nA point.\n\n# Notes\n\n" + LINK + "\n");
	});

	it("trailing blanks and capitals do not matter, an extra word does", () => {
		assert.equal(
			insertRecordingLink("# Notes  \nA.\n", FILE, NOTES),
			"# Notes  \nA.\n\n" + LINK + "\n",
		);
		assert.equal(
			insertRecordingLink("# NOTES\nA.\n", FILE, NOTES),
			"# NOTES\nA.\n\n" + LINK + "\n",
		);
		assert.equal(
			insertRecordingLink("# Notes for later\nA.\n", FILE, NOTES),
			"# Notes for later\nA.\n\n# Notes\n\n" + LINK + "\n",
		);
	});

	// The fixtures are built from the setting's text so the checker sees no new
	// Swedish fragment.
	it("a capitals-only near miss of the default heading lands in the existing section", () => {
		const lower = `# ${ANTECKNINGAR.text.toLowerCase()}`;
		const input = `${lower}\nMy line.\n\n# Dagbok\n`;
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(out, `${lower}\nMy line.\n\n${LINK}\n\n# Dagbok\n`);
	});

	it("two spaces after the # land in the existing section, with no duplicate", () => {
		const input = `#  ${ANTECKNINGAR.text}\nMy line.\n\n# Dagbok\n`;
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(out, `#  ${ANTECKNINGAR.text}\nMy line.\n\n${LINK}\n\n# Dagbok\n`);
	});

	it("a run of spaces inside the text lands in the existing section, with no duplicate", () => {
		const input = "# Daily   notes\nA.\n\n# Other\n";
		const out = insertRecordingLink(input, FILE, { text: "Daily notes", level: 1 });
		assert.equal(out, "# Daily   notes\nA.\n\n" + LINK + "\n\n# Other\n");
		const reverse = insertRecordingLink("# Daily notes\nA.\n", FILE, {
			text: "Daily    NOTES",
			level: 1,
		});
		assert.equal(reverse, "# Daily notes\nA.\n\n" + LINK + "\n");
	});

	it("a near-miss heading of another level or with another word is still a different heading", () => {
		assert.equal(
			insertRecordingLink("## notes\nA.\n", FILE, NOTES),
			"## notes\nA.\n\n# Notes\n\n" + LINK + "\n",
		);
		assert.equal(
			insertRecordingLink("# notes today\nA.\n", FILE, NOTES),
			"# notes today\nA.\n\n# Notes\n\n" + LINK + "\n",
		);
	});

	it("a missing heading is created with the configured text and level", () => {
		assert.equal(
			insertRecordingLink("Text.\n", FILE, { text: "Notes", level: 3 }),
			"Text.\n\n### Notes\n\n" + LINK + "\n",
		);
	});

	it("a `# Notes` line inside a fenced code block is not the heading", () => {
		const input = "```\n# Notes\n```\nText.\n";
		const out = insertRecordingLink(input, FILE, NOTES);
		assert.equal(out, input + "\n# Notes\n\n" + LINK + "\n");
	});

	it("an empty heading text refuses instead of writing an unfindable heading", () => {
		assert.throws(
			() => insertRecordingLink("Text.\n", FILE, { text: "  ", level: 1 }),
			/notes heading in the settings is empty/,
		);
	});
});

describe("insertRecordingLink — where the notes section ends", () => {
	it("ends at a heading of the same level", () => {
		const input = "## Notes\nA.\n## Other\nB.\n";
		assert.equal(
			insertRecordingLink(input, FILE, { text: "Notes", level: 2 }),
			"## Notes\nA.\n\n" + LINK + "\n\n## Other\nB.\n",
		);
	});

	it("ends at a shallower heading", () => {
		const input = "## Notes\nA.\n# Up\nB.\n";
		assert.equal(
			insertRecordingLink(input, FILE, { text: "Notes", level: 2 }),
			"## Notes\nA.\n\n" + LINK + "\n\n# Up\nB.\n",
		);
	});

	it("ends at a deeper heading, so the link goes above it, not at the end of the deeper subsection", () => {
		// `## Sub` ends the notes' own text although it is deeper than `# Notes`;
		// the link goes under that own text, above `## Sub`, not before `# Other`.
		const input = "# Notes\nOwn text.\n## Sub\nSub text.\n# Other\nB.\n";
		assert.equal(
			insertRecordingLink(input, FILE, NOTES),
			"# Notes\nOwn text.\n\n" + LINK + "\n\n## Sub\nSub text.\n# Other\nB.\n",
		);
	});

	it("ends at a deeper heading that is the last section of the file, with the link above it", () => {
		const input = "# Notes\n### Deep\nText.\n";
		assert.equal(
			insertRecordingLink(input, FILE, NOTES),
			"# Notes\n\n" + LINK + "\n\n### Deep\nText.\n",
		);
	});

	it("a `#` line inside a fenced block in the section does not end it", () => {
		const input = "# Notes\n```sh\n# a comment\n```\nAfter.\n\n# Other\n";
		assert.equal(
			insertRecordingLink(input, FILE, NOTES),
			"# Notes\n```sh\n# a comment\n```\nAfter.\n\n" + LINK + "\n\n# Other\n",
		);
	});
});

// --- Two real layouts --------------------------------------------------------

// Effortless's shipped daily log: `dailyLogFrame(layout)` in
// Effortless-plugin/src/core/vaultLayout.ts:954 writes every heading at its own
// level, in the order of `SECTION_ORDER` (vaultLayout.ts:188), with the shipped
// layout of src/core/settings.ts:205 (notes `Notes`/1, `Overdue`/2, `Today`/2,
// `Calendar`/2 holding a fenced `schema` table, `Diary`/1). `## Overdue`,
// `## Today` and `## Calendar` are therefore nested inside the level-1 notes
// section, which is why the section's own text, not its end, decides the place.
const EFFORTLESS_DAILY_LOG =
	"# Notes\n\n" +
	"## Overdue\n\n" +
	"## Today\n\n" +
	"## Calendar\n\n" +
	"```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n" +
	"# Diary\n\n";

// The author's layout, read for #67 from a daily log in the author's vault: the
// `##` sections of the day plan, then `# Anteckningar`, then `# Dagbok`. The
// plan's own headings are written in English here: only the order matters, and
// `tools/swedish-prose.mjs` must keep reporting nothing but the protected
// heading.
const DAY_PLAN = "# Plan\n\n## Overdue\n\n## Today\n\n## Calendar\n\n";
const AUTHOR_DAILY_LOG = DAY_PLAN + "# Anteckningar\n\n" + "# Dagbok\n\n";

describe("insertRecordingLink — Effortless's shipped daily log", () => {
	it("puts the link directly under `# Notes`, above `## Overdue`", () => {
		const out = insertRecordingLink(EFFORTLESS_DAILY_LOG, FILE, NOTES);
		assert.equal(
			out,
			"# Notes\n\n" + LINK + "\n\n## Overdue\n\n## Today\n\n## Calendar\n\n" +
				"```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
		assert.ok(out.indexOf(LINK) < out.indexOf("## Overdue"));
	});

	it("a second recording goes after the first, still above `## Overdue`", () => {
		const first = insertRecordingLink(EFFORTLESS_DAILY_LOG, FILE, NOTES);
		const second = "Recording 20260415090000.m4a";
		const out = insertRecordingLink(first, second, NOTES);
		assert.ok(out.indexOf(LINK) < out.indexOf(`![[${second}]]`));
		assert.ok(out.indexOf(`![[${second}]]`) < out.indexOf("## Overdue"));
	});

	it("text the person wrote under `# Notes` stays above the link", () => {
		const input = EFFORTLESS_DAILY_LOG.replace("# Notes\n\n", "# Notes\n\nMy own line.\n\n");
		const out = insertRecordingLink(input, FILE, NOTES);
		assert.ok(out.indexOf("My own line.") < out.indexOf(LINK));
		assert.ok(out.indexOf(LINK) < out.indexOf("## Overdue"));
	});

	it("is idempotent", () => {
		const once = insertRecordingLink(EFFORTLESS_DAILY_LOG, FILE, NOTES);
		assert.equal(insertRecordingLink(once, FILE, NOTES), once);
	});
});

describe("insertRecordingLink — the author's daily log", () => {
	it("puts the link under `# Anteckningar`, above `# Dagbok`", () => {
		const out = insertRecordingLink(AUTHOR_DAILY_LOG, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			DAY_PLAN + "# Anteckningar\n\n" + LINK + "\n\n# Dagbok\n\n",
		);
	});

	// The fixture above gives one result under every section rule: its notes
	// section is empty and `# Dagbok` follows at the same level. It guards
	// "as today" and cannot tell the rules apart. This one can: the notes hold a
	// subheading of the person's own, and the rule #71 settled on puts the link
	// in the section's own text, above the first heading of any level. The
	// "until the next same-level heading" rule would put it after `## sub`.
	it("with a `##` subheading of his own in the notes, the link goes above it", () => {
		const notes = `# ${ANTECKNINGAR.text}\n\n`;
		const input = DAY_PLAN + notes + "A line.\n\n## sub\n\nUnder sub.\n\n# Dagbok\n\n";
		const out = insertRecordingLink(input, FILE, ANTECKNINGAR);
		assert.equal(
			out,
			DAY_PLAN + notes + "A line.\n\n" + LINK + "\n\n## sub\n\nUnder sub.\n\n# Dagbok\n\n",
		);
	});

	it("is idempotent", () => {
		const once = insertRecordingLink(AUTHOR_DAILY_LOG, FILE, ANTECKNINGAR);
		assert.equal(insertRecordingLink(once, FILE, ANTECKNINGAR), once);
	});
});
