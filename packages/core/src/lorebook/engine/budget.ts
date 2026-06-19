import type { EngineTier, MatchedEntry, TraceEntry } from "./types";

/** Crude token estimate — swap for tiktoken / gpt-tokenizer when an LLM dep
 *  lands. Empirically ~4 chars/token for English. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

const TIER_PRIORITY: Record<EngineTier, number> = {
  scene: 5,
  persona: 4,
  character: 3,
  "world-character": 2,
  "world-persona": 1,
  global: 0,
};

/** Drop lowest-priority entries until the cumulative token cost fits the
 *  budget. Priority (high to low):
 *    1. Constant entries
 *    2. Higher tier
 *    3. Higher `order` value
 *    4. Direct match before recursive activation */
export function applyBudget(opts: {
  activated: MatchedEntry[];
  budgetTokens: number;
  trace: TraceEntry[];
}): { kept: MatchedEntry[]; tokensUsed: number } {
  const sorted = [...opts.activated].sort(compareByPriority);
  const kept: MatchedEntry[] = [];
  let used = 0;
  for (const m of sorted) {
    const cost = estimateTokens(m.entry.content);
    if (used + cost > opts.budgetTokens) {
      opts.trace.push({
        entryId: m.entry.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: false,
        reason: "budget",
      });
      continue;
    }
    used += cost;
    kept.push(m);
  }
  return { kept, tokensUsed: used };
}

function compareByPriority(a: MatchedEntry, b: MatchedEntry): number {
  // Constants come first
  if (a.entry.constant !== b.entry.constant) return a.entry.constant ? -1 : 1;
  // Then tier
  const tierDiff = TIER_PRIORITY[b.tier] - TIER_PRIORITY[a.tier];
  if (tierDiff !== 0) return tierDiff;
  // Then explicit order (higher wins for budget priority)
  const orderDiff = b.entry.order - a.entry.order;
  if (orderDiff !== 0) return orderDiff;
  // Direct matches before recursive
  return a.recursionLevel - b.recursionLevel;
}
