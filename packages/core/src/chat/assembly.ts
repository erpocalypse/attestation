/** Pure prompt assembly for platform chat — extracted verbatim from the API's
 *  chat.service so the EXACT same bytes are produced whether the prompt is built
 *  in the API (BYOK / direct path) or inside the attested enclave (operator-blind
 *  path). Byte-identity is load-bearing: it preserves DeepSeek's prefix cache (a
 *  ~50× cost lever). A golden snapshot test (assembly.test.ts) freezes the output
 *  hash; do not edit these strings without updating it deliberately. */
import type { ContextSlot } from "../lorebook";
import { pack, fill } from "./promptpack/active";
import { clampDifficulty } from "./difficulty";
import { DEFAULT_USER_MACRO, substituteMacros } from "./macros";
import {
  GIFT_MARKER,
  type ApiMessage,
  type ChatContext,
  type EffectiveOptions,
  type LoreInjection,
  type Turn,
  type WorldContext,
} from "./types";

/** Map a 1–9 difficulty to behavioural guidance for the model. The scale runs
 *  from "instantly available" (1) to "practically celibate" (9). */
export function difficultyGuidance(n: number): string {
  return pack().difficultyGuidance[clampDifficulty(n) - 1]!;
}

/** The fully static, name-free single-character scaffold: shared world canon +
 *  roleplay rules + format + content capability + hard limits. Two frozen
 *  variants (adult / SFW) so each is a single, long, cohort-shared cache prefix.
 *  Composed per call now (the world canon + name-free rules/limits all come from
 *  the runtime PromptPack so the binary carries no proprietary strings), but the
 *  result is byte-identical to the old module-load constant — only the timing of
 *  the string join changed. */
function scaffoldAdult(): string {
  return [
    pack().roleplayRules,
    "",
    pack().adultCapability,
    "",
    pack().absoluteLimits,
  ].join("\n");
}
function scaffoldSfw(): string {
  return [
    pack().roleplayRules,
    "",
    pack().sfwCapability,
    "",
    pack().absoluteLimits,
  ].join("\n");
}

/** The fully static, world-agnostic scaffold for narrator chats: the full world
 *  bible + name-free narrator rules. Composed per call (both the bible and the
 *  rules come from the runtime PromptPack so the binary carries no proprietary
 *  strings), byte-identical to the old module-load constant. */
function worldScaffold(): string {
  return [pack().worldLore, "", pack().worldNarratorRules].join("\n");
}

/** Narrator scaffold for a standalone world (the default): just the neutral
 *  narrator rules, NO shared Verge bible — the world's own `setting` is the sole
 *  canon, injected after. Used for every world EXCEPT the pre-seeded shared-canon
 *  (Verge) world (BAC-143). */
function worldScaffoldNeutral(): string {
  return pack().worldNarratorRulesNeutral;
}

/** Hard ceiling on injected lorebook text (the engine's token budget runs on the
 *  client-owned data too, so the server caps independently). Slots arrive
 *  pre-sorted most-impactful first within each bucket, so trimming the tail
 *  drops the least important. */
const LORE_TOTAL_CHAR_CAP = 6000;

export function slotsToLoreInjection(slots: ContextSlot[]): LoreInjection {
  const lore: LoreInjection = { top: [], afterProfile: [], inline: [] };
  let used = 0;
  for (const s of slots) {
    const text = s.text?.trim();
    if (!text) continue;
    if (used + text.length > LORE_TOTAL_CHAR_CAP) break;
    used += text.length;
    if (s.position === "After character profile") lore.afterProfile.push(text);
    else if (s.position === "Inline with recent messages")
      lore.inline.push({ depth: s.depth ?? 4, text });
    else lore.top.push(text); // "Top of prompt" + folded "Author's note slot"
  }
  return lore;
}

/** Flatten an injection into one plain facts block (all positions, in prompt
 *  order). Used to ground option generation — placement doesn't matter there,
 *  only the content does. Returns "" when there's nothing to inject. */
