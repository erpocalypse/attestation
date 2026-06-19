import { describe, expect, it } from "bun:test";
import { FORMAT_PARSERS, parseImportedLorebook } from "./registry";
import { characterCardParser } from "./formats/characterCard";
import { sillyTavernParser } from "./formats/sillyTavern";
import { genericParser } from "./formats/generic";

/** These cover the *structural* surface introduced by the IFormatParser refactor
 *  — registration order, per-parser detection, and dispatch routing. The
 *  end-to-end field-mapping behavior lives in `../import.test.ts`. */

describe("format registry", () => {
  it("orders parsers most-specific-first with the generic fallback last", () => {
    expect(FORMAT_PARSERS.map((p) => p.id)).toEqual([
      "character-card",
      "sillytavern",
      "generic",
    ]);
  });

  it("gives every parser a unique id + label", () => {
    const ids = FORMAT_PARSERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FORMAT_PARSERS.every((p) => p.label.length > 0)).toBe(true);
  });
});

describe("character-card parser detection", () => {
  it("claims V2/V3 cards (data.character_book) and top-level character_book", () => {
    expect(characterCardParser.detect({ data: { character_book: { entries: [] } } })).toBe(true);
    expect(characterCardParser.detect({ character_book: { entries: [] } })).toBe(true);
  });
  it("ignores plain books and non-objects", () => {
    expect(characterCardParser.detect({ entries: [] })).toBe(false);
    expect(characterCardParser.detect("nope")).toBe(false);
  });
});

describe("sillytavern parser detection", () => {
  it("claims object-keyed entries maps, not arrays", () => {
    expect(sillyTavernParser.detect({ entries: { "0": {} } })).toBe(true);
    expect(sillyTavernParser.detect({ entries: [] })).toBe(false);
    expect(sillyTavernParser.detect({ name: "x" })).toBe(false);
  });
});

describe("generic parser detection", () => {
  it("claims any object as the fallback, rejects non-objects", () => {
    expect(genericParser.detect({ entries: [] })).toBe(true);
    expect(genericParser.detect({})).toBe(true);
    expect(genericParser.detect(null)).toBe(false);
    expect(genericParser.detect(42)).toBe(false);
  });
});

describe("dispatch routing", () => {
  it("routes a char-card wrapper to the card parser (its inner book wins)", () => {
    // The outer `name` is the character's; the embedded book's name must win,
    // proving the card parser (not the generic fallback) handled it.
    const book = parseImportedLorebook({
      name: "Outer Character",
      data: {
        character_book: { name: "Inner Book", entries: [{ keys: ["x"], content: "c" }] },
      },
    });
    expect(book.name).toBe("Inner Book");
  });

  it("still throws the two distinct legacy errors", () => {
    expect(() => parseImportedLorebook("nope")).toThrow("Unrecognized lorebook format.");
    expect(() => parseImportedLorebook({ name: "x" })).toThrow(
      "Unrecognized lorebook format: no entries found.",
    );
  });
});
