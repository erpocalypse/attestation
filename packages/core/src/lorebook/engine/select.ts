import type { LorebookEntry, TriggerType } from "../types";
import type {
  AssembleInput,
  CharacterLite,
  MatchedEntry,
  TraceEntry,
} from "./types";

/** Apply trigger-type, character-filter, probability, and inclusion-group
 *  filtering to a list of matched entries. Returns the survivors and trace
 *  notes for the rest. */
export function selectActivations(
  matched: MatchedEntry[],
  input: AssembleInput,
  rng: () => number,
  trace: TraceEntry[],
): MatchedEntry[] {
  const triggerType = input.triggerType ?? "normal";
  const eligible: MatchedEntry[] = [];

  for (const m of matched) {
    const e = m.entry;
    if (!passesTriggerType(e, triggerType)) {
      trace.push({
        entryId: e.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: false,
        reason: "trigger-type",
      });
      continue;
    }
    if (!passesCharacterFilter(e, input.character)) {
      trace.push({
        entryId: e.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: false,
        reason: "character-filter",
      });
      continue;
    }
    // Probability: sticky entries (handled at timing stage) and constant entries
    // bypass the roll. Constants always pass; sticky we'll know at timing.
    if (!e.constant) {
      const p = clampProbability(e.probability);
      if (p < 100 && rng() * 100 >= p) {
        trace.push({
          entryId: e.id,
          bookId: m.book.id,
          tier: m.tier,
          activated: false,
          reason: "probability",
        });
        continue;
      }
    }
    eligible.push(m);
  }

  // Inclusion groups — bucket by `group` field.
  const groups = new Map<string, MatchedEntry[]>();
  const final: MatchedEntry[] = [];
  for (const m of eligible) {
    const g = m.entry.group?.trim();
    if (!g) {
      final.push(m);
      continue;
    }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  for (const [, members] of groups) {
    if (members.length === 1) {
      final.push(members[0]!);
      continue;
    }
    const winner = pickGroupWinner(members, rng);
    for (const m of members) {
      if (m === winner) final.push(m);
      else
        trace.push({
          entryId: m.entry.id,
          bookId: m.book.id,
          tier: m.tier,
          activated: false,
          reason: "group-loser",
        });
    }
  }
  return final;
}

function passesTriggerType(entry: LorebookEntry, trigger: TriggerType): boolean {
  if (!entry.triggerTypes || entry.triggerTypes.length === 0) return true;
  return entry.triggerTypes.includes(trigger);
}

function passesCharacterFilter(
  entry: LorebookEntry,
  character: CharacterLite,
): boolean {
  const filter = entry.characterFilter;
  if (!filter || filter.ids.length === 0) return true;
  const matches =
    filter.ids.includes(character.id) ||
    (character.tags ?? []).some((t) => filter.ids.includes(t));
  return filter.mode === "include" ? matches : !matches;
}

function clampProbability(p: number): number {
  if (typeof p !== "number" || isNaN(p)) return 100;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

/** Pick one winner from a group. Order of precedence matches SillyTavern:
 *  1) `prioritizeInclusion` → highest order
 *  2) `groupScoring` (any member) → most matched primary keys
 *  3) weighted random by `groupWeight` */
function pickGroupWinner(
  members: MatchedEntry[],
  rng: () => number,
): MatchedEntry {
  const priorityFlag = members.some((m) => m.entry.prioritizeInclusion);
  if (priorityFlag) {
    return [...members].sort(
      (a, b) => b.entry.order - a.entry.order,
    )[0]!;
  }
  const scoringFlag = members.some((m) => m.entry.groupScoring);
  if (scoringFlag) {
    return [...members].sort((a, b) => {
      const diff = b.matchedKeys.length - a.matchedKeys.length;
      return diff !== 0 ? diff : b.entry.order - a.entry.order;
    })[0]!;
  }
  // Weighted random
  const weights = members.map((m) => Math.max(0, m.entry.groupWeight ?? 100));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0) return members[0]!;
  let roll = rng() * total;
  for (let i = 0; i < members.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return members[i]!;
  }
  return members[members.length - 1]!;
}

/** Seedable deterministic RNG (mulberry32) for replayable tests. */
export function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = (seed | 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
