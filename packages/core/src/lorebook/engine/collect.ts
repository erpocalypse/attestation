import type { Lorebook } from "../types";
import {
  snapshotAttachmentsFor,
  type AttachOwnerKind,
  type AttachmentSnapshot,
} from "../types";
import type {
  AssembleInput,
  CandidateEntry,
  EngineTier,
} from "./types";

/** Walk the stacking tiers in priority order, deduping books that appear in
 *  more than one tier. Returns a flat list of candidate entries, each carrying
 *  its source (the tier + the owner that pulled it in). */
export function collectCandidates(input: AssembleInput): CandidateEntry[] {
  const byId = new Map<string, Lorebook>();
  for (const b of input.lorebooks) byId.set(b.id, b);

  const seen = new Set<string>();
  const out: CandidateEntry[] = [];

  const pushBook = (
    book: Lorebook,
    tier: EngineTier,
    source: CandidateEntry["source"],
  ) => {
    if (seen.has(book.id)) return;
    seen.add(book.id);
    for (const entry of book.entries) {
      if (!entry.enabled) continue;
      out.push({ entry, book, tier, source });
    }
  };

  // 1. Chat / scene lore
  pullAttached(input.attachments, "scene", input.scene.id, byId, (b) =>
    pushBook(b, "scene", { kind: "scene", id: input.scene.id }),
  );

  // 2. Persona lore (direct attachments)
  pullAttached(input.attachments, "persona", input.persona.id, byId, (b) =>
    pushBook(b, "persona", { kind: "persona", id: input.persona.id }),
  );

  // 3. Character lore (direct attachments)
  pullAttached(input.attachments, "character", input.character.id, byId, (b) =>
    pushBook(b, "character", { kind: "character", id: input.character.id }),
  );

  // 4. World-of-character: all lorebooks belonging to the character's world
  if (input.character.worldId) {
    for (const book of input.lorebooks) {
      if (book.worldId === input.character.worldId) {
        pushBook(book, "world-character", {
          kind: "world",
          id: input.character.worldId,
        });
      }
    }
  }

  // 5. World-of-persona
  if (input.persona.worldId) {
    for (const book of input.lorebooks) {
      if (book.worldId === input.persona.worldId) {
        pushBook(book, "world-persona", {
          kind: "world",
          id: input.persona.worldId,
        });
      }
    }
  }

  // 6. Unfiled "global" lorebooks — intentionally NOT auto-included.
  //    Only books explicitly attached make it in. This avoids surprise leakage
  //    from books the user created but never attributed anywhere.

  return out;
}

function pullAttached(
  snapshot: AttachmentSnapshot,
  kind: AttachOwnerKind,
  ownerId: string,
  byId: Map<string, Lorebook>,
  emit: (book: Lorebook) => void,
): void {
  for (const link of snapshotAttachmentsFor(snapshot, kind, ownerId)) {
    const book = byId.get(link.lorebookId);
    if (book) emit(book);
  }
}
