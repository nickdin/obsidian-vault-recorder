// Obsidian's own checker: the recommended rules of eslint-plugin-obsidianmd,
// which the community plugin directory's automated review runs.
// `npm run lint` runs it and fails on any error, so a regression shows on the
// next run rather than at submission. Every rule changed below says why beside
// it; the directory's review still runs its own copy of the rules, so a
// change here quiets this repository's run, not that review.
//
// `package.json`'s `overrides` hands the plugin this repository's own
// `obsidian` and `typescript` in place of the copies it pins. The `obsidian`
// one only settles its peer pin (1.8.7) against ours, so `npm ci` needs no
// `--legacy-peer-deps`. The `typescript` one is load-bearing: the plugin's
// `no-unsupported-api` rule reads the parser's syntax tree with its own
// `typescript`, and with a different version than the parser's the node kinds
// disagree, every declaration looks foreign, and the rule silently reports
// nothing — it then missed `appendBinary`, which needs Obsidian 1.12.3.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
// The rule's own list, which a `brands` option replaces rather than extends.
// Not exported from the package's entry, so imported by path; a release that
// moves it fails this file's import loudly.
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
	// Tests are not published, and the directory's scanner skips `*.test.*`;
	// `src/goldens/` holds their expected outputs. `tools/`, `scripts/`,
	// `docs/` and `.github/` are development tooling, notes and CI, run in
	// Node or read by people, never shipped; `.claude/` is agent tooling for
	// this repository; `build/` and `main.js` are build output.
	{
		ignores: [
			"node_modules/**",
			"main.js",
			"build/**",
			"src/**/*.test.ts",
			"src/goldens/**",
			"tools/**",
			"scripts/**",
			"docs/**",
			".claude/**",
			".github/**",
		],
	},
	...obsidianmd.configs.recommended,
	{ languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["*.mjs"] } } } },
	{
		files: ["src/**/*.ts"],
		rules: {
			// Proper names and literal values, not sentences. OpenAI is a brand;
			// Daily notes and Keychain are Obsidian's own names for its core
			// plugin and its settings section; Swedish is a language's name;
			// Authorization is the HTTP header's name. The default list's
			// "Cursor", an editor's name, is taken out: here it is the text
			// cursor, in "Record at the cursor". None is the transcriber list's
			// option, and "Record at the cursor in the active note" a command's
			// name, each quoted as it is shown. An address and YYYY-MM-DD are
			// written as they are typed, and the three placeholders are the
			// values the boxes take: a property name, the language keyword and
			// the model folder's default path.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					enforceCamelCaseLower: true,
					brands: [
						...DEFAULT_BRANDS.filter((brand) => brand !== "Cursor"),
						"OpenAI",
						"Daily notes",
						"Keychain",
						"Swedish",
						"Authorization",
					],
					ignoreWords: ["None"],
					ignoreRegex: [
						"YYYY-MM-DD",
						"https?://\\S+",
						"^participants$",
						"^detect$",
						"^vault-recorder/models$",
						'"Record at the cursor in the active note"',
					],
				},
			],
		},
	},
	{
		// The build scripts run in Node at build time and are never shipped.
		files: ["esbuild.config.mjs", "version-bump.mjs"],
		languageOptions: { globals: { process: "readonly" } },
		rules: { "obsidianmd/no-nodejs-modules": "off" },
	},
]);
