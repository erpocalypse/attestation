/** SillyTavern-style {{user}}/{{char}} substitution for character-authored
 *  text — the BASIC core variant (user/char + the single-brace `{user}` /
 *  `{char}` shorthands only). It exists so example-dialogue turns are
 *  substituted during ENCLAVE assembly too (BAC-195 — before that, the enclave
 *  left macros raw and blind chats showed the model literal `{{user}}` braces).
 *  The API keeps its own richer substituter (`apps/api/src/chat/macros.ts`:
 *  aliases + date/time macros) for the direct path; this core variant is
 *  deliberately minimal because everything the enclave substitutes must be
 *  derivable from the dto alone, deterministically (PCR0-measured code).
 *  See https://docs.sillytavern.app/usage/core-concepts/macros/ */
export interface MacroValues {
  /** What to put in place of {{user}} — the active persona name, or "You". */
  user: string;
  /** What to put in place of {{char}} — the character's name. */
  char: string;
}

// {{user}} / {{char}} canonical, plus the {user} / {char} shorthand. Leading
// brace required, the second brace on each side optional, inner whitespace
// tolerated, case-insensitive. Matched in one global pass so a replacement
// value that itself contains braces is never re-scanned.
const MACRO_PATTERN = /\{\{?\s*(user|char)\s*\}?\}/gi;

/** Replace every {{user}}/{{char}} (and {user}/{char}) token in `text`. Returns
 *  the input unchanged when it contains no tokens (the common case). */
export function substituteMacros(text: string, values: MacroValues): string {
  if (!text.includes("{")) return text;
  return text.replace(MACRO_PATTERN, (_match, key: string) =>
    key.toLowerCase() === "user" ? values.user : values.char,
  );
}

/** The default name to show for {{user}} when the user has no named persona.
 *  Mirrors how the prompt otherwise refers to an unnamed user ("you") while
 *  reading naturally at the start of a greeting sentence. */
export const DEFAULT_USER_MACRO = "You";

// A `{{user}}:` / `{{char}}:` speaker marker at the start of an example-dialogue
// line. Kept in sync with the marker regexes in assembly.ts's example parser.
const SPEAKER_MARKER = /^(\s*\{\{?\s*(?:user|char)\s*\}?\}\s*:\s?)/i;

/** Marker-preserving substitution for raw SillyTavern example dialogue
 *  (`mes_example`): substitutes macros in each line's CONTENT while leaving a
 *  leading `{{user}}:` / `{{char}}:` speaker marker intact, so the example
 *  parser (which assigns roles by matching those markers on the raw line) still
 *  works on the result. Used by the API to pre-substitute the exampleDialogue
 *  it ships to the enclave: an enclave built before BAC-195 parses the markers
 *  and shows clean content; one built after re-substitutes as a no-op. */
export function substituteExampleMacros(
  text: string,
  values: MacroValues,
): string {
  if (!text.includes("{")) return text;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(SPEAKER_MARKER);
      if (!m) return substituteMacros(line, values);
      return m[1] + substituteMacros(line.slice(m[1]!.length), values);
    })
    .join("\n");
}
