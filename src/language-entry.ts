/**
 * What the "Language spoken in recordings" box saves.
 *
 * The saved value travels unchecked into every transcript note's `language`
 * property, from there to a hand-off transcriber, the on-device runner and the
 * agent request's language line (`transcriptLanguage`). A name such as `Swedish`
 * is a code to none of them, so it is turned into its code here, at the point of
 * entry, or refused. Both ends are the box's: nothing downstream accepts names.
 */

export type LanguageEntry = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Language names, lowercased, in English and in Swedish, to their codes.
 *
 * Built from `Intl.DisplayNames` at runtime, so no language's name is written in
 * this source. Every two-letter code the runtime names covers the languages
 * Whisper transcribes except the three-letter ones it adds (`haw`, `yue`), which
 * are listed. English names come first and keep a name both lists share. The code
 * a name maps to is never a deprecated alias (`iw` for `he`).
 */
export const LANGUAGE_NAME_CODES: ReadonlyMap<string, string> = buildNameTable();

function buildNameTable(): Map<string, string> {
	const table = new Map<string, string>();
	const codes: string[] = ["haw", "yue"];
	for (const first of "abcdefghijklmnopqrstuvwxyz") {
		for (const second of "abcdefghijklmnopqrstuvwxyz") codes.push(first + second);
	}
	for (const locale of ["en", "sv"]) {
		const names = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
		for (const code of codes) {
			if (!isCanonicalCode(code)) continue;
			const name = names.of(code);
			if (name === undefined || name === code) continue;
			const key = name.trim().toLocaleLowerCase(locale);
			if (!table.has(key)) table.set(key, code);
		}
	}
	return table;
}

function isCanonicalCode(code: string): boolean {
	try {
		return Intl.getCanonicalLocales(code)[0] === code;
	} catch {
		return false;
	}
}

/**
 * The codes the box saves: two letters, plus `haw` and `yue`, each one the runtime
 * names, so `transcriptLanguage` (`agent-language.ts`) can name it too. A region
 * tag or a three-letter alias such as `swe` is not among them.
 */
const SAVED_CODES: ReadonlySet<string> = buildCodeSet();

function buildCodeSet(): Set<string> {
	const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
	const codes = new Set<string>();
	for (const code of ["haw", "yue", ...twoLetterCodes()]) {
		const name = names.of(code);
		if (isCanonicalCode(code) && name !== undefined && name !== code) codes.add(code);
	}
	return codes;
}

function twoLetterCodes(): string[] {
	const codes: string[] = [];
	for (const first of "abcdefghijklmnopqrstuvwxyz") {
		for (const second of "abcdefghijklmnopqrstuvwxyz") codes.push(first + second);
	}
	return codes;
}

/** The language of a well-formed region or script tag (`sv-se` → `sv`), or undefined. */
function languageOfTag(code: string): string | undefined {
	if (!code.includes("-")) return undefined;
	try {
		Intl.getCanonicalLocales(code);
	} catch {
		return undefined;
	}
	return code.split("-")[0];
}

const REFUSAL =
	"Not understood. Type a language code such as 'sv', a language's name such as 'Swedish', or 'detect'.";

/** The value the box saves for what was typed, or why it is refused. */
export function parseLanguageEntry(typed: string): LanguageEntry {
	const text = typed.trim();
	if (text === "" || text.toLowerCase() === "detect") return { ok: true, value: "detect" };

	const fromName = LANGUAGE_NAME_CODES.get(text.toLocaleLowerCase("en")) ?? LANGUAGE_NAME_CODES.get(text.toLocaleLowerCase("sv"));
	if (fromName !== undefined) return { ok: true, value: fromName };

	const code = text.toLowerCase();
	if (SAVED_CODES.has(code)) return { ok: true, value: code };
	const language = languageOfTag(code);
	if (language !== undefined && SAVED_CODES.has(language)) return { ok: true, value: language };

	return { ok: false, reason: REFUSAL };
}