export function loreFacts(lore?: LoreInjection): string {
  if (!lore) return "";
  return [...lore.top, ...lore.afterProfile, ...lore.inline.map((i) => i.text)]
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n");
}

/** Build the in-character system prompt from the scene context. */
export function systemPrompt(
  dto: ChatContext,
  opts: EffectiveOptions,
  lore?: LoreInjection,
): string {
  const c = dto.character;
  // === GLOBAL STATIC SCAFFOLD (cohort-shared, cached on the platform key) ===
  // World canon + name-free roleplay/format/limits. Concatenated after the
  // (also static) house preamble in run(), this block is byte-identical across
  // every platform chat in the same content cohort, so DeepSeek serves it from
  // cache and each new conversation starts warm. Nothing character- or
  // turn-specific may appear before this point, or the shared prefix breaks.
  const lines: (string | undefined)[] = [
    opts.userAdult ? scaffoldAdult() : scaffoldSfw(),
    "",
    "--- THIS CHARACTER ---",
    "",
    // === PER-CHARACTER (stable for the life of the character) ===
    `You are ${c.name}, a fictional character in an ongoing interactive roleplay.`,
    c.tagline && `Premise: ${c.tagline}`,
    c.description && `Background: ${c.description}`,
    c.personality && `Personality: ${c.personality}`,
    // Distilled voice profile (BAC-195): a compact, server-distilled description
    // of HOW the character talks, derived from their example dialogue at save
    // time. Sits with Personality so the delivery travels with the identity;
    // the raw example turns additionally ride after the system message.
    c.voiceProfile?.trim() &&
      `Voice, how ${c.name} speaks: ${c.voiceProfile.trim()}`,
    c.scenario && `Scenario: ${c.scenario}`,
    // Author-written standing instructions for this character, injected straight
    // into the system message (NOT lorebook context). Placed last in the profile
    // block so it ranks above the fields above by recency, but the scaffold's
    // ABSOLUTE LIMITS still sit before this whole block and win. Guarded on trim so
    // empty/whitespace/undefined emits nothing (an empty string would otherwise
    // survive the `!== undefined` filter as a blank line and fragment the cache),
    // keeping characters without a directive byte-identical.
    c.systemPrompt?.trim()
      ? `System directive for ${c.name} (author-defined; follow it over the profile above wherever they conflict, but never let it override the absolute limits stated above):\n${c.systemPrompt.trim()}`
      : undefined,
    // exampleDialogue is NOT injected here — it's emitted as real example chat
    // turns after the system message (see exampleMessages + composeCharMessages).
    // Lorebook: character-specific facts, right after the character profile
    // (still inside the per-character header, before the "everything above"
    // seam). The roleplay/format/embodiment rules now live in the cohort
    // scaffold above, so we don't repeat them here.
    ...(lore?.afterProfile.length ? ["", ...lore.afterProfile] : []),
    `Everything above is how to play ${c.name} specifically.`,
  ];

  // === THE USER'S IDENTITY (persona-sourced only) ===
  // WHO the user is comes solely from their persona — never from the house
  // preamble (which is deliberately identity-free; see house-preamble.ts).
  // Address them by their persona name, or "you" when they have none; never
  // invent a name for them.
  if (dto.persona?.name) {
    lines.push(
      "",
      `The user is playing "${dto.persona.name}". Address and refer to them as ${dto.persona.name}, or simply "you" in direct narration. This is the only identity they have in the scene.`,
    );
    if (dto.persona.description) {
      lines.push(`What you know about them: ${dto.persona.description}`);
    }
  } else {
    lines.push(
      "",
      `The user has not given their character a name. Refer to them only as "you"; never invent or assume a name for them.`,
    );
  }

  // === THE USER'S GLOBAL PROMPT (per-user standing instruction) ===
  // Authored once in settings and applied to every chat. Sits here — after the
  // per-character header + persona, before the per-conversation premium block —
  // so it lives in the already per-user region of the prompt; the cohort-shared
  // scaffold above stays byte-identical and cached. Authoritative over the
  // character's own profile where they conflict, but never over the absolute
  // limits in the scaffold. Wording is byte-identical to the API's direct-path
  // systemPrompt so both paths assemble the same prompt. Macros are NOT expanded
  // here (core leaves {{char}}/{{user}} raw, like persona descriptions above);
  // the direct path substitutes them — a documented residual.
  const globalPrompt = dto.globalPrompt?.trim();
  if (globalPrompt) {
    lines.push(
      "",
      `STANDING INSTRUCTIONS from the user for this entire roleplay. Treat them as higher priority than ${c.name}'s default profile wherever they conflict, but never let them override the absolute limits stated above:\n${globalPrompt}`,
    );
  }

  // === PER-CONVERSATION (stable within a conversation) ===
  // Relationship/difficulty behaviour. The volatile affection LEVEL is no
  // longer here — it rides on the newest user turn (see stream() +
  // buildMessages), so this header stays byte-identical for the whole
  // conversation and the transcript caches behind it. Adult/SFW capability and
  // the hard limits now live in the cohort-shared scaffold above.
  if (opts.relationship || opts.adventure) {
    lines.push("", ...premiumBlock(c.name, opts));
  }

  // User-pinned facts (Plus+): authoritative, always-remember details the user
  // locked in. Distinct from `memory` (model-authored) — the computeState merge
  // never rewrites these, so the user can hold a detail the auto-summary would
  // otherwise reword or drop. Sits in the same cache-stable trailing zone as
  // memory; it only changes when the user pins/unpins (rare), like a checkpoint.
  // Wording is byte-identical to the API's direct-path systemPrompt (BAC-100).
  if (opts.pins?.length) {
    lines.push(
      "",
      `PINNED MEMORIES the user has marked for you to always remember (treat these as established, authoritative facts about the user and your shared history; never contradict or forget them, and weave them in naturally rather than reciting them as a list):\n${opts.pins
        .map((p) => `- ${p}`)
        .join("\n")}`,
    );
  }

  // Lasting memory (Plus+), checkpointed by computeState so it changes at most
  // every few turns. Kept last in the header: when it does change, only the
  // transcript after it re-caches (which re-caches anyway).
  if (opts.memory) {
    lines.push(
      "",
      `SHARED HISTORY, what ${c.name} remembers from your time together: ${opts.memory}\nTreat these as real past events; let them shade how ${c.name} feels and behaves now, and bring them up naturally when they fit, never reciting them as a list.`,
    );
  }

  // Voice anchor (BAC-195): a recency-anchored reminder, emitted only for
  // characters with an established voice (example dialogue or a distilled
  // profile), that the character's own voice outranks the house style. The
  // examples themselves sit at the far top of the prompt where a long
  // transcript drowns them; this line sits next to the generation point.
  // Stable for the life of the character, so it never fragments the cache
  // within a conversation; characters without a voice emit nothing and stay
  // byte-identical.
  if (c.exampleDialogue?.trim() || c.voiceProfile?.trim()) {
    lines.push("", fill(pack().voiceCheck, { name: c.name }));
  }

  // Recency anchor (name-free, constant): a terminal self-edit pass that
  // catches the AI tells prompting alone keeps leaking (em dashes, "not X,
  // not Y", stage-direction fragments, quip-question kickers), plus the format
  // and the hard limits restated near the generation point. The style checklist
  // explicitly yields to an established character voice (BAC-195) so it stops
  // flattening characters with a distinctive way of speaking.
  lines.push("", pack().charFinalPass);

  // NOTE: tried collapsing computeState into this stream via inline JSON
  // sentinels (30% compliance) and then via OpenAI tool calling (0%
  // compliance with auto, tool-only-no-prose with required). DS-flash's
  // roleplay tuning treats "stay in character / don't break the fiction"
  // as load-bearing and ignores structured-output instructions sitting
  // alongside it. Leaving the separate computeState path as the only one
  // until either the platform model upgrades or the chat goes BYOK to a
  // model that handles prose+structured output better (Claude, GPT-class).

  return lines.filter((l) => l !== undefined).join("\n");
}

