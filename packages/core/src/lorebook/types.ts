/** Lorebook domain types — shared by the web editor and the server-side
 *  assembly engine. Pure data shapes only; no runtime/store/Solid coupling, so
 *  this module is safe to import from both `apps/web` and `apps/api`. */

/** Legacy: the original scope tag. Newer code uses world membership + the
 *  attachment store to determine where a lorebook is active. Kept on the type
 *  so old localStorage payloads still parse, but no longer surfaced in UI. */
export type LorebookScope = "Global" | "Character" | "Private";
export const LOREBOOK_SCOPES: LorebookScope[] = ["Global", "Character", "Private"];

export type EntryPosition =
  | "Top of prompt"
  | "After character profile"
  | "Inline with recent messages"
  | "Author's note slot";

/** Positions offered in the entry editor. "Author's note slot" stays on the
 *  type (and in {@link POSITION_DESC}) so older stored entries still parse, but
 *  it's no longer a selectable option — it was a non-functional placeholder.
 *  Any entry still carrying it is treated as "Top of prompt" by the engine. */
export const ENTRY_POSITIONS: EntryPosition[] = [
  "Top of prompt",
  "After character profile",
  "Inline with recent messages",
];

/** Maps retired/legacy stored position strings onto a currently-valid
 *  {@link EntryPosition}. "Author's note slot" was a non-functional placeholder,
 *  so it folds to the real Top position. */
const POSITION_LEGACY: Record<string, EntryPosition> = {
  "Before character defs": "Top of prompt",
  "After character defs": "After character profile",
  "At depth": "Inline with recent messages",
  "Author's note slot": "Top of prompt",
};

/** Coerce any stored/legacy position string into a valid, selectable
 *  {@link EntryPosition}. Falls back to the default "After character profile". */
export function normalizeEntryPosition(p: string | undefined): EntryPosition {
  if (p && POSITION_LEGACY[p]) return POSITION_LEGACY[p];
  if (p && (ENTRY_POSITIONS as string[]).includes(p)) return p as EntryPosition;
  return "After character profile";
}

export const POSITION_DESC: Record<EntryPosition, string> = {
  "Top of prompt":
    "Sits at the very start — best for world rules, setting, big-picture facts.",
  "After character profile":
    "Follows the character description — character-specific facts (default).",
  "Inline with recent messages":
    "Slots into the chat history near the latest messages — for here-and-now context.",
  "Author's note slot":
    "Retired — behaves like 'Top of prompt'.",
};

export type SecondaryLogic = "AND_ANY" | "AND_ALL" | "NOT_ANY" | "NOT_ALL";

export type TriggerType =
  | "normal"
  | "continue"
  | "impersonate"
  | "swipe"
  | "regenerate";

export type MatchSource =
  | "messages"
  | "description"
  | "personality"
  | "scenario"
  | "personaDesc"
  | "characterNote";

export interface CharacterFilter {
  mode: "include" | "exclude";
  ids: string[];
}

export interface LorebookEntry {
  // ── Visible by default ──────────────────────────────────────────────────
  id: string;
  enabled: boolean;
  /** Always-on: skips key matching and inserts every turn (🔵 in ST). */
  constant: boolean;
  /** Comma-separated primary trigger keys. Regex tokens delimited by `/…/flags`. */
  key: string;
  content: string;
  /** Memo / title — never sent to the AI, just labels the entry in the editor. */
  comment?: string;
  position: EntryPosition;
  /** Only meaningful when position === "Inline with recent messages". */
  depth?: number;
  /** Insertion order. Higher = closer to the end of the context = more impact. */
  order: number;
  /** 0..100. Roll once per activation; 100 = always, 0 = never. */
  probability: number;

  // ── Advanced (hidden behind a disclosure in the editor) ─────────────────
  /** Comma-separated secondary keys evaluated with `secondaryLogic`. */
  secondaryKey?: string;
  secondaryLogic?: SecondaryLogic;
  /** Per-entry overrides for the book-level defaults. */
  caseSensitive?: boolean;
  matchWholeWords?: boolean;

  // Recursion controls
  /** Cannot be activated *by* other entries' content (only direct chat match). */
  nonRecursable?: boolean;
  /** Activating this entry does NOT inject its content into recursion scans. */
  preventRecursion?: boolean;
  /** 0 = no delay. N = entry only becomes eligible at recursion level >= N. */
  delayUntilRecursion?: number;

  // Stateful (per-chat)
  /** Remain active for N messages after first triggering, ignoring probability. */
  sticky?: number;
  /** Cannot re-trigger for N messages after triggering. */
  cooldown?: number;
  /** Requires at least N messages in the chat before becoming eligible. */
  delay?: number;

  // Inclusion groups
  /** Group name — only one entry per group activates per turn. */
  group?: string;
  /** Weight for random picking within a group. Default 100. */
  groupWeight?: number;
  /** When true, pick the entry with the most matched keys instead of weighted random. */
  groupScoring?: boolean;
  /** When true, pick deterministically by highest `order` instead of rolling. */
  prioritizeInclusion?: boolean;

  // Filters
  characterFilter?: CharacterFilter;
  /** If set, entry only activates for these generation types. Empty = all. */
  triggerTypes?: TriggerType[];
  /** Which buffers to scan against. Default ["messages"]. */
  matchSources?: MatchSource[];

  /** Vector search opt-in. Engine returns false until embeddings are wired. */
  vectorized?: boolean;
}

export interface Lorebook {
  id: string;
  name: string;
  description?: string;
  /** Optional world this book lives inside. Undefined = "No world". */
  worldId?: string;
  /** Legacy scope tag, retained so old payloads round-trip without loss. */
  scope: LorebookScope;
  entries: LorebookEntry[];
  /** Book-level scan defaults (overridable per entry). */
  scanDepth: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  recursive: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Attachments ────────────────────────────────────────────────────────────

/** What kind of thing a lorebook can be attached to.
 *  - `persona` — active when the persona is in use
 *  - `character` — active when the character is the chat partner
 *  - `scene`    — chat-scoped: active only in that one scene */
export type AttachOwnerKind = "persona" | "character" | "scene";

export interface LorebookAttachment {
  lorebookId: string;
  /** Exactly 0 or 1 attachments per owner has `primary: true`. The primary book
   *  is the only one exported with a character card (parity with SillyTavern). */
  primary: boolean;
  /** Tiebreaker among auxiliaries — lower is earlier. Default 100. */
  order: number;
}

/** A flat picture of every attachment link, keyed by `${kind}:${ownerId}`. The
 *  engine reads this directly; the web builds it from its signal store and the
 *  server builds it from DB rows. */
export interface AttachmentSnapshot {
  byOwner: Record<string, LorebookAttachment[]>;
}

/** Canonical key for the attachment map. */
export function attachmentKey(kind: AttachOwnerKind, ownerId: string): string {
  return `${kind}:${ownerId}`;
}

/** Read the attachments for an owner out of a snapshot, in display order:
 *  primary first, then auxiliaries by `order` ascending. */
export function snapshotAttachmentsFor(
  snapshot: AttachmentSnapshot,
  kind: AttachOwnerKind,
  ownerId: string,
): LorebookAttachment[] {
  const list = snapshot.byOwner[attachmentKey(kind, ownerId)] ?? [];
  return [...list].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.order - b.order;
  });
}
