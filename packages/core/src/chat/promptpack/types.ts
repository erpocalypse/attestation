/** The PromptPack — all proprietary prompt CONTENT, supplied to the engine at
 *  runtime so the compiled assembler binary (and its published source) carry none
 *  of it. This is what makes PCR0 reproducible from the public mirror without
 *  leaking the jailbreak / canon / rubric: the binary measures pure logic, and the
 *  content arrives as data (the enclave receives it KMS-wrapped, attestation-gated
 *  to PCR0; the API installs the default at boot).
 *
 *  This interface is PUBLIC (types only — erased at compile time, no strings). The
 *  VALUES live in the private `default.ts`, which is excluded from the mirror and
 *  never imported by `bin/assemble.ts`.
 *
 *  It grows one stage at a time as more content is lifted out of the engine; every
 *  addition must keep the assembled bytes identical (golden-hash + binary-parity
 *  tests), since byte-identity is the DeepSeek prefix-cache lever. */
export interface PromptPack {
  /** Adult house preamble: permission to write consensual adult fiction + the
   *  anti-slop prose bar. Prepended to every adult chat's system prompt. */
  housePreamble: string;
  /** SFW counterpart, used until a user has attested 18+. */
  sfwPreamble: string;
  /** The always-on, bounded world frame for 1:1 character chats (WORLD_CORE). */
  worldCore: string;
  /** The full world bible injected into narrator (World) chats (WORLD_LORE). */
  worldLore: string;

  // === single-character path (assembly.ts) ===

  /** Name-free roleplay/format/embodiment instruction scaffold (ROLEPLAY_RULES). */
  roleplayRules: string;
  /** Adult content-capability line, gated on the user's 18+ attestation. */
  adultCapability: string;
  /** SFW content-capability line (the pre-attestation default). */
  sfwCapability: string;
  /** Terse restatement of the six bright-line content limits near generation. */
  absoluteLimits: string;
  /** Name-free narrator/format rules for World (narrator) chats. */
  worldNarratorRules: string;
  /** Narrator/format rules for a standalone (non-shared-canon) world: same craft
   *  as worldNarratorRules but framed on the world's own setting, not the shared
   *  Verge bible (BAC-143). */
  worldNarratorRulesNeutral: string;
  /** Difficulty-1..9 behavioural guidance, indexed 0..8 (no interpolation). */
  difficultyGuidance: string[];
  /** Terminal self-edit FINAL PASS for the single-character path. */
  charFinalPass: string;
  /** Terminal self-edit FINAL PASS for the World (narrator) path. */
  worldFinalPass: string;
  /** Premium relationship line. Tokens: {name}, {difficulty}, {difficultyGuidance}. */
  premiumRelationship: string;
  /** Premium intimacy line (tracks affection + difficulty). Token: {name}. */
  premiumIntimacy: string;
  /** Premium anti-bluff line (words are not deeds). Token: {name}. */
  premiumAntiBluff: string;
  /** Premium gift line. Tokens: {giftMarker}, {name}. */
  premiumGift: string;
  /** Scene-state gauge prefix. Tokens: {name}, {bucket}. */
  sceneGauge: string;
  /** Scene-state guard clause (gauge is not a story fact). Token: {name}. */
  sceneGuard: string;
  /** Scene-state difficulty-1 middle sentence. Token: {name}. */
  sceneDiff1Mid: string;
  /** Scene-state difficulty-1 closing clause. Token: {name}. */
  sceneDiff1End: string;
  /** Scene-state default (non-difficulty-1) closing clause. Token: {name}. */
  sceneDefaultEnd: string;
  /** Affection vibe labels, high→low (six buckets; no interpolation). */
  loveBuckets: string[];

  // === love/state scoring (scoring.ts) ===

  /** Scoring system-message lead, before the rules block. Plain. */
  scoringSystemLead: string;
  /** Scoring rules intro (rules[0]). Plain. */
  scoringRulesIntro: string;
  /** The scoring rubric ("Score the user's most recent move ..."). Plain. */
  scoringRubric: string;
  /** The scoring floor rule. Plain. */
  scoringFloorRule: string;
  /** JSON-spec opener (love + reason). Contains literal braces — never fill. */
  scoringJsonBase: string;
  /** JSON-spec actions fragment (adventure mode). Contains brackets — never fill. */
  scoringJsonActions: string;
  /** JSON-spec memory fragment (memory enabled). Contains quotes — never fill. */
  scoringJsonMemory: string;
  /** Adventure persona note. Tokens: {personaName}, {personaDescClause}. */
  scoringAdventurePersona: string;
  /** Adventure no-persona note. Plain. */
  scoringAdventureNoPersona: string;
  /** Adventure writing-voice mirroring directive. Plain. */
  scoringAdventureVoice: string;
  /** Data-section difficulty-1 scoring note. Plain. */
  scoringDifficulty1Note: string;
  /** Data-section note when the last action is a real paid gift. Plain. */
  scoringGiftNote: string;
  /** Data-section note when it is not a gift (ignore unbacked claims). Plain. */
  scoringNoGiftNote: string;

  // === rolling-summary / memory folds (summarize.ts) ===

  /** Legacy rolling-summary fold system message. Plain. */
  summarizeSystem: string;
  /** Chapter-fold system message. Plain. */
  chapterFoldSystem: string;
  /** Chapter roll-up system message. Plain. */
  rollupSystem: string;
  /** Fact-rescue system message. Tokens: {name}, {wordTarget}. */
  factRescueSystem: string;
}
