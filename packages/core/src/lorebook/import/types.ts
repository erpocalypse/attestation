/** Public contract for the lorebook import system.
 *
 *  Importing is a registry of {@link FormatParser}s. Each parser owns one
 *  external file format: it cheaply {@link FormatParser.detect | detects} whether
 *  a blob is its shape, then {@link FormatParser.parse | parses} it into our
 *  normalized {@link ImportedLorebook}. The dispatcher
 *  (`parseImportedLorebook`) walks the registry in order and hands the input to
 *  the first parser that claims it.
 *
 *  Adding a format is a one-file change: write a `FormatParser` and register it
 *  in `registry.ts`. Nothing else in the import path — or any caller — changes. */

import type { LorebookEntry } from "../types";

/** The normalized result every parser produces: book metadata plus our
 *  canonical entries, already clamped to the server DTO caps. */
export interface ImportedLorebook {
  name: string;
  description?: string;
  entries: LorebookEntry[];
}

/** Per-parse services handed to each parser. Kept as a struct (rather than loose
 *  args) so it can grow — e.g. a warnings sink, or source filename — without
 *  touching every parser signature. */
export interface ParseContext {
  /** Mint a stable id for the entry at raw index `index`. The web injects a uuid
   *  generator; the default is deterministic (`imported-N`) for stable tests. */
  makeId(index: number): string;
}

/** A pluggable importer for one external lorebook file format.
 *
 *  Implementations must be pure and dependency-free so the whole import path
 *  stays unit-testable and reusable server-side. */
export interface FormatParser {
  /** Stable, machine id for diagnostics/telemetry, e.g. `"sillytavern"`. */
  readonly id: string;
  /** Human-readable label, e.g. `"SillyTavern World Info"`. */
  readonly label: string;
  /** Cheap structural sniff: does this blob look like our format? Must not throw
   *  and must be side-effect free — the registry calls it on every candidate, in
   *  order, and hands the first match to {@link parse}. */
  detect(raw: unknown): boolean;
  /** Convert recognized input into our normalized shape. May assume
   *  {@link detect} returned true. Throws only on input that looked like this
   *  format but carried no importable entries. */
  parse(raw: unknown, ctx: ParseContext): ImportedLorebook;
}
