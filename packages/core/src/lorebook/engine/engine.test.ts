import { describe, expect, it } from "bun:test";
import { assembleContext } from "./index";
import type {
  AssembleInput,
  CharacterLite,
  PersonaLite,
  SceneLite,
} from "./types";
import type { Lorebook, LorebookEntry } from "../types";

/**
 * NOTE — this file is intentionally framework-light. Each test builds a
 * minimal AssembleInput from scratch so it's clear which fields are
 * load-bearing. Helpers:
 *   - `book(...)` constructs a Lorebook with sane defaults
 *   - `entry(...)` constructs a LorebookEntry with sane defaults
 *   - `input(...)` constructs an AssembleInput with empty attachments
 */

function entry(p: Partial<LorebookEntry> & { id: string }): LorebookEntry {
  return {
    enabled: true,
    constant: false,
    key: "",
    content: "",
    order: 100,
    position: "After character profile",
    probability: 100,
    ...p,
  };
}

function book(p: {
  id: string;
  name?: string;
  entries: LorebookEntry[];
  worldId?: string;
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  recursive?: boolean;
}): Lorebook {
  return {
    id: p.id,
    name: p.name ?? p.id,
    scope: "Character",
    entries: p.entries,
    worldId: p.worldId,
    scanDepth: p.scanDepth ?? 2,
    caseSensitive: p.caseSensitive ?? false,
    matchWholeWords: p.matchWholeWords ?? true,
    recursive: p.recursive ?? true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const persona: PersonaLite = { id: "u", name: "User" };
const character: CharacterLite = { id: "c", name: "C" };

function makeInput(
  lorebooks: Lorebook[],
  messages: string[],
  overrides: Partial<AssembleInput> = {},
): AssembleInput {
  const scene: SceneLite = {
    id: "s",
    messages: messages.map((m) => ({ role: "user", text: m })),
  };
  // Attach every book to the scene so they're all candidates by default.
  const byOwner: Record<string, { lorebookId: string; primary: boolean; order: number }[]> = {
    "scene:s": lorebooks.map((b, i) => ({
      lorebookId: b.id,
      primary: i === 0,
      order: 100 + i,
    })),
  };
  return {
    scene,
    character,
    persona,
    lorebooks,
    attachments: { byOwner },
    seed: 1,
    ...overrides,
  };
}

describe("assembleContext — basics", () => {
  it("inserts constant entries with no chat input", () => {
    const b = book({
      id: "b1",
      entries: [entry({ id: "e1", constant: true, content: "rule of the realm" })],
    });
    const ctx = assembleContext(makeInput([b], []));
    expect(ctx.slots).toHaveLength(1);
    expect(ctx.slots[0]!.text).toBe("rule of the realm");
    expect(ctx.slots[0]!.entryId).toBe("e1");
  });

  it("activates an entry via keyword match in chat", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "wolf", key: "wolf", content: "wolves howl at night" }),
      ],
    });
    const ctx = assembleContext(makeInput([b], ["I hear a wolf in the woods"]));
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["wolf"]);
  });

  it("respects whole-word matching by default", () => {
    const b = book({
      id: "b1",
      entries: [entry({ id: "king", key: "king", content: "the crown" })],
    });
    const ctx = assembleContext(
      makeInput([b], ["I am liking this weather"]),
    );
    expect(ctx.slots).toHaveLength(0);
  });

  it("honors case sensitivity when enabled per entry", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "rose",
          key: "Rose",
          content: "the lady Rose",
          caseSensitive: true,
        }),
      ],
    });
    const noMatch = assembleContext(makeInput([b], ["a red rose blooms"]));
    expect(noMatch.slots).toHaveLength(0);
    const match = assembleContext(makeInput([b], ["meet lady Rose at noon"]));
    expect(match.slots).toHaveLength(1);
  });
});

describe("scenario as a scan source", () => {
  const b = book({
    id: "b1",
    entries: [
      entry({
        id: "dragon",
        key: "dragon",
        content: "dragon lore",
        matchSources: ["scenario"],
      }),
    ],
  });
  const withScenario = {
    character: {
      id: "c",
      name: "C",
      scenario: "the kingdom is plagued by a dragon",
    },
  };

  it("activates a matchSources:['scenario'] entry from the character scenario", () => {
    const ctx = assembleContext(makeInput([b], [], withScenario));
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["dragon"]);
  });

  it("does not fire a default (messages) entry off scenario text alone", () => {
    const def = book({
      id: "b1",
      entries: [entry({ id: "dragon", key: "dragon", content: "dragon lore" })],
    });
    const ctx = assembleContext(makeInput([def], [], withScenario));
    expect(ctx.slots).toHaveLength(0);
  });
});

