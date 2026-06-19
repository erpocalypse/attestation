/** Shared building blocks for the format parsers.
 *
 *  Holds the low-level coercion/clamping primitives, the DTO-mirroring caps, and
 *  the dialect-tolerant per-entry normalizer. Parsers compose these; they don't
 *  re-implement field mapping. A genuinely exotic future format (different field
 *  names entirely, e.g. NovelAI's `text`/`displayName`) can skip
 *  {@link normalizeEntry} and build entries from the primitives directly. */

import {
  normalizeEntryPosition,
  type EntryPosition,
  type LorebookEntry,
  type SecondaryLogic,
} from "../types";
import type { ImportedLorebook, ParseContext } from "./types";

/** Mirrors the server DTO caps (apps/api/src/lorebooks/dto/*.ts). Clamping here
 *  guarantees an imported book passes the API's ValidationPipe — keep in sync if
 *  the DTO limits change. */
export const MAX_ENTRIES = 1000; // === MAX_ENTRIES_PER_BOOK
export const MAX_KEY = 4000;
export const MAX_CONTENT = 16000;
export const MAX_COMMENT = 200;
export const MAX_GROUP = 120;
export const MAX_NAME = 120;
export const MAX_DESC = 2000;

// ── small typed coercion helpers ─────────────────────────────────────────────

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
export function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Join a key field that may be an array (ST / char-card) or already a
 *  comma-separated string (ours) into our canonical comma string. A key with a
 *  literal comma will be re-split by the engine's `parseKeys` on read — the same
 *  limitation SillyTavern has, accepted here. */
export function toKeyString(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((k) => String(k).trim())
      .filter(Boolean)
      .join(", ");
  }
  if (typeof v === "string") return v.trim();
  return "";
}

// ── enum maps (verified against SillyTavern public/scripts/world-info.js) ─────

/** `world_info_position` → our EntryPosition (we collapse AN/EM slots to Top). */
const ST_POSITION: Record<number, EntryPosition> = {
  0: "Top of prompt", // before char defs
  1: "After character profile", // after char defs
  2: "Top of prompt", // author's note, top
  3: "Top of prompt", // author's note, bottom
  4: "Inline with recent messages", // at depth
  5: "Top of prompt", // before example messages
  6: "After character profile", // after example messages
  7: "After character profile", // outlet
};

/** Map any known position encoding to ours: SillyTavern's numeric slots,
 *  character-card's `before_char`/`after_char` strings, or our own/legacy
 *  position strings. */
export function mapPosition(v: unknown): EntryPosition {
  const n = num(v);
  if (n !== undefined) return ST_POSITION[n] ?? "After character profile";
  const s = str(v);
  if (s === "before_char") return "Top of prompt";
  if (s === "after_char") return "After character profile";
  if (s) return normalizeEntryPosition(s); // our own / legacy strings
  return "After character profile";
}

/** `world_info_logic` → our SecondaryLogic. */
const ST_LOGIC: Record<number, SecondaryLogic> = {
  0: "AND_ANY",
  1: "NOT_ALL",
  2: "NOT_ANY",
  3: "AND_ALL",
};
const VALID_LOGIC = new Set<string>(["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"]);

/** Map ST's numeric `selectiveLogic` or our string logic to our SecondaryLogic.
 *  Returns undefined for anything unrecognized. */
export function mapLogic(v: unknown): SecondaryLogic | undefined {
  const n = num(v);
  if (n !== undefined) return ST_LOGIC[n];
  const s = str(v);
  if (s && VALID_LOGIC.has(s)) return s as SecondaryLogic;
  return undefined;
}

// ── entries container ─────────────────────────────────────────────────────────

/** Pull the entry list out of a book root, whether `entries` is an array (simple
 *  / char-card) or an object keyed by uid (SillyTavern). */
export function entriesOf(root: Record<string, unknown>): unknown[] {
  const e = root.entries;
  if (Array.isArray(e)) return e;
  if (isObject(e)) return Object.values(e);
  return [];
}

// ── per-entry normalization ───────────────────────────────────────────────────

/** Normalize one raw entry into our {@link LorebookEntry}, or `undefined` to drop
 *  it (no trigger, no text, not always-on). Intentionally **dialect-tolerant**:
 *  it accepts SillyTavern field names (`keysecondary`, `selectiveLogic`,
 *  `excludeRecursion`, numeric `position`), character-card names (`keys`,
 *  `secondary_keys`, `insertion_order`, string `position`), and our own — because
 *  our on-disk shape descends from SillyTavern's. ST uses `null` to mean "inherit
 *  the book default", so only genuine booleans are copied through. */
