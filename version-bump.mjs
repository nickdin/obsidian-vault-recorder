// Run by `npm version`. Writes the new version into manifest.json, and records
// the app version it needs in versions.json so that a user on an older Obsidian
// is offered the newest release their app can still run.
//
// versions.json only needs a new entry when minAppVersion changes, so an entry
// that already exists is left alone.

import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	throw new Error("npm_package_version is not set; run this through `npm version`.");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
}
