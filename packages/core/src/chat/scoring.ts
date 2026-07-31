/** Pure love/state SCORING prompt-builder + response-parser — the second-pass
 *  "computeState" logic, extracted so the API path and the attested enclave run
 *  ONE implementation (no Python re-port to drift, and the scoring request bytes
 *  stay identical so DeepSeek's prefix cache survives moving scoring in-enclave).
 *
 *  The NestJS ChatService keeps orchestration (endpoint resolution, fetch, cost
 *  metering, memory cadence); this module owns only the pure string work:
 *    - {@link buildScoringMessages}: ingredients → the OpenAI `messages` array.
 *    - {@link parseScoringResult}:   the model's JSON content → clamped state.
 *
 *  Plan-derived booleans + the transcript window size are passed IN as plain data
 *  (ScoringFeatures) — they are not private content, so the enclave receives them
 *  in the sealed bundle and the API computes them from PLAN_FEATURES/COST_PROFILES
 *  exactly as before. */
import { clampDifficulty } from "./difficulty";
import { difficultyGuidance, loreFacts, stripEmDash } from "./assembly";
import { extractIdentity } from "./identity";
import { pack, fill } from "./promptpack/active";
import { GIFT_MARKER, type ChatContext, type LoreInjection } from "./types";

/** Plan-gated knobs the scorer needs, resolved by the caller (API: PLAN_FEATURES
 *  + COST_PROFILES). Plain data so the enclave can receive them sealed. */
export interface ScoringFeatures {
  relationshipSystem: boolean;
  adventureMode: boolean;
  persistentMemory: boolean;
  difficultyCustom: boolean;
  /** Recent-transcript window size for the scorer (COST_PROFILES[plan].scoreWindow). */
  scoreWindow: number;
}

export interface ScoringInput {
  dto: ChatContext;
  feat: ScoringFeatures;
  reply: string;
  styleProfile?: string | null;
  lore?: LoreInjection;
}

/** Resolved scoring parameters shared by the request-builder and the parser
 *  (so the parser's clamping matches the prompt the model answered). */
interface ResolvedScoring {
  adventure: boolean;
  memoryEnabled: boolean;
  difficulty: number;
  isGift: boolean;
}

function resolve(input: ScoringInput): ResolvedScoring {
  const { dto, feat } = input;
  const requested = dto.options ?? {};
  const adventure = feat.adventureMode && requested.adventureMode === true;
  const memoryEnabled = feat.persistentMemory;
  const difficulty =
    feat.difficultyCustom && requested.difficulty !== undefined
      ? clampDifficulty(requested.difficulty)
      : clampDifficulty(dto.character.difficulty);
  const lastUser = [...dto.messages].reverse().find((m) => m.role === "user");
  const isGift = lastUser?.text.startsWith(GIFT_MARKER) ?? false;
  return { adventure, memoryEnabled, difficulty, isGift };
}

/** Build the OpenAI `messages` array for the love/state scoring call. Byte-for-byte
 *  identical to the body chat.service.ts previously built inline, so the prefix
 *  cache is unaffected by where this runs. Returns the messages + the resolved
 *  max_tokens (the only request param that varies). */
