import { SECTION_HEADINGS, parseTranscriptNote, readString } from "./transcript-note";

/**
 * The language a transcript is written in, as an English name for the agent
 * request's language line, or `null` when the plugin does not know.
 *
 * `llama3.2` once answered a one-sentence Swedish recording in English although
 * the line said "the language the transcript is written in"; naming the
 * language outright gave Swedish 4 times in 4 (#170's probe). Sources, in order:
 *
 * 1. The note's `language` property, which the plugin writes when the language
 *    setting is not `detect`. A code the runtime cannot name counts as unknown.
 * 2. A language the transcriber reported: neither transcriber does. The service
 *    returns text only, and the on-device runner is told the language, never
 *    asked (`transcriber-service.ts`, `transcriber-on-device.ts`), so there is
 *    nothing to read.
 * 3. A guess from the transcript text. It places Swedish and nothing else:
 *    Swedish is the one language measured to drift, and a guess that names the
 *    wrong language is worse than the generic line, so every doubt falls back
 *    to the generic line. No dependency: counting a short list of function
 *    words that Swedish has and English does not.
 */
export function transcriptLanguage(transcriptNote: string): string | null {
	const note = parseTranscriptNote(transcriptNote);
	if (note === null) return null;
	const code = readString(note, "language")?.trim();
	if (code !== undefined && code !== "" && code !== "detect") {
		const named = nameOfCode(code);
		if (named !== null) return named;
	}
	return guessSwedish(transcriptOf(note.body)) ? "Swedish" : null;
}

function nameOfCode(code: string): string | null {
	try {
		const name = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code);
		return name === undefined || name === code ? null : name;
	} catch {
		// An invalid code is a note the plugin did not write; it is not a language.
		return null;
	}
}

/** The text under `## Transcript`: body text above that heading is dropped, so the note's own words never place the language. */
function transcriptOf(body: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => l.trimEnd() === SECTION_HEADINGS.transcript);
	return start === -1 ? body : lines.slice(start + 1).join("\n");
}

/** Swedish function words, one literal so the Swedish-prose checker can exempt this one data value. */
const SWEDISH_WORDS = new Set(
	"och det att är jag inte som på ett har med för till vi du så kan ska mig vad här då hade från eller bara också mycket alla ju".split(" "),
);

/**
 * Norwegian and Danish words Swedish does not have. They share many function words with
 * Swedish, so one of these in the text is a doubt, and a doubt falls back to the generic line.
 * (`er` is left out: it is a Swedish word too.)
 */
const NORWEGIAN_DANISH_WORDS = new Set(
	"jeg og at ikke ikkje eg noe hva fra vil også mye bare hvad meget".split(" "),
);

const ENGLISH_WORDS = new Set([
	"the", "and", "is", "of", "that", "it", "you", "was", "with", "this", "are", "have", "to", "for",
	"not", "but", "be", "on", "we", "will", "my",
]);

/**
 * Swedish when at least two of its function words appear, they outnumber English ones two to one,
 * and no Norwegian or Danish-only word appears.
 */
function guessSwedish(text: string): boolean {
	let swedish = 0;
	let english = 0;
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
		if (NORWEGIAN_DANISH_WORDS.has(word)) return false;
		if (SWEDISH_WORDS.has(word)) swedish++;
		else if (ENGLISH_WORDS.has(word)) english++;
	}
	return swedish >= 2 && swedish >= 2 * english;
}
