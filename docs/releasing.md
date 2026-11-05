# Releasing

The rules for cutting a release of Vault Recorder. Settled on #174, which carried them over from Effortless, published the same way from `nickdin/obsidian-effortless` a day earlier.

The tooling: `npm version` runs `version-bump.mjs`, which writes `manifest.json` and appends to `versions.json`, and `.github/workflows/release.yml` cuts a **draft** GitHub release on a pushed tag and refuses a tag that disagrees with the manifest. It runs the test suite before it builds, so a red suite stops the draft being cut at all — the tag is the one moment the plugin becomes installable, and every guard this repository has is a test. It then signs a provenance attestation for each of the three release files.

## The rule that constrains what a release may contain

**While the plugin has no way to speak to the user, a release must not require the user to do anything.** No re-entering a setting, no rebinding a hotkey, no manual step of any kind.

Obsidian shows a user a version number and an "Update" button and nothing else — no release notes, no changelog, no "what's new". So a release note reaches only the people who go to GitHub on purpose, and a required manual step shipped in one would silently break the vaults of everyone who did not. A settings change is therefore carried by the plugin itself, as `settings-migration.ts` carries the old Swedish keys, never by an instruction.

The constraint lifts when the plugin gains a way to tell the user something in-app. Until then, a change that would need a manual step is not ready to ship.

**A high-severity review finding does not stop a push to `main`, but it does stop a release.** Before tagging, list the open issues that a review filed as high severity, and either fix each one or name it in the release note.

## What makes a release due

**A change worth a stranger having.** Not a rhythm, not a filled bucket.

**The call is the author's alone.** Strangers can open issues on the public copy; a report is information and never a trigger.

**One carve-out:** a fix for something that loses a recording or damages a note ships on its own, immediately, without waiting to be worth anyone's while.

## What the numbers mean

The plugin ships at **0.1.0** and stays on 0.x.

`0.MINOR.PATCH`:

- **The leading 0 never moves.** It is not a placeholder waiting to be promoted — it is a continuous statement. Semantic Versioning's clause 4: *"Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable."* Moving it means making the opposite promise, and that promise is not one this plugin wants to make while features are still arriving.
- **The minor number carries anything a user would notice** — a new feature, changed behaviour, a reshaped settings screen, a change to the hand-off rule (`docs/hand-off-rule.md`), which programs written by other people implement.
- **The patch number is fixes only.**

**There is deliberately no trigger for 1.0**, and 0.x indefinitely is a fine outcome rather than a failure to finish. Nothing in Obsidian's submission rules or its scanner looks at the version number beyond `x.y.z` and the tag matching the manifest, and a large share of the community directory, some of its most-installed plugins among them, sits below 1.0. A later session must not invent a 1.0 milestone and start working towards it.

## `minAppVersion`

Today `1.11.4`, the floor `app.secretStorage` sets: it is Obsidian's Keychain, where a service transcriber's or agent's key is kept per device, and it does not exist in older Obsidian. An API newer than the floor is used only behind `requireApiVersion`, with a fallback for older Obsidian: `DataAdapter.appendBinary` (1.12.3), in the model download (`settings-models.ts`).

**It rises only when the plugin genuinely cannot work on the older version**, never for convenience. Raising it is invisible to the person it happens to: Obsidian silently stops offering them updates and leaves them on the last version that still fits, with no message. When it does rise, two things happen in the same commit — the reason goes in the release note, and `versions.json` gains the mapping, which is what leaves the stranded user a working older build instead of nothing.

## The public copy

**Every release is cut from an exported copy, never from the author's working repository.** That repository and its tracker stay private for good; the public repository, `nickdin/obsidian-vault-recorder`, is the release copy, and each release is exported into it. The export runs before every release:

1. `node tools/release-export/export-release.mjs <commit> <output-folder>`, with the commit to be released and a folder that does not exist yet. It copies the commit's shipped files, leaving out the working repository's record (`LEFT_OUT` in `tools/release-export/shipped.mjs` is the list; `docs/hand-off-rule.md` and `docs/hand-off-fixtures/` always ship, since they are the contract other programs implement); deletes every parenthesis that holds only tracker references; turns every remaining tracker link into a plain number; and adds a README paragraph saying what those numbers, and the left-out files the code cites, point at. Then it runs its gate (`tools/release-export/gate.mjs`), and writes nothing if the copy still holds a tracker link or a link into another private repository, the author's name outside `LICENSE` and `manifest.json`, the name of the author's vault or home server, or a folder of the author's vault, or holds a file that is not text, which the gate cannot read, unless that file is named in `NOT_TEXT_SHIPPED` beside `LEFT_OUT`.
2. In the output folder, `npm ci && npm run build && npm test && npm run lint` must all pass. Then build it a second time and compare `main.js`'s md5 with the first: the community directory's scanner rebuilds the plugin and compares `main.js` byte for byte, so a build that differs between two runs is not published.
3. Only then does the copy go to the public repository, where the tag is pushed and the release workflow cuts the draft. The copy replaces the whole tree of a fresh clone of that repository, so a file the export no longer ships is deleted there too, and lands as one commit per release, authored with GitHub's no-reply address so no private email address is published.
4. When the workflow has cut the draft, download its three files and check each one's provenance attestation: `gh release download <tag> -R nickdin/obsidian-vault-recorder` into an empty folder, then `gh attestation verify <file> -R nickdin/obsidian-vault-recorder` for `main.js`, `manifest.json` and `styles.css`. A file that fails is not published.

**A refusal is fixed here, in the source, and the export run again** — never by editing the output, which the next export would overwrite. The gate also runs over the working tree in the test suite (`tools/release-export/working-tree.test.mjs`), so a refusal on release day means a test here was already failing.

## Release notes

**Written into the GitHub draft release, in a few plain lines. No `CHANGELOG.md`** — a changelog file is a second copy of the same sentences that drifts out of step with the first.

The audience is the small number of people who look at the repository, and the author three months later working out when something changed. Per the rule at the top of this file, a release note can never be the only place something important is said.
