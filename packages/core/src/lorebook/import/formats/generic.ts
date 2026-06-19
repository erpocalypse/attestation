/** Generic / native lorebook — the fallback. Covers our own export shape and the
 *  "simple array" form (`{ name, description, entries: [{ key, content }] }`):
 *  metadata at the top level, `entries` as an array. Registered last; its
 *  {@link FormatParser.detect | detect} accepts any object, so a blob that no
 *  earlier parser claimed lands here. If it turns out to carry no importable
 *  entries, {@link assembleBook} throws — that's the "not a lorebook" signal. */

import type { FormatParser, ImportedLorebook, ParseContext } from "../types";
import { assembleBook, isObject } from "../shared";

export const genericParser: FormatParser = {
  id: "generic",
  label: "Generic / native lorebook",

  detect(raw: unknown): boolean {
    return isObject(raw);
  },

  parse(raw: unknown, ctx: ParseContext): ImportedLorebook {
    return assembleBook(raw as Record<string, unknown>, ctx);
  },
};
