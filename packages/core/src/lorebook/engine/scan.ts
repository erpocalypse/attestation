import type { MatchSource } from "../types";
import type { AssembleInput, CharacterLite } from "./types";

export interface ScanBuffers {
  /** Default buffer — last N chat messages joined. */
  messages: string;
  /** Per-source buffers for non-message scans. */
  description: string;
  personality: string;
  scenario: string;
  personaDesc: string;
  characterNote: string;
}

/** Build all the text buffers an entry might want to scan against. The
 *  message buffer is built using the maximum scanDepth among candidate books
 *  (each entry can still narrow further during match). */
export function buildScanBuffers(
  input: AssembleInput,
  maxScanDepth: number,
): ScanBuffers {
  const msgs = input.scene.messages;
  const window = maxScanDepth > 0 ? msgs.slice(-maxScanDepth) : [];
  const includeNames = !!input.includeNames;
  const messages = window
    .map((m) => {
      if (!includeNames || !m.name) return m.text;
      return `${m.name}: ${m.text}`;
    })
    .join("\n");

  // A lorebook entry that scans a character field should match against the
  // active character AND every world cast member. For single-character chats
  // `cast` is empty, so each buffer collapses to the character's own field
  // (byte-identical to the pre-cast behaviour).
  const people: CharacterLite[] = [input.character, ...(input.cast ?? [])];
  const fold = (pick: (c: CharacterLite) => string | undefined): string =>
    people
      .map(pick)
      .filter((v): v is string => !!v)
      .join("\n\n");

  return {
    messages,
    description: fold((c) => c.description),
    personality: fold((c) => c.personality),
    scenario: fold((c) => c.scenario),
    personaDesc: input.persona.description ?? "",
    characterNote: fold((c) => c.characterNote),
  };
}

/** Combine buffers per the entry's matchSources setting. Default = messages
 *  only. The result is the haystack the matcher works against. */
export function bufferForEntry(
  buffers: ScanBuffers,
  sources?: MatchSource[],
): string {
  const eff: MatchSource[] = sources && sources.length > 0 ? sources : ["messages"];
  return eff.map((s) => buffers[s]).filter(Boolean).join("\n\n");
}
