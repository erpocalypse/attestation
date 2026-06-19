import type {
  AttachOwnerKind,
  AttachmentSnapshot,
  EntryPosition,
  Lorebook,
  LorebookEntry,
  MatchSource,
  TriggerType,
} from "../types";

export type EngineTier =
  | "scene"
  | "persona"
  | "character"
  | "world-character"
  | "world-persona"
  | "global";

/** Lightweight slices of upstream types — the engine doesn't need full
 *  Persona/Character interfaces, just a few fields. Keeps the engine
 *  decoupled from frontend stores so it can move server-side later. */
export interface ChatMessageLite {
  role: "char" | "user" | "system" | string;
  text: string;
  /** Optional speaker name — when present and Include Names is on, prepended. */
  name?: string;
}

export interface CharacterLite {
  id: string;
  name?: string;
  description?: string;
  personality?: string;
  characterNote?: string;
  scenario?: string;
  worldId?: string;
  tags?: string[];
}

export interface PersonaLite {
  id: string;
  name?: string;
  description?: string;
  worldId?: string;
}

export interface SceneLite {
  id: string;
  messages: ChatMessageLite[];
}

/** Per-chat state that persists across calls so sticky / cooldown work. */
export interface ChatLorebookState {
  /** entryId -> message index at which the sticky window expires */
  stickyUntil?: Record<string, number>;
  /** entryId -> message index at which the entry can fire again */
  cooldownUntil?: Record<string, number>;
}

export interface AssembleInput {
  scene: SceneLite;
  character: CharacterLite;
  /** World chats have no single character: the engine is fed a synthetic
   *  world-keyed `character` (for book collection), and the real cast comes
   *  through here. Cast text is folded into the description/personality/scenario/
   *  characterNote scan buffers so an entry can match against any cast member.
   *  Empty/absent for single-character chats (buffers stay byte-identical). */
  cast?: CharacterLite[];
  persona: PersonaLite;
  lorebooks: Lorebook[];
  attachments: AttachmentSnapshot;
  /** Optional state from a previous assembleContext call, persisted on the scene. */
  prevState?: ChatLorebookState;
  triggerType?: TriggerType;
  /** Absolute token budget for lorebook content. Default 1024. */
  budgetTokens?: number;
  /** Alternative: percent of caller-provided context size. */
  budgetPercent?: number;
  /** Caller's total context size (only used with budgetPercent). */
  contextTokens?: number;
  /** Optional seed for deterministic probability rolls (replay/testing). */
  seed?: number;
  /** Whether to prepend speaker names in the scan buffer (default false). */
  includeNames?: boolean;
  /** Max recursion passes. Default 3. Set to 1 to disable recursion. */
  maxRecursionSteps?: number;
}

export interface ContextSlot {
  position: EntryPosition;
  depth?: number;
  order: number;
  text: string;
  entryId: string;
  source: { kind: AttachOwnerKind | "world" | "global"; id: string };
  tier: EngineTier;
}

export type DropReason =
  | "disabled"
  | "no-match"
  | "trigger-type"
  | "character-filter"
  | "probability"
  | "delay"
  | "cooldown"
  | "group-loser"
  | "budget"
  | "vector-stub"
  | "recursion-level";

export interface TraceEntry {
  entryId: string;
  bookId: string;
  tier: EngineTier;
  activated: boolean;
  reason?: DropReason;
  matchedKeys?: string[];
  recursionLevel?: number;
}

export interface AssemblyTrace {
  candidates: number;
  considered: TraceEntry[];
  recursionPasses: number;
  tokensUsed: number;
  budgetTokens: number;
}

export interface AssembledContext {
  slots: ContextSlot[];
  nextChatState: ChatLorebookState;
  debug: AssemblyTrace;
}

/** Internal: an entry pinned with its origin info as it flows through the pipeline. */
export interface CandidateEntry {
  entry: LorebookEntry;
  book: Lorebook;
  tier: EngineTier;
  source: ContextSlot["source"];
}

/** Internal: a candidate that has been matched against the scan buffer. */
export interface MatchedEntry extends CandidateEntry {
  matchedKeys: string[];
  /** Recursion pass at which this entry activated. 0 = direct chat match. */
  recursionLevel: number;
  /** Surfaced for budget/inclusion-group ordering. */
  effectiveOrder: number;
}

export const ALL_MATCH_SOURCES: readonly MatchSource[] = [
  "messages",
  "description",
  "personality",
  "scenario",
  "personaDesc",
  "characterNote",
] as const;
