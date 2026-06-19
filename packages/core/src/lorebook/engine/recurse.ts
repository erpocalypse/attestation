import { bufferForEntry, type ScanBuffers } from "./scan";
import { matchEntry } from "./match";
import { makeRng, selectActivations } from "./select";
import type {
  AssembleInput,
  CandidateEntry,
  MatchedEntry,
  TraceEntry,
} from "./types";

/** Run the initial match-then-select pass, then optionally recurse — feeding
 *  activated entries' content back into the haystack — until no new entries
 *  activate, max passes is hit, or budget guidance halts the engine.
 *
 *  Recursion is gated globally by `book.recursive` and per-entry by
 *  `nonRecursable` (can't be activated by recursion) and `preventRecursion`
 *  (this entry's content doesn't seed future passes).
 *
 *  `delayUntilRecursion` makes an entry eligible only when the recursion
 *  level reaches the configured value. */
export function activatePasses(opts: {
  candidates: CandidateEntry[];
  buffers: ScanBuffers;
  input: AssembleInput;
  trace: TraceEntry[];
}): MatchedEntry[] {
  const { candidates, buffers, input, trace } = opts;
  const rng = makeRng(input.seed);
  const maxPasses = Math.max(1, input.maxRecursionSteps ?? 3);

  const activatedIds = new Set<string>();
  /** Groups that already chose a winner — once one entry from a group is in,
   *  no further entries from that group may enter (across any pass). */
  const wonGroups = new Set<string>();
  const final: MatchedEntry[] = [];

  let level = 0;
  let extraHaystack = "";

  while (level < maxPasses) {
    const passMatches: MatchedEntry[] = [];

    for (const c of candidates) {
      const e = c.entry;
      if (activatedIds.has(e.id)) continue;
      // Drop any entry whose inclusion group already produced a winner
      // in a prior pass — keeps groups truly mutually-exclusive across the
      // whole assemble call, not just within one pass.
      const g = e.group?.trim();
      if (g && wonGroups.has(g)) {
        trace.push({
          entryId: e.id,
          bookId: c.book.id,
          tier: c.tier,
          activated: false,
          reason: "group-loser",
        });
        continue;
      }

      // Recursion-level eligibility
      const requiredLevel = e.delayUntilRecursion ?? 0;
      if (level < requiredLevel) {
        trace.push({
          entryId: e.id,
          bookId: c.book.id,
          tier: c.tier,
          activated: false,
          reason: "recursion-level",
          recursionLevel: level,
        });
        continue;
      }

      // On recursive passes, skip entries that opt out.
      if (level > 0 && e.nonRecursable) continue;
      if (level > 0 && !c.book.recursive) continue;

      const haystack =
        bufferForEntry(buffers, e.matchSources) +
        (extraHaystack ? `\n${extraHaystack}` : "");

      const outcome = matchEntry(e, c.book, haystack);
      if (outcome.matched) {
        passMatches.push({
          ...c,
          matchedKeys: outcome.matchedKeys,
          recursionLevel: level,
          effectiveOrder: e.order,
        });
      } else if (level === 0 && !e.vectorized) {
        trace.push({
          entryId: e.id,
          bookId: c.book.id,
          tier: c.tier,
          activated: false,
          reason: "no-match",
        });
      } else if (e.vectorized) {
        trace.push({
          entryId: e.id,
          bookId: c.book.id,
          tier: c.tier,
          activated: false,
          reason: "vector-stub",
        });
      }
    }

    // Run selection (trigger types, character filter, probability, groups)
    const selected = selectActivations(passMatches, input, rng, trace);
    if (selected.length === 0) break;

    for (const m of selected) {
      activatedIds.add(m.entry.id);
      const g = m.entry.group?.trim();
      if (g) wonGroups.add(g);
      final.push(m);
      if (!m.entry.preventRecursion) {
        extraHaystack += `\n${m.entry.content}`;
      }
      trace.push({
        entryId: m.entry.id,
        bookId: m.book.id,
        tier: m.tier,
        activated: true,
        matchedKeys: m.matchedKeys,
        recursionLevel: level,
      });
    }
    level += 1;
  }

  return final;
}
