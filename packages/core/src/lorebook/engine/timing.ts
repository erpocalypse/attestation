import type {
  AssembleInput,
  CandidateEntry,
  ChatLorebookState,
  MatchedEntry,
  TraceEntry,
} from "./types";

/** Resolve sticky / cooldown / delay against the per-chat state. Mutates
 *  `nextState` so callers can persist it back to the scene.
 *
 *  - `delay`: entry only eligible after the chat reaches N messages.
 *  - `cooldown`: blocks for N messages after activation.
 *  - `sticky`: if previously sticky-activated and the window is still open,
 *    force-activate (returned as an injection) regardless of match. */
export function applyTiming(input: {
  candidates: CandidateEntry[];
  matched: MatchedEntry[];
  state: ChatLorebookState;
  msgCount: number;
}): {
  matched: MatchedEntry[];
  forcedSticky: MatchedEntry[];
  filteredOut: TraceEntry[];
} {
  const { candidates, matched, state, msgCount } = input;

  // 1. Build a lookup from matched entries (post-match) to recognize who
  //    is already in.
  const matchedIds = new Set(matched.map((m) => m.entry.id));

  // 2. Find sticky-forced entries from candidates that aren't already matched.
  const forcedSticky: MatchedEntry[] = [];
  const stickyUntil = state.stickyUntil ?? {};
  for (const c of candidates) {
    const until = stickyUntil[c.entry.id];
    if (until !== undefined && msgCount < until && !matchedIds.has(c.entry.id)) {
      forcedSticky.push({
        ...c,
        matchedKeys: [],
        recursionLevel: 0,
        effectiveOrder: c.entry.order,
      });
    }
  }

  // 3. Filter matched entries by cooldown / delay.
  const cooldownUntil = state.cooldownUntil ?? {};
  const survivors: MatchedEntry[] = [];
  const filteredOut: TraceEntry[] = [];
  for (const m of matched) {
    const e = m.entry;
    if (typeof e.delay === "number" && e.delay > 0 && msgCount < e.delay) {
      filteredOut.push({
        entryId: e.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: false,
        reason: "delay",
      });
      continue;
    }
    const cd = cooldownUntil[e.id];
    if (cd !== undefined && msgCount < cd) {
      filteredOut.push({
        entryId: e.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: false,
        reason: "cooldown",
      });
      continue;
    }
    survivors.push(m);
  }

  return { matched: survivors, forcedSticky, filteredOut };
}

/** After activations are finalized, write the next sticky/cooldown windows. */
export function commitState(opts: {
  prev: ChatLorebookState;
  activated: MatchedEntry[];
  msgCount: number;
}): ChatLorebookState {
  const next: ChatLorebookState = {
    stickyUntil: { ...(opts.prev.stickyUntil ?? {}) },
    cooldownUntil: { ...(opts.prev.cooldownUntil ?? {}) },
  };
  for (const m of opts.activated) {
    const e = m.entry;
    if (typeof e.sticky === "number" && e.sticky > 0) {
      next.stickyUntil![e.id] = opts.msgCount + e.sticky;
    }
    if (typeof e.cooldown === "number" && e.cooldown > 0) {
      next.cooldownUntil![e.id] = opts.msgCount + e.cooldown;
    }
  }
  // Strip empty objects to keep state tidy.
  if (Object.keys(next.stickyUntil!).length === 0) delete next.stickyUntil;
  if (Object.keys(next.cooldownUntil!).length === 0) delete next.cooldownUntil;
  return next;
}