describe("world cast scan buffers", () => {
  // World chats feed a synthetic, text-less character; the cast supplies the
  // description/personality/scenario buffers.
  const world = { character: { id: "world1", name: "World", worldId: "world1" } };

  it("activates an entry off a cast member's description", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "dragon",
          key: "dragon",
          content: "dragon lore",
          matchSources: ["description"],
        }),
      ],
    });
    const ctx = assembleContext(
      makeInput([b], [], {
        ...world,
        cast: [
          { id: "c1", name: "Knight", description: "a knight who slew a dragon" },
          { id: "c2", name: "Baker", description: "bakes bread" },
        ],
      }),
    );
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["dragon"]);
  });

  it("does not match when no cast member's scanned field contains the key", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "dragon",
          key: "dragon",
          content: "dragon lore",
          matchSources: ["scenario"],
        }),
      ],
    });
    const ctx = assembleContext(
      makeInput([b], [], {
        ...world,
        cast: [{ id: "c1", name: "Knight", scenario: "guards the gate" }],
      }),
    );
    expect(ctx.slots).toHaveLength(0);
  });
});

describe("secondary key logic", () => {
  it("AND_ANY: requires primary + any secondary", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "e",
          key: "rain",
          secondaryKey: "umbrella, hood",
          secondaryLogic: "AND_ANY",
          content: "weather",
        }),
      ],
    });
    expect(assembleContext(makeInput([b], ["it might rain"])).slots).toHaveLength(0);
    expect(assembleContext(makeInput([b], ["rain — grab the umbrella"])).slots).toHaveLength(1);
  });

  it("AND_ALL: requires primary + all secondary", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "e",
          key: "fire",
          secondaryKey: "smoke, ash",
          secondaryLogic: "AND_ALL",
          content: "burned",
        }),
      ],
    });
    expect(assembleContext(makeInput([b], ["fire and smoke"])).slots).toHaveLength(0);
    expect(assembleContext(makeInput([b], ["fire smoke ash"])).slots).toHaveLength(1);
  });

  it("NOT_ANY: primary present, no secondary may appear", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "e",
          key: "tea",
          secondaryKey: "coffee",
          secondaryLogic: "NOT_ANY",
          content: "tea time",
        }),
      ],
    });
    expect(assembleContext(makeInput([b], ["tea"])).slots).toHaveLength(1);
    expect(assembleContext(makeInput([b], ["tea or coffee?"])).slots).toHaveLength(0);
  });
});

describe("probability is deterministic under a seed", () => {
  it("same seed = same outcomes", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "low",
          key: "trigger",
          probability: 30,
          content: "rare event",
        }),
      ],
    });
    const a = assembleContext(makeInput([b], ["trigger"], { seed: 42 }));
    const c = assembleContext(makeInput([b], ["trigger"], { seed: 42 }));
    expect(a.slots).toEqual(c.slots);
  });
});

describe("inclusion groups", () => {
  it("only one entry per group activates", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "a",
          key: "trigger",
          group: "weather",
          groupWeight: 100,
          prioritizeInclusion: true,
          order: 200,
          content: "sunny",
        }),
        entry({
          id: "b",
          key: "trigger",
          group: "weather",
          groupWeight: 100,
          order: 100,
          content: "rainy",
        }),
      ],
    });
    const ctx = assembleContext(makeInput([b], ["trigger"]));
    expect(ctx.slots).toHaveLength(1);
    // prioritizeInclusion + highest order wins
    expect(ctx.slots[0]!.entryId).toBe("a");
  });

  it("group scoring picks entry with most matched keys", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({
          id: "few",
          key: "trigger",
          group: "g",
          groupScoring: true,
          content: "few",
        }),
        entry({
          id: "many",
          key: "trigger, alpha, beta",
          group: "g",
          groupScoring: true,
          content: "many",
        }),
      ],
    });
    const ctx = assembleContext(
      makeInput([b], ["trigger alpha beta everything"]),
    );
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["many"]);
  });
});

describe("sticky persists across calls", () => {
  it("an entry activated with sticky=2 stays in for the next 2 messages", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "stick", key: "ghost", sticky: 2, content: "haunted" }),
      ],
    });
    const m1 = ["ghost in the hallway"];
    const r1 = assembleContext(makeInput([b], m1));
    expect(r1.slots.map((s) => s.entryId)).toEqual(["stick"]);

    // Next call — no ghost mentioned, but message count grew by 1.
    const r2 = assembleContext(
      makeInput([b], [...m1, "still spooky"], { prevState: r1.nextChatState }),
    );
    expect(r2.slots.map((s) => s.entryId)).toEqual(["stick"]);

    // Three messages later — sticky should have expired.
    const r3 = assembleContext(
      makeInput([b], [...m1, "a", "b", "c"], { prevState: r1.nextChatState }),
    );
    expect(r3.slots.map((s) => s.entryId)).toEqual([]);
  });
});

