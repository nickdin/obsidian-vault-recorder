import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Removal trashes through the `VaultPort.trash` of `obsidian-ports.ts`, and Obsidian decides there, from
// its "Deleted files" setting (system trash, the vault's `.trash` folder, or delete permanently), where a
// file goes. Node cannot load Obsidian, so what is checked here is the route: the one call that follows
// the setting is the only way the plugin deletes anything. The three settings themselves are driven in
// the test Obsidian (`docs/acceptance-shots/issue-165-trash-settings.txt`).

const SRC = import.meta.dirname;
const sources = readdirSync(SRC)
	.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
	.map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

// Each of these deletes or trashes by a rule of its own and ignores the user's setting.
const BYPASSES = [
	/\bvault\.delete\(/,
	/\bapp\.vault\.trash\(/,
	/\badapter\.(?:remove|rmdir|trashSystem|trashLocal)\(/,
	/\bfileManager\.(?!trashFile\()\w*(?:delete|remove)\w*\(/i,
];

describe("how the plugin deletes a file", () => {
	it("uses Obsidian's own trash call, which follows the user's setting", () => {
		const ports = sources.find((s) => s.name === "obsidian-ports.ts");
		assert.ok(ports);
		assert.match(ports.text, /app\.fileManager\.trashFile\(/);
		// `vault.trash(file, system)` takes the choice as an argument: a wrapper over it would be the plugin's own rule.
		assert.doesNotMatch(ports.text, /\bvault\.trash\(/);
	});

	it("never deletes by a call that ignores the setting", () => {
		// `settings-models.ts` removes the plugin's own downloaded model files from its folder: not a note, not a recording.
		for (const { name, text } of sources.filter((s) => s.name !== "settings-models.ts")) {
			for (const bypass of BYPASSES) {
				assert.doesNotMatch(text, bypass, `${name} deletes by ${bypass}`);
			}
		}
	});
});