/** Relationship behavioral guidance woven into the prose prompt. This only
 *  shapes how the character ACTS (warmth, resistance, reactions to gifts).
 *  The love delta + adventure choices are computed separately, after the
 *  reply, by computeState — small models won't reliably emit an inline tag. */
export function premiumBlock(name: string, opts: EffectiveOptions): string[] {
  if (!opts.relationship) return [];
  return [
    "---",
    fill(pack().premiumRelationship, {
      name,
      difficulty: opts.difficulty,
      difficultyGuidance: difficultyGuidance(opts.difficulty),
    }),
    // Intimacy must track the meter — this is what makes the chase (and the
    // difficulty stat) mean anything. Without it, low affection still goes
    // explicit instantly.
    fill(pack().premiumIntimacy, { name }),
    // Anti-bluff: words are not deeds. Stops a user typing "*offers a rose*"
    // to farm warmth for free.
    fill(pack().premiumAntiBluff, { name }),
    // Real gifts are the privileged, paid signal.
    fill(pack().premiumGift, { name, giftMarker: GIFT_MARKER }),
  ];
}

/** Narrator/game-master prompt for a World: drives scenes and voices the
 *  whole cast in light-novel prose. */
export function worldSystemPrompt(
  dto: WorldContext,
  adult: boolean,
  lore?: LoreInjection,
): string {
  const w = dto.world;
  // Only the one pre-seeded Verge world carries the shared bible; every other
  // world is a standalone universe that runs on its own `setting` (BAC-143).
  const sharedCanon = w.sharedCanon === true;
  // === GLOBAL STATIC SCAFFOLD (shared across every world chat) ===
  // Narrator/format rules (+ the full Verge bible for the shared-canon world).
  // Identical for every world conversation in the same cohort, so DeepSeek caches
  // it once on the shared platform key (same rationale as SCAFFOLD_* for single-
  // character chats). Nothing world-, cast-, or turn-specific may appear before
  // this point.
  const lines: (string | undefined)[] = [
    sharedCanon ? worldScaffold() : worldScaffoldNeutral(),
    "",
    sharedCanon ? "--- THIS REGION ---" : "--- THIS WORLD ---",
    "",
    // === PER-WORLD (stable for the life of the world) ===
    sharedCanon
      ? `You are narrating "${w.name}", a region of the world above.`
      : `You are narrating "${w.name}".`,
    w.setting && `SETTING for "${w.name}" specifically:\n${w.setting}`,
    "",
    // === PER-CONVERSATION (cast in scene + the user's persona) ===
    // Each member's example dialogue is parsed into labelled sample lines
    // (castExampleBlock) instead of dumping raw mes_example with <START>
    // markers and unexpanded {{user}}/{{char}} braces (BAC-195). The distilled
    // voiceProfile, when present, rides as a compact Voice sub-line.
    "CAST. You voice and control all of these characters as the scene needs:",
    ...dto.cast.map(
      (c) =>
        `- ${c.name}${c.personality ? `, ${c.personality}` : ""}${
          c.description ? ` (${c.description})` : ""
        }${c.scenario ? `\n  Scenario: ${c.scenario}` : ""}${
          c.voiceProfile?.trim() ? `\n  Voice: ${c.voiceProfile.trim()}` : ""
        }${castExampleBlock(
          c.exampleDialogue,
          c.name,
          dto.persona?.name?.trim() || "Player",
        )}`,
    ),
    ...(lore?.afterProfile.length ? ["", ...lore.afterProfile] : []),
    "",
    dto.persona?.name
      ? `The user plays "${dto.persona.name}"${
          dto.persona.description ? `: ${dto.persona.description}` : ""
        }. Never speak, act, think, or decide for them; only react to what they choose to do.`
      : 'The user is the protagonist and has no named persona. Refer to them only as "you" and never invent a name for them. Never speak or act for them; only react to what they do.',
  ];
  // The user's global prompt (standing instruction authored in settings, applied
  // to every chat). Per-user, so it sits after the cohort-shared scaffold +
  // per-world header; authoritative over scene defaults where they conflict, but
  // never over the absolute limits above. Byte-identical to the API direct path.
  const globalPrompt = dto.globalPrompt?.trim();
  if (globalPrompt) {
    lines.push(
      "",
      `STANDING INSTRUCTIONS from the player for this entire scene. Honor them as higher priority than the region/cast defaults wherever they conflict, but never let them override the absolute limits stated above:\n${globalPrompt}`,
    );
  }
  // Advertise explicit content only when the world is adult AND the player is
  // 18+-attested — the same gate the single-character path applies via
  // `opts.userAdult`. (A non-adult shouldn't reach an NSFW world at all, since
  // both the world fetch and thread-create are gated, but key off `adult`
  // here too so the prompt can never contradict the SFW preamble.)
  if (w.nsfw && adult) {
    lines.push(
      "",
      "This is an adult (18+) story. Mature and explicit themes are allowed when the player leads there; otherwise keep the story moving naturally.",
    );
  }
  // Recency anchor: terminal self-edit pass against the AI tells (same as the
  // single-character path), tuned for the narrator's named-speaker format. The
  // checklist yields to a cast member's established voice (BAC-195).
  lines.push("", pack().worldFinalPass);
  return lines.filter((l) => l !== undefined).join("\n");
}

