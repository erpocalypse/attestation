import { describe, expect, it } from "bun:test";
import { parseImportedLorebook } from "./import";
import type { LorebookEntry } from "./types";

/** A few entries from the simple array form the user attached (key arrays +
 *  content, nothing else). */
const SIMPLE = {
  name: "Pokémon: Fractured Harmony",
  description: "A modern world inhabited solely by Pokémon.",
  author: "Raito Mori",
  version: "1.0",
  entries: [
    { key: ["world", "overview", "setting"], content: "A modern civilization." },
    { key: ["grass", "plant"], content: "Expected to be farmers." },
  ],
};

describe("parseImportedLorebook — simple array form", () => {
  it("reads name/description and joins key arrays to comma strings", () => {
    const book = parseImportedLorebook(SIMPLE);
    expect(book.name).toBe("Pokémon: Fractured Harmony");
    expect(book.description).toBe(
      "A modern world inhabited solely by Pokémon.",
    );
    expect(book.entries).toHaveLength(2);
    expect(book.entries[0]!.key).toBe("world, overview, setting");
    expect(book.entries[0]!.content).toBe("A modern civilization.");
  });

  it("fills sensible defaults for fields the source omits", () => {
    const e = parseImportedLorebook(SIMPLE).entries[0]!;
    expect(e.enabled).toBe(true);
    expect(e.constant).toBe(false);
    expect(e.order).toBe(100);
    expect(e.probability).toBe(100);
    expect(e.position).toBe("After character profile");
    expect(e.id).toBe("imported-0");
  });

  it("uses an injected id generator when provided", () => {
    let n = 0;
    const book = parseImportedLorebook(SIMPLE, { makeId: () => `uuid-${n++}` });
    expect(book.entries.map((e) => e.id)).toEqual(["uuid-0", "uuid-1"]);
  });
});

describe("parseImportedLorebook — SillyTavern World Info", () => {
  const ST = {
    name: "ST Book",
    entries: {
      "0": {
        uid: 0,
        key: ["dragon", "wyrm"],
        keysecondary: ["noble"],
        selectiveLogic: 3, // AND_ALL
        comment: "Dragons",
        content: "Noble and powerful.",
        constant: false,
        disable: true,
        order: 42,
        position: 0, // before char defs → Top of prompt
        probability: 80,
        sticky: 3,
        cooldown: 2,
        group: "types",
        groupWeight: 50,
        useGroupScoring: true,
        excludeRecursion: true,
        caseSensitive: null, // ST "inherit" — must NOT be copied
      },
      "1": {
        uid: 1,
        key: ["depth"],
        content: "At depth entry.",
        position: 4, // at depth → Inline with recent messages
        depth: 6,
      },
    },
  };

  it("reads an object-keyed entries map", () => {
    expect(parseImportedLorebook(ST).entries).toHaveLength(2);
  });

  it("maps numeric position + selectiveLogic, inverts disable", () => {
    const e = parseImportedLorebook(ST).entries[0]!;
    expect(e.key).toBe("dragon, wyrm");
    expect(e.secondaryKey).toBe("noble");
    expect(e.secondaryLogic).toBe("AND_ALL");
    expect(e.position).toBe("Top of prompt");
    expect(e.enabled).toBe(false); // disable: true
    expect(e.order).toBe(42);
    expect(e.probability).toBe(80);
    expect(e.comment).toBe("Dragons");
  });

  it("copies timed/group fields and skips ST 'inherit' nulls", () => {
    const e = parseImportedLorebook(ST).entries[0]!;
    expect(e.sticky).toBe(3);
    expect(e.cooldown).toBe(2);
    expect(e.group).toBe("types");
    expect(e.groupWeight).toBe(50);
    expect(e.groupScoring).toBe(true);
    expect(e.nonRecursable).toBe(true);
    expect("caseSensitive" in e).toBe(false); // null was not copied
  });

  it("maps at-depth position and carries depth", () => {
    const e = parseImportedLorebook(ST).entries[1]!;
    expect(e.position).toBe("Inline with recent messages");
    expect(e.depth).toBe(6);
  });
});

describe("parseImportedLorebook — character-card character_book", () => {
  const CARD = {
    name: "Some Character",
    data: {
      character_book: {
        name: "Embedded Book",
        entries: [
          {
            keys: ["castle"],
            secondary_keys: ["throne"],
            content: "A grand castle.",
            enabled: false,
            insertion_order: 7,
            position: "before_char",
            name: "Castle memo",
          },
        ],
      },
    },
  };

  it("unwraps data.character_book and reads char-card field names", () => {
    const book = parseImportedLorebook(CARD);
    expect(book.name).toBe("Embedded Book");
    expect(book.entries).toHaveLength(1);
    const e = book.entries[0]!;
    expect(e.key).toBe("castle");
    expect(e.secondaryKey).toBe("throne");
    expect(e.enabled).toBe(false);
    expect(e.order).toBe(7);
    expect(e.position).toBe("Top of prompt"); // before_char
    expect(e.comment).toBe("Castle memo"); // name → comment fallback
  });
});

describe("parseImportedLorebook — robustness", () => {
  it("throws on a non-object", () => {
    expect(() => parseImportedLorebook("nope")).toThrow();
    expect(() => parseImportedLorebook(null)).toThrow();
  });

  it("throws when there are no recognizable entries", () => {
    expect(() => parseImportedLorebook({ name: "x" })).toThrow();
    expect(() => parseImportedLorebook({ entries: 5 })).toThrow();
  });

  it("skips empty rows but keeps always-on (constant) ones", () => {
    const book = parseImportedLorebook({
      name: "x",
      entries: [
        { key: [], content: "" }, // skipped
        { key: [], content: "", constant: true }, // kept
        { key: ["a"], content: "real" }, // kept
      ],
    });
    expect(book.entries).toHaveLength(2);
  });

  it("clamps to the entry cap (1000)", () => {
    const entries = Array.from({ length: 1100 }, (_, i) => ({
      key: [`k${i}`],
      content: "c",
    }));
    const book = parseImportedLorebook({ name: "big", entries });
    expect(book.entries).toHaveLength(1000);
  });

  it("truncates over-long content/name to the DTO caps", () => {
    const book = parseImportedLorebook({
      name: "N".repeat(500),
      entries: [{ key: ["k"], content: "C".repeat(20000) }],
    });
    expect(book.name.length).toBe(120);
    expect(book.entries[0]!.content.length).toBe(16000);
  });

  it("defaults a blank name", () => {
    const book = parseImportedLorebook({
      entries: [{ key: ["k"], content: "c" }],
    });
    expect(book.name).toBe("Imported lorebook");
  });

  it("round-trips through an export (our own shape re-imports losslessly)", () => {
    const first = parseImportedLorebook(SIMPLE);
    // Mirror exportLorebook(): wrap our entries back into the file shape.
    const exported = {
      name: first.name,
      description: first.description,
      source: "erpocalypse",
      version: 1,
      entries: first.entries,
    };
    const second = parseImportedLorebook(exported);
    const strip = ({ id, ...rest }: LorebookEntry) => rest; // id is regenerated
    expect(second.name).toBe(first.name);
    expect(second.description).toBe(first.description);
    expect(second.entries.map(strip)).toEqual(first.entries.map(strip));
  });
});
