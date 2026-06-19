/** SillyTavern World Info export. Its hallmark is `entries` as an **object keyed
 *  by uid** (`{ "0": {…}, "1": {…} }`) rather than an array, plus ST conventions
 *  the shared normalizer already understands: numeric `position`/`selectiveLogic`,
 *  `keysecondary`, and `disable` as the inverse of `enabled`. Book metadata sits
 *  at the top level, so the root is the blob itself. */

import type { FormatParser, ImportedLorebook, ParseContext } from "../types";
import { assembleBook, isObject } from "../shared";

export const sillyTavernParser: FormatParser = {
  id: "sillytavern",
  label: "SillyTavern World Info",

  detect(raw: unknown): boolean {
    return isObject(raw) && isObject(raw.entries) && !Array.isArray(raw.entries);
  },

  parse(raw: unknown, ctx: ParseContext): ImportedLorebook {
    return assembleBook(raw as Record<string, unknown>, ctx);
  },
};