/** Build the message list, trimming oldest turns to fit the model's context
 *  window. The system prompt and the newest turn are always kept. Any
 *  `trailingState` (current affection) is appended to the LATEST user turn's
 *  content — NOT as a trailing `system` message, which breaks DeepSeek's
 *  prefix cache. Since the newest turn is never cached anyway, this keeps the
 *  whole system header + prior transcript cacheable across turns. */
export function buildMessages(
  systemContent: string,
  history: Turn[],
  historyBudgetTokens: number,
  trailingState?: string,
  loreInline?: LoreInjection["inline"],
  rollingSummary?: string,
): ApiMessage[] {
  const system: ApiMessage = { role: "system", content: systemContent };
  const turns: ApiMessage[] = history.map((m) => ({
    role: m.role === "char" ? "assistant" : "user",
    content: m.text,
  }));

  // The budget applies to the recent TRANSCRIPT only — the system prefix is
  // the cached part and is always kept (counting it here would shrink the
  // usable window by a large, mostly-cache-hit block).
  const kept = trimTurnsToBudget(turns, historyBudgetTokens);

  // Inline lorebook slots: splice each in as a system message N turns back
  // from the end of the kept window (depth in turns; clamped). Slots arrive
  // deepest-first, so inserting in order keeps their relative placement.
  if (loreInline?.length) {
    for (const slot of loreInline) {
      const at = Math.max(0, Math.min(kept.length, kept.length - slot.depth));
      kept.splice(at, 0, { role: "system", content: slot.text });
    }
  }

  // Inject volatile per-turn state onto the LATEST user turn rather than as a
  // trailing `system` message: a trailing system after the last user turn
  // breaks DeepSeek's prefix cache, but the newest user turn is never cached
  // anyway, so appending here leaves the whole system header + prior
  // transcript cacheable while still giving the state strong recency. Only the
  // request copy is touched — the persisted message is unchanged. (The
  // role check skips any inline-lore system messages spliced in above.)
  if (trailingState) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i]!.role === "user") {
        kept[i] = {
          role: "user",
          content: `${kept[i]!.content}\n\n${trailingState}`,
        };
        break;
      }
    }
  }

  // Rolling summary of evicted older turns. Placed AFTER the (static, cached)
  // system prefix and BEFORE the kept transcript: it continues from the
  // summary into the recent messages. It changes only on a summarization
  // checkpoint (every SUMMARY_CHECKPOINT_EVERY evicted turns — see the
  // controller), so it stays byte-stable for most turns and the big system
  // prefix ahead of it always stays a cache hit.
  const summaryBlock: ApiMessage[] = rollingSummary?.trim()
    ? [
        {
          role: "system",
          content: `STORY SO FAR — summary of earlier parts of this conversation (the messages that follow are the most recent and continue from here):\n${rollingSummary.trim()}`,
        },
      ]
    : [];
  return [system, ...summaryBlock, ...kept];
}

