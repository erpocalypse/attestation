import { applyBudget } from "./budget";
import { collectCandidates } from "./collect";
import { groupSlots } from "./position";
import { activatePasses } from "./recurse";
import { buildScanBuffers } from "./scan";
import { applyTiming, commitState } from "./timing";
import type {
  AssembleInput,
  AssembledContext,
  AssemblyTrace,
  ChatLorebookState,
  ContextSlot,
  MatchedEntry,
  TraceEntry,
} from "./types";

export type {
  AssembleInput,
  AssembledContext,
  AssemblyTrace,
  ChatLorebookState,
  ContextSlot,
  TraceEntry,
} from "./types";

/** Core entry point: collect candidate lorebook entries from all attached
 *  tiers, match against the chat scan window (plus recursion), apply
 *  selection / inclusion-group rules, honor sticky/cooldown timing, fit to
 *  the token budget, and return a structured `AssembledContext` the chat
 *  caller can hand directly to a prompt builder.
 *
 *  This module is pure: no Solid signals, no DOM access. It is exercised by
 *  the runtime AND by unit tests with hand-built fixtures. */
export function assembleContext(input: AssembleInput): AssembledContext {
  const trace: TraceEntry[] = [];
  const budgetTokens = resolveBudget(input);
  const prevState: ChatLorebookState = input.prevState ?? {};
  const msgCount = input.scene.messages.length;

  // 1. Collect candidates from the stacked tiers.
  const candidates = collectCandidates(input);

  // 2. Build all the scan buffers up to the widest needed window.
  const maxScanDepth = candidates.reduce(
    (m, c) => Math.max(m, c.book.scanDepth),
    0,
  );
  const buffers = buildScanBuffers(input, maxScanDepth);

  // 3. Run match + select across recursion passes.
  const matched = activatePasses({ candidates, buffers, input, trace });

  // 4. Apply timing — drop cooldowns/delays, force-add sticky candidates.
  const timing = applyTiming({
    candidates,
    matched,
    state: prevState,
    msgCount,
  });
  trace.push(...timing.filteredOut);
  const allActive: MatchedEntry[] = [...timing.matched, ...timing.forcedSticky];

  // 5. Budget — drop lowest-priority entries until we fit.
  const { kept, tokensUsed } = applyBudget({
    activated: allActive,
    budgetTokens,
    trace,
  });

  // 6. Position grouping.
  const slots: ContextSlot[] = groupSlots(kept);

  // 7. Persist next state (sticky / cooldown).
  const nextChatState = commitState({
    prev: prevState,
    activated: kept,
    msgCount,
  });

  const debug: AssemblyTrace = {
    candidates: candidates.length,
    considered: trace,
    recursionPasses: computePasses(kept),
    tokensUsed,
    budgetTokens,
  };

  return { slots, nextChatState, debug };
}

function resolveBudget(input: AssembleInput): number {
  if (typeof input.budgetTokens === "number") return input.budgetTokens;
  if (
    typeof input.budgetPercent === "number" &&
    typeof input.contextTokens === "number"
  ) {
    return Math.max(0, Math.floor((input.budgetPercent / 100) * input.contextTokens));
  }
  return 1024;
}

function computePasses(kept: MatchedEntry[]): number {
  if (kept.length === 0) return 0;
  return kept.reduce((m, k) => Math.max(m, k.recursionLevel), 0) + 1;
}