export function buildScoringMessages(input: ScoringInput): {
  messages: { role: "system" | "user"; content: string }[];
  maxTokens: number;
} {
  const { dto, feat } = input;
  const { adventure, memoryEnabled, difficulty, isGift } = resolve(input);
  const requested = dto.options ?? {};
  const priorMemory = requested.memory?.trim() ?? "";
  const love = requested.love ?? 0;
  const name = dto.character.name;
  const persona = dto.persona;
  const styleProfile = input.styleProfile;
  const lore = input.lore;
  const statedNames = [
    ...(persona?.name?.trim() ? [persona.name.trim()] : []),
    ...dto.messages
      .filter((m) => m.role === "user")
      .map((m) => extractIdentity(m.text)?.name)
      .filter((candidate): candidate is string => Boolean(candidate)),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  const userNameEvidence = statedNames.length
    ? `USER NAME EVIDENCE: The only supported user name${statedNames.length === 1 ? " is" : "s are"} ${statedNames.map((candidate) => JSON.stringify(candidate)).join(", ")}. A persona name or an explicit user-authored "my name is ..." / "call me ..." statement is evidence. No character reply is evidence.`
    : 'USER NAME EVIDENCE: None. The user has not explicitly supplied a name in the available persona or user-authored conversation. The memory must not name the user or claim they already disclosed a name.';

  const transcript = dto.messages
    .slice(-feat.scoreWindow)
    .map((m) => {
      const who = m.role === "char" ? name : "User";
      const text = m.text.startsWith(GIFT_MARKER)
        ? m.text.replace(GIFT_MARKER, "(gift)")
        : m.text;
      return `${who}: ${text.slice(0, 320)}`;
    })
    .join("\n");

  const scoredReply =
    adventure || memoryEnabled ? input.reply : input.reply.slice(0, 600);

  const rules = [
    pack().scoringRulesIntro,
    "",
    pack().scoringRubric,
    pack().scoringFloorRule,
    "",
    "Return ONLY a JSON object:",
    `${pack().scoringJsonBase}${adventure ? pack().scoringJsonActions : ""}${memoryEnabled ? pack().scoringJsonMemory : ""}}`,
    adventure
      ? persona?.name
        ? fill(pack().scoringAdventurePersona, {
            personaName: persona.name,
            personaDescClause: persona.description
              ? `, ${persona.description}`
              : "",
          })
        : pack().scoringAdventureNoPersona
      : "",
    adventure ? pack().scoringAdventureVoice : "",
  ]
    .filter(Boolean)
    .join("\n");

  const data = [
    `The character the user is talking to is named ${name}. Difficulty: ${difficulty}/9. ${difficultyGuidance(difficulty)}`,
    `${name}'s current affection toward the user is ${love}/100.`,
    difficulty === 1 ? pack().scoringDifficulty1Note : pack().scoringLowAffectionNote,
    "",
    "Recent conversation:",
    transcript,
    `${name} (just now): ${scoredReply}`,
    memoryEnabled ? userNameEvidence : "",
    memoryEnabled
      ? `\nPrior memory (${name}'s recollection of this user and what's happened between them) ${pack().scoringPriorMemoryFence}:\n${priorMemory || "(nothing yet)"}`
      : "",
    isGift ? pack().scoringGiftNote : pack().scoringNoGiftNote,
    adventure && (styleProfile || requested.styleSamples?.length)
      ? `\nThe user's writing voice, mirror it exactly in the options:${
          styleProfile ? `\nStyle: ${styleProfile}` : ""
        }${
          requested.styleSamples?.length
            ? `\nRecent real messages:\n${requested.styleSamples
                .map((s) => `"${s}"`)
                .join("\n")}`
            : ""
        }`
      : "",
    adventure && loreFacts(lore)
      ? `\nEstablished facts in play right now (keep the options consistent with these, and do not contradict or ignore them):\n${loreFacts(lore)}`
      : "",
    "",
    "Now return the JSON object exactly as specified.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    messages: [
      {
        role: "system",
        content: `${pack().scoringSystemLead}\n\n${rules}`,
      },
      { role: "user", content: data },
    ],
    maxTokens: memoryEnabled ? 420 : 240,
  };
}

/** The parsed, clamped scoring result (pre-cadence: the caller decides whether to
 *  persist `memory` on this turn). `memory` is the raw model proposal, undefined
 *  when memory isn't enabled or the model omitted it. */
export interface ScoringResult {
  love: number;
  actions: string[];
  reason: string;
  memory?: string;
}

/** Parse + clamp the model's JSON content into a scoring result, applying the
 *  same difficulty-1 floor, action stripping (em-dash), and length caps the API
 *  used inline. Returns null on unparseable/empty content. The MEMORY checkpoint
 *  cadence stays in the caller (it needs the turn count + prior memory). */
export function parseScoringResult(
  input: ScoringInput,
  content: string | null | undefined,
): ScoringResult | null {
  if (!content) return null;
  const { adventure, difficulty, isGift } = resolve(input);
  let parsed: { love?: unknown; actions?: unknown; reason?: unknown; memory?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  let love = Math.max(-10, Math.min(10, Math.round(Number(parsed.love) || 0)));
  if (difficulty === 1 && !isGift) love = Math.max(7, love);
  const actions =
    adventure && Array.isArray(parsed.actions)
      ? parsed.actions
          .map((a) => stripEmDash(String(a).trim()))
          .filter(Boolean)
          .slice(0, 4)
      : [];
  const reason =
    typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 80) : "";
  const memory =
    input.feat.persistentMemory && typeof parsed.memory === "string"
      ? parsed.memory.trim().slice(0, 600) || undefined
      : undefined;
  return { love, actions, reason, memory };
}