export function normalizeEntry(raw: unknown, id: string): LorebookEntry | undefined {
  if (!isObject(raw)) return undefined;

  const key = clampStr(toKeyString(raw.key ?? raw.keys), MAX_KEY);
  const content = clampStr(str(raw.content) ?? "", MAX_CONTENT);
  const constant = bool(raw.constant) ?? false;
  // Nothing to import if there's no trigger, no text, and it isn't always-on.
  if (!key && !content && !constant) return undefined;

  const disable = bool(raw.disable);
  const enabled = disable !== undefined ? !disable : bool(raw.enabled) !== false;
  const order = num(raw.order) ?? num(raw.insertion_order) ?? 100;

  const entry: LorebookEntry = {
    id,
    enabled,
    constant,
    key,
    content,
    position: mapPosition(raw.position),
    order: Math.trunc(order),
    probability: clampNum(num(raw.probability) ?? 100, 0, 100),
  };

  const comment = str(raw.comment) ?? str(raw.name);
  if (comment) entry.comment = clampStr(comment, MAX_COMMENT);

  const secondary = toKeyString(raw.keysecondary ?? raw.secondary_keys);
  if (secondary) entry.secondaryKey = clampStr(secondary, MAX_KEY);
  const logic = mapLogic(raw.selectiveLogic ?? raw.secondaryLogic);
  if (logic) entry.secondaryLogic = logic;

  const depth = num(raw.depth);
  if (depth !== undefined) entry.depth = clampNum(depth, 0, 1000);

  // Per-entry override flags. ST uses `null` to mean "inherit book default", so
  // only copy genuine booleans through.
  const caseSensitive = bool(raw.caseSensitive ?? raw.case_sensitive);
  if (caseSensitive !== undefined) entry.caseSensitive = caseSensitive;
  const matchWholeWords = bool(raw.matchWholeWords);
  if (matchWholeWords !== undefined) entry.matchWholeWords = matchWholeWords;
  const nonRecursable = bool(raw.excludeRecursion);
  if (nonRecursable !== undefined) entry.nonRecursable = nonRecursable;
  const preventRecursion = bool(raw.preventRecursion);
  if (preventRecursion !== undefined) entry.preventRecursion = preventRecursion;
  const prioritize = bool(raw.groupOverride);
  if (prioritize !== undefined) entry.prioritizeInclusion = prioritize;
  const groupScoring = bool(raw.useGroupScoring);
  if (groupScoring !== undefined) entry.groupScoring = groupScoring;
  const vectorized = bool(raw.vectorized);
  if (vectorized !== undefined) entry.vectorized = vectorized;

  // `delayUntilRecursion` is a number in recent ST, a boolean in older exports.
  const dur = num(raw.delayUntilRecursion);
  if (dur !== undefined) entry.delayUntilRecursion = clampNum(dur, 0, 100);
  else if (raw.delayUntilRecursion === true) entry.delayUntilRecursion = 1;

  const sticky = num(raw.sticky);
  if (sticky !== undefined) entry.sticky = clampNum(sticky, 0, 100000);
  const cooldown = num(raw.cooldown);
  if (cooldown !== undefined) entry.cooldown = clampNum(cooldown, 0, 100000);
  const delay = num(raw.delay);
  if (delay !== undefined) entry.delay = clampNum(delay, 0, 100000);

  const group = str(raw.group);
  if (group) entry.group = clampStr(group, MAX_GROUP);
  const groupWeight = num(raw.groupWeight);
  if (groupWeight !== undefined) entry.groupWeight = clampNum(groupWeight, 0, 100000);

  return entry;
}

// ── book assembly ─────────────────────────────────────────────────────────────

/** Build the normalized book from an already-resolved root (the object holding
 *  `name`/`description`/`entries`). Shared by the parsers whose entries map
 *  through {@link normalizeEntry}. Throws if the root carries no importable
 *  entries — the signal that this blob wasn't really a lorebook after all. */
export function assembleBook(
  root: Record<string, unknown>,
  ctx: ParseContext,
): ImportedLorebook {
  const rawEntries = entriesOf(root);
  if (rawEntries.length === 0) {
    throw new Error("Unrecognized lorebook format: no entries found.");
  }

  const entries: LorebookEntry[] = [];
  // Mint an id per raw index (even for dropped rows) so an injected uuid
  // generator advances in lockstep with the source, matching legacy behavior.
  for (let i = 0; i < rawEntries.length && entries.length < MAX_ENTRIES; i++) {
    const entry = normalizeEntry(rawEntries[i], ctx.makeId(i));
    if (entry) entries.push(entry);
  }

  const name =
    clampStr((str(root.name) ?? "").trim(), MAX_NAME) || "Imported lorebook";
  const desc = str(root.description)?.trim();

  return {
    name,
    description: desc ? clampStr(desc, MAX_DESC) : undefined,
    entries,
  };
}
