/** Lorebook import — public surface.
 *
 *  `parseImportedLorebook` is the entrypoint callers use (web `importLorebook…`,
 *  server-side reuse). The `FormatParser` contract + `FORMAT_PARSERS` registry
 *  are exported so the import system is open for extension: add a format by
 *  writing a parser under `./formats` and registering it in `registry.ts`. */

export type { ImportedLorebook, FormatParser, ParseContext } from "./types";
export { parseImportedLorebook, FORMAT_PARSERS } from "./registry";
export { characterCardParser } from "./formats/characterCard";
export { sillyTavernParser } from "./formats/sillyTavern";
export { genericParser } from "./formats/generic";
