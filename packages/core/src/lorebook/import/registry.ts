/** The format registry + the public import dispatcher.
 *
 *  To add a format: implement a {@link FormatParser} in `./formats/` and add it
 *  to {@link FORMAT_PARSERS} below — **before** the generic fallback, since that
 *  one claims every object. Order is "most specific first": the dispatcher hands
 *  the input to the first parser whose `detect` returns true. */

import { isObject } from "./shared";
import type { FormatParser, ImportedLorebook, ParseContext } from "./types";
import { characterCardParser } from "./formats/characterCard";
import { sillyTavernParser } from "./formats/sillyTavern";
import { genericParser } from "./formats/generic";

/** Registered parsers, most specific first. `genericParser` is the catch-all and
 *  must stay last. */
export const FORMAT_PARSERS: readonly FormatParser[] = [
  characterCardParser,
  sillyTavernParser,
  genericParser,
];

/** Parse arbitrary imported lorebook JSON into our shape. Throws if the input
 *  doesn't look like a lorebook at all (not an object, or no recognizable
 *  entries). `opts.makeId` lets the web inject a uuid generator; omitted, ids are
 *  deterministic (`imported-N`) for stable tests. */
export function parseImportedLorebook(
  raw: unknown,
  opts?: { makeId?: () => string },
): ImportedLorebook {
  if (!isObject(raw)) throw new Error("Unrecognized lorebook format.");

  const makeId = opts?.makeId;
  const ctx: ParseContext = {
    makeId: (i) => (makeId ? makeId() : `imported-${i}`),
  };

  for (const parser of FORMAT_PARSERS) {
    if (parser.detect(raw)) return parser.parse(raw, ctx);
  }
  // Unreachable while genericParser claims every object, but kept as a guard if
  // the registry is ever reordered.
  throw new Error("Unrecognized lorebook format.");
}
