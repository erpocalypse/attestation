/** Character-card V2/V3 — the lorebook embedded in a character card under
 *  `data.character_book` (V2/V3) or a top-level `character_book`. We unwrap to
 *  that inner book and read its metadata + entries (char-card field names like
 *  `keys`, `secondary_keys`, `insertion_order`, and `before_char`/`after_char`
 *  positions are handled by the shared normalizer). */

import type { FormatParser, ImportedLorebook, ParseContext } from "../types";
import { assembleBook, isObject } from "../shared";

/** Resolve the embedded book, or undefined if this isn't a character card. */
function characterBook(raw: unknown): Record<string, unknown> | undefined {
  if (!isObject(raw)) return undefined;
  if (isObject(raw.data) && isObject(raw.data.character_book)) {
    return raw.data.character_book;
  }
  if (isObject(raw.character_book)) return raw.character_book;
  return undefined;
}

export const characterCardParser: FormatParser = {
  id: "character-card",
  label: "Character card (V2/V3 character_book)",

  detect(raw: unknown): boolean {
    return characterBook(raw) !== undefined;
  },

  parse(raw: unknown, ctx: ParseContext): ImportedLorebook {
    // detect() guarantees this resolves; `?? {}` only narrows the type.
    return assembleBook(characterBook(raw) ?? {}, ctx);
  },
};