describe("cooldown blocks re-activation", () => {
  it("entry with cooldown=2 can't fire for 2 messages after activation", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "cd", key: "ping", cooldown: 2, content: "pong" }),
      ],
    });
    const r1 = assembleContext(makeInput([b], ["ping"]));
    expect(r1.slots).toHaveLength(1);

    const r2 = assembleContext(
      makeInput([b], ["ping", "ping again"], { prevState: r1.nextChatState }),
    );
    expect(r2.slots).toHaveLength(0); // cooldown still active
  });
});

describe("recursion", () => {
  it("an entry can be triggered by another entry's content", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "root", key: "raven", content: "the raven watches and the cat hides" }),
        entry({ id: "cat", key: "cat", content: "the cat is asleep" }),
      ],
    });
    const ctx = assembleContext(makeInput([b], ["a raven flies"]));
    expect(ctx.slots.map((s) => s.entryId).sort()).toEqual(["cat", "root"]);
  });

  it("nonRecursable entries are NOT triggered by recursion", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "root", key: "raven", content: "talk of the cat" }),
        entry({
          id: "cat",
          key: "cat",
          nonRecursable: true,
          content: "the cat is asleep",
        }),
      ],
    });
    const ctx = assembleContext(makeInput([b], ["a raven flies"]));
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["root"]);
  });

  it("max recursion steps caps cascading activations", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "a", key: "alpha", content: "talk of beta" }),
        entry({ id: "b", key: "beta", content: "talk of gamma" }),
        entry({ id: "c", key: "gamma", content: "talk of delta" }),
      ],
    });
    const ctx = assembleContext(
      makeInput([b], ["alpha"], { maxRecursionSteps: 2 }),
    );
    // Pass 0 activates a (direct match); pass 1 activates b (from a's content);
    // loop terminates before pass 2, so c never activates.
    expect(ctx.slots.map((s) => s.entryId).sort()).toEqual(["a", "b"]);
  });
});

describe("budget drops lowest-priority entries first", () => {
  it("constant entries survive over keyword entries when budget is tight", () => {
    const big = "x".repeat(400); // ~100 tokens at 4 chars/token
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "const", constant: true, content: big }),
        entry({ id: "kw", key: "anchor", content: big, order: 999 }),
      ],
    });
    const ctx = assembleContext(
      makeInput([b], ["anchor"], { budgetTokens: 120 }),
    );
    expect(ctx.slots.map((s) => s.entryId)).toContain("const");
    expect(ctx.slots.map((s) => s.entryId)).not.toContain("kw");
  });
});

describe("tier ordering", () => {
  it("scene-tier entries beat persona-tier on tie when budget is tight", () => {
    const sceneBook = book({
      id: "scene-b",
      entries: [entry({ id: "scene-e", constant: true, content: "S" })],
    });
    const personaBook = book({
      id: "persona-b",
      entries: [entry({ id: "persona-e", constant: true, content: "P" })],
    });
    const input: AssembleInput = {
      scene: { id: "s", messages: [] },
      character,
      persona,
      lorebooks: [sceneBook, personaBook],
      attachments: {
        byOwner: {
          "scene:s": [{ lorebookId: "scene-b", primary: true, order: 100 }],
          "persona:u": [{ lorebookId: "persona-b", primary: true, order: 100 }],
        },
      },
      budgetTokens: 1, // both entries can't fit
      seed: 1,
    };
    const ctx = assembleContext(input);
    expect(ctx.slots.map((s) => s.entryId)).toEqual(["scene-e"]);
  });
});

describe("delay gating", () => {
  it("entry with delay=3 doesn't fire until the chat has 3 messages", () => {
    const b = book({
      id: "b1",
      entries: [
        entry({ id: "late", key: "trigger", delay: 3, content: "now we talk" }),
      ],
    });
    // 2 messages — gated by delay=3.
    const r1 = assembleContext(makeInput([b], ["trigger", "again"]));
    expect(r1.slots).toHaveLength(0);
    // 3 messages — unblocked. Keep "trigger" in the most recent message so
    // the default scan depth of 2 still sees the keyword.
    const r2 = assembleContext(makeInput([b], ["a", "b", "trigger"]));
    expect(r2.slots).toHaveLength(1);
  });
});
