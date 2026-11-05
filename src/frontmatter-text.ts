/**
 * A frontmatter value as text, for a property this plugin reads as one line
 * (`audio-deleted`, or each entry of a list property). Obsidian hands
 * frontmatter over as parsed YAML, so a value typed by hand can be a number, a
 * true/false, a list or a map rather than the text this plugin writes. A plain
 * value reads as itself; a list or a map reads as its JSON, which shows what is
 * there, where `String` would give `[object Object]` for a map.
 */
export function frontmatterText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return String(value);
	}
	return JSON.stringify(value);
}
