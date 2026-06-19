import type { ContextSlot, MatchedEntry } from "./types";

/** Group activated entries into ContextSlots and sort within each bucket.
 *  Higher `order` ends up later in each bucket so callers can concatenate. */
export function groupSlots(activated: MatchedEntry[]): ContextSlot[] {
  const slots: ContextSlot[] = activated.map((m) => ({
    position: m.entry.position,
    depth: m.entry.position === "Inline with recent messages" ? m.entry.depth : undefined,
    order: m.entry.order,
    text: m.entry.content,
    entryId: m.entry.id,
    source: m.source,
    tier: m.tier,
  }));

  // Stable sort: position bucket then order asc (consumer concatenates in order,
  // so higher order ends up closer to the AI).
  const positionOrder: Record<string, number> = {
    "Top of prompt": 0,
    "After character profile": 1,
    "Inline with recent messages": 2,
    "Author's note slot": 3,
  };
  slots.sort((a, b) => {
    const pa = positionOrder[a.position] ?? 99;
    const pb = positionOrder[b.position] ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.position === "Inline with recent messages") {
      const da = a.depth ?? 0;
      const db = b.depth ?? 0;
      if (da !== db) return db - da; // deeper (older) first within inline
    }
    return a.order - b.order;
  });
  return slots;
}
