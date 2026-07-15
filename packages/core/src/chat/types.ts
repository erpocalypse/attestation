/** Shared chat-domain data types + constants for the pure prompt-assembly code.
 *  These describe the *ingredients* of a turn (scene context, options, lore,
 *  message shape) with no NestJS / transport coupling, so the same assembly runs
 *  in the API and inside the attested enclave. Orchestration-only types
 *  (StreamMeta, ChatTarget) stay in the API's chat.service. */

/** The premium scene features actually in effect, after plan gating. */
export interface EffectiveOptions {
  relationship: boolean;
  adventure: boolean;
  /** 1 (falls easily) – 9 (brutal). */
  difficulty: number;
  love: number;
  /** The character's accumulated memory of this user, if any. */
  memory?: string;
  /** User-pinned, always-remember facts (Plus+). Authoritative durable context,
   *  never rewritten by the scorer's memory merge — distinct from {@link memory}.
   *  On the operator-blind path these arrive as DEK ciphertext and are decrypted
   *  in-enclave before assembly (mirrors `memory`/`globalPrompt` — BAC-100). */
  pins?: string[];
  /** Platform-level 18+ gate: the user has attested they are an adult. Explicit
   *  content is permitted only when true (not keyed off any per-character flag). */
  userAdult: boolean;
}

export interface Turn {
  role: "user" | "char";
  text: string;
  /** Optional turn kind (gift/pick/continue), carried ONLY on the operator-blind
   *  path where history rides as ciphertext: the enclave reads it to restore the
   *  GIFT_MARKER prefix before assembling (the API restores it from the row's
   *  `kind` on the plaintext path). The pure assembler ignores it, so prompt
   *  bytes are unchanged. */
  kind?: string | null;
}

/** Everything the chat prompt + scorer read, assembled server-side from the
 *  conversation row + character/persona records (the client no longer sends it).
 *  Mirrors the old request shape so the prompt-building internals are unchanged. */
export interface ChatContext {
  character: {
    name: string;
    tagline?: string;
    description?: string;
    personality?: string;
    /** Opening situation/setting (SillyTavern `scenario`). */
    scenario?: string;
    /** Example messages that steer the voice (SillyTavern `mes_example`). */
    exampleDialogue?: string;
    /** Server-distilled one-paragraph description of HOW the character speaks,
     *  derived from `exampleDialogue` at save time (BAC-195). Injected as a
     *  compact "Voice" header line; never author-editable. */
    voiceProfile?: string;
    /** Author-written standing instructions injected into the `system` message
     *  (per-character header, after Scenario) — not lorebook context. */
    systemPrompt?: string;
    nsfw?: boolean;
    difficulty?: number;
  };
  persona?: { name?: string; description?: string } | null;
  /** The user's authored "global prompt" — a standing instruction prepended into
   *  every chat. On the operator-blind path this arrives as DEK ciphertext and is
   *  decrypted in-enclave before assembly; blank/absent = none. Mirrors the API's
   *  direct-path ChatContext.globalPrompt so both paths build the same bytes. */
  globalPrompt?: string;
  options?: {
    adventureMode?: boolean;
    difficulty?: number;
    love?: number;
    memory?: string;
    styleSamples?: string[];
  };
  messages: Turn[];
  modelId?: string;
}

/** World (narrator) chat context, assembled server-side. */
export interface WorldContext {
  /** `sharedCanon` true = the one pre-seeded world that lives in the shared
   *  "Verge" bible: the narrator gets WORLD_LORE + the "region of the world
   *  above" framing. Every other world (default) runs purely on its own
   *  `setting`. Plain metadata (not a secret), shipped into the enclave as data
   *  — the assembly LOGIC change is what bumps PCR0, not this value (BAC-143). */
  world: { name: string; setting?: string; nsfw?: boolean; sharedCanon?: boolean };
  cast: {
    name: string;
    personality?: string;
    description?: string;
    scenario?: string;
    exampleDialogue?: string;
    /** See {@link ChatContext.character.voiceProfile}. */
    voiceProfile?: string;
  }[];
  persona?: { name?: string; description?: string } | null;
  /** See {@link ChatContext.globalPrompt}. Applied to world (narrator) chats too. */
  globalPrompt?: string;
  messages: Turn[];
  modelId?: string;
}

export interface ApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Lorebook text grouped by where it goes in the prompt. Built from the engine's
 *  (already-sorted) slots by {@link slotsToLoreInjection}. */
export interface LoreInjection {
  /** "Top of prompt" + folded "Author's note slot" entries. */
  top: string[];
  /** "After character profile" entries. */
  afterProfile: string[];
  /** "Inline with recent messages" — injected N turns back. */
  inline: { depth: number; text: string }[];
}

/** Prefix the web app stamps on a user turn that represents a *paid* gift. The
 *  model is told this marker can't be faked by typing — so a real (nectar-spent)
 *  gift lands, while someone typing "*offers a rose*" does not. Must stay in
 *  sync with the web app's GIFT_MARKER (apps/web/src/lib/scenes.ts). */
export const GIFT_MARKER = "[GIFT]";