/** Compose the FULL message list for a single-character platform turn: house
 *  preamble (adult/SFW) + top-of-prompt lore + the per-character system prompt,
 *  then the budgeted transcript. This is the pure equivalent of ChatService.run's
 *  composition — extracted so the API and the enclave binary build the exact same
 *  request bytes (prefix cache). The history is `dto.messages`. */
export interface ComposeCharArgs {
  adult: boolean;
  dto: ChatContext;
  opts: EffectiveOptions;
  lore?: LoreInjection;
  historyBudgetTokens: number;
  trailingState?: string;
  rollingSummary?: string;
}

/** Prepend the house preamble (adult/SFW) + top-of-prompt lore to a per-turn
 *  system prompt. The single source for the system-message head, shared by the
 *  API's run() and the enclave's compose ops so the cached prefix is identical. */
export function composeSystemContent(
  adult: boolean,
  lore: LoreInjection | undefined,
  systemPromptStr: string,
): string {
  const preamble = adult ? pack().housePreamble : pack().sfwPreamble;
  const topBlock = lore?.top.length
    ? `WORLD & SETTING NOTES:\n${lore.top.join("\n")}\n\n`
    : "";
  return `${preamble}\n\n${topBlock}${systemPromptStr}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse SillyTavern-style example dialogue (`mes_example`) into raw speaker
 *  turns. Example blocks are separated by `<START>`; lines beginning with
 *  `{{user}}:`, `{{char}}:`, or `<charName>:` set the speaker, and unmarked
 *  lines continue the current turn. Speaker markers are matched on the raw line
 *  BEFORE any macro substitution; `substitute` rewrites `{{char}}`/`{{user}}`
 *  inside the turn CONTENT only. Shared by {@link exampleMessages} (single-
 *  character few-shot turns) and {@link castExampleBlock} (world cast roster). */
function parseExampleTurns(
  exampleDialogue: string | undefined,
  charName: string,
  substitute: (s: string) => string,
): { role: "user" | "assistant"; content: string }[] {
  const text = exampleDialogue?.trim();
  if (!text) return [];

  const userRe = /^\s*\{\{user\}\}\s*:\s?/i;
  const charRe = /^\s*\{\{char\}\}\s*:\s?/i;
  const nameRe = charName
    ? new RegExp(`^\\s*${escapeRegExp(charName)}\\s*:\\s?`, "i")
    : null;

  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*<START>\s*$/i.test(line)) continue; // block separator
    if (!line.trim()) {
      if (turns.length) turns[turns.length - 1]!.content += "\n";
      continue;
    }
    if (userRe.test(line)) {
      turns.push({ role: "user", content: line.replace(userRe, "") });
    } else if (charRe.test(line)) {
      turns.push({ role: "assistant", content: line.replace(charRe, "") });
    } else if (nameRe?.test(line)) {
      turns.push({ role: "assistant", content: line.replace(nameRe, "") });
    } else if (turns.length) {
      turns[turns.length - 1]!.content += `\n${line}`;
    } else {
      turns.push({ role: "assistant", content: line }); // unmarked lead-in
    }
  }

  return turns
    .map((t) => ({ role: t.role, content: substitute(t.content).trim() }))
    .filter((t) => t.content.length > 0);
}

/** Build the delimited example-turn block for a single-character chat (a system
 *  lead-in that tells the model to IMITATE the voice, the alternating turns, and
 *  a closing marker), or `[]` when there's nothing usable — so a character with
 *  no examples produces byte-identical output.
 *
 *  `substitute` rewrites `{{char}}`/`{{user}}` inside the turn CONTENT: the API
 *  passes its macro substituter; {@link composeCharMessages} builds the same
 *  substituter from the dto for the enclave path (BAC-195 — previously the
 *  enclave left macros raw and blind chats saw literal `{{user}}` braces). */
export function exampleMessages(
  exampleDialogue: string | undefined,
  charName: string,
  substitute: (s: string) => string = (s) => s,
): ApiMessage[] {
  const cleaned = parseExampleTurns(exampleDialogue, charName, substitute);
  if (!cleaned.length) return [];

  return [
    {
      role: "system",
      content: `[Example dialogue — the authoritative samples of how ${charName} speaks. Study them and imitate this exact voice, diction, rhythm, and formatting in every reply. Samples only, not part of the actual conversation:]`,
    },
    ...cleaned,
    { role: "system", content: "[End of example dialogue.]" },
  ];
}

/** Render a cast member's example dialogue as indented, speaker-labelled sample
 *  lines for the world (narrator) cast roster — replacing the old raw
 *  `mes_example` dump that leaked `<START>` markers and `{{user}}`/`{{char}}`
 *  braces into the prompt (BAC-195). Returns a block starting with its own
 *  newline (so it appends directly to the roster bullet), or "" when there's
 *  nothing usable. `playerName` labels the user's side of the samples and
 *  substitutes `{{user}}` in the content. */
export function castExampleBlock(
  exampleDialogue: string | undefined,
  castName: string,
  playerName: string,
): string {
  const turns = parseExampleTurns(exampleDialogue, castName, (s) =>
    substituteMacros(s, { user: playerName, char: castName }),
  );
  if (!turns.length) return "";
  const lines = turns.map(
    (t) =>
      `    ${t.role === "user" ? playerName : castName}: ${t.content.replace(/\n/g, "\n    ")}`,
  );
  return `\n  Example dialogue, how ${castName} speaks (keep this exact voice):\n${lines.join("\n")}`;
}

export function composeCharMessages(a: ComposeCharArgs): ApiMessage[] {
  const systemContent = composeSystemContent(
    a.adult,
    a.lore,
    systemPrompt(a.dto, a.opts, a.lore),
  );
  const msgs = buildMessages(
    systemContent,
    a.dto.messages,
    a.historyBudgetTokens,
    a.trailingState,
    a.lore?.inline,
    a.rollingSummary,
  );
  // Example chat turns ride in the cached prefix, right after the system
  // message. Macros in the turn content are substituted from the dto exactly
  // like the API's direct path (BAC-195): {{char}} → the character, {{user}} →
  // the persona name or the shared default. NB: a {{user}} token in the
  // examples keys the cached prefix per-persona — same accepted tradeoff as
  // the direct path.
  const examples = exampleMessages(
    a.dto.character.exampleDialogue,
    a.dto.character.name,
    (s) =>
      substituteMacros(s, {
        user: a.dto.persona?.name?.trim() || DEFAULT_USER_MACRO,
        char: a.dto.character.name,
      }),
  );
  if (examples.length) msgs.splice(1, 0, ...examples);
  return msgs;
}

/** World (narrator) analogue of {@link composeCharMessages}. Worlds have no
 *  affection state, but the per-thread reply-length directive rides the same
 *  `trailingState` channel (BAC-124, mirroring the char path's BAC-105) —
 *  undefined keeps the output byte-identical to the legacy shape. */
export interface ComposeWorldArgs {
  adult: boolean;
  dto: WorldContext;
  lore?: LoreInjection;
  historyBudgetTokens: number;
  trailingState?: string;
  rollingSummary?: string;
}

export function composeWorldMessages(a: ComposeWorldArgs): ApiMessage[] {
  const systemContent = composeSystemContent(
    a.adult,
    a.lore,
    worldSystemPrompt(a.dto, a.adult, a.lore),
  );
  return buildMessages(
    systemContent,
    a.dto.messages,
    a.historyBudgetTokens,
    a.trailingState,
    a.lore?.inline,
    a.rollingSummary,
  );
}

/** Map a 0–100 affection score to a stable vibe label. Bucketing lets the
 *  system prompt stay byte-identical for most consecutive turns (the cache
 *  matches everything behind it), and the model reads bucket labels more
 *  naturally than raw numbers anyway. Six buckets, ~17 points wide, so a
 *  typical conversation crosses ~5–6 boundaries over its lifetime.
 *
 *  Labels describe FEELING INTENSITY, never relationship history. The old
 *  bottom labels ("strangers", "wary acquaintances") asserted how well the two
 *  know each other — a story fact — so when a card/scene established shared
 *  history, the model resolved the contradiction by voicing it mid-scene
 *  ("but we're strangers…", BAC-82). Feelings-language can't contradict the
 *  story, only shade it. */
export function loveBucket(love: number): string {
  const v = Math.max(0, Math.min(100, Math.round(love)));
  const b = pack().loveBuckets;
  if (v >= 100) return b[0]!;
  if (v >= 75) return b[1]!;
  if (v >= 50) return b[2]!;
  if (v >= 25) return b[3]!;
  if (v >= 10) return b[4]!;
  return b[5]!;
}

/** The volatile per-turn scene-state line (appended to the newest user turn by
 *  {@link buildMessages} — never cached). Single source of truth for the API's
 *  three call sites; for the operator-blind path it's built API-side from
 *  non-content data (name + love + difficulty) and shipped into the enclave as
 *  part of the request, so changing this text needs no enclave rebuild.
 *
 *  Framed as a hidden tone gauge and explicitly subordinated to story facts:
 *  the meter must shade HOW the character acts, and must never surface as a
 *  claim about the relationship itself (BAC-82). */
export function sceneStateLine(
  name: string,
  love: number,
  difficulty: number,
): string {
  const gauge = fill(pack().sceneGauge, { name, bucket: loveBucket(love) });
  const guard = fill(pack().sceneGuard, { name });
  return difficulty === 1
    ? `${gauge} ${fill(pack().sceneDiff1Mid, { name })} ${guard} ${fill(pack().sceneDiff1End, { name })}`
    : `${gauge} ${guard} ${fill(pack().sceneDefaultEnd, { name })}`;
}

/** Strip the em-dash AI tell from model output, replacing it (and any
 *  whitespace hugging it) with a comma + space, which is what the house style
 *  tells the model to use instead. En dashes (numeric ranges like 25–50) are
 *  intentionally left alone. Safe to run per streamed delta: an em-dash
 *  codepoint never splits across SSE frames, so the only cross-delta artifact is
 *  a rare doubled space when the dash and its neighbour land in separate chunks,
 *  which is cosmetic. */
export function stripEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ", ");
}

/** Rough token estimate (~4 chars/token) — good enough for context trimming. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Keep the most recent turns that fit within a token budget — oldest dropped
 *  first, but the newest turn is always kept even if it alone exceeds the
 *  budget. This is the platform-model cost lever (see ECONOMICS.md): the kept
 *  transcript is bounded by `budgetTokens` regardless of how deep the thread
 *  is, so a cold-cache resume can't bill the whole history. Pure + exported so
 *  the bound is unit-testable without standing up the service. */
export function trimTurnsToBudget<T extends { content: string }>(
  turns: T[],
  budgetTokens: number,
): T[] {
  const budget = Math.max(512, budgetTokens);
  let used = 0;
  const kept: T[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i]!.content);
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(turns[i]!);
    used += cost;
  }
  return kept;
}
