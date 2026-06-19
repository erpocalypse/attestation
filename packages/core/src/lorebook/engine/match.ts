import type { Lorebook, LorebookEntry, SecondaryLogic } from "../types";

/** Parse a comma-separated key string into individual tokens. Each token is
 *  either `{ kind: "regex", value: RegExp }` (when wrapped in /…/flags) or
 *  `{ kind: "plain", value: string }`. */
export interface KeyToken {
  kind: "plain" | "regex";
  raw: string;
  regex?: RegExp;
}

/** Robust regex-literal detector. Matches `/pattern/flags` where flags is
 *  the standard JS subset. */
const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

export function parseKeys(keyString: string): KeyToken[] {
  if (!keyString) return [];
  return keyString
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t): KeyToken => {
      const m = REGEX_LITERAL.exec(t);
      if (m) {
        try {
          return { kind: "regex", raw: t, regex: new RegExp(m[1]!, m[2]!) };
        } catch {
          return { kind: "plain", raw: t };
        }
      }
      return { kind: "plain", raw: t };
    });
}

/** Escape user-supplied text for safe inclusion in a regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve effective case-sensitivity and whole-word settings, with
 *  entry-level overrides winning over book defaults. */
function resolvedFlags(entry: LorebookEntry, book: Lorebook) {
  return {
    caseSensitive:
      typeof entry.caseSensitive === "boolean"
        ? entry.caseSensitive
        : book.caseSensitive,
    matchWholeWords:
      typeof entry.matchWholeWords === "boolean"
        ? entry.matchWholeWords
        : book.matchWholeWords,
  };
}

/** Try to find every token from `tokens` in `haystack`. Returns the list of
 *  raw key strings that matched at least once. */
export function matchTokens(
  tokens: KeyToken[],
  haystack: string,
  opts: { caseSensitive: boolean; matchWholeWords: boolean },
): string[] {
  if (tokens.length === 0) return [];
  const subject = opts.caseSensitive ? haystack : haystack.toLowerCase();
  const matched: string[] = [];
  for (const tk of tokens) {
    if (tk.kind === "regex") {
      // Regex tokens are honored as-is — case sensitivity is on the RegExp.
      if (tk.regex && tk.regex.test(haystack)) matched.push(tk.raw);
      continue;
    }
    const needle = opts.caseSensitive ? tk.raw : tk.raw.toLowerCase();
    if (opts.matchWholeWords && /^[\p{L}\p{N}_]+$/u.test(needle)) {
      // Single-word literal: use word boundary regex.
      const re = new RegExp(
        `\\b${escapeRegex(needle)}\\b`,
        opts.caseSensitive ? "" : "i",
      );
      if (re.test(haystack)) matched.push(tk.raw);
    } else {
      if (subject.includes(needle)) matched.push(tk.raw);
    }
  }
  return matched;
}

export interface MatchOutcome {
  /** True if the entry should activate based on primary + secondary logic. */
  matched: boolean;
  /** Primary keys that were found (empty for constant entries). */
  matchedKeys: string[];
}

/** Determine whether an entry's matching rules pass against the given
 *  haystack. Constant entries always pass. Vectorized entries always fail
 *  (until embeddings are wired). */
export function matchEntry(
  entry: LorebookEntry,
  book: Lorebook,
  haystack: string,
): MatchOutcome {
  if (entry.constant) return { matched: true, matchedKeys: [] };
  if (entry.vectorized) return { matched: false, matchedKeys: [] };

  const flags = resolvedFlags(entry, book);
  const primary = parseKeys(entry.key);
  if (primary.length === 0) return { matched: false, matchedKeys: [] };
  const primaryMatched = matchTokens(primary, haystack, flags);
  if (primaryMatched.length === 0) return { matched: false, matchedKeys: [] };

  const secondaryKey = entry.secondaryKey?.trim();
  if (!secondaryKey) {
    return { matched: true, matchedKeys: primaryMatched };
  }

  const secondary = parseKeys(secondaryKey);
  const secondaryMatched = matchTokens(secondary, haystack, flags);
  const logic: SecondaryLogic = entry.secondaryLogic ?? "AND_ANY";

  const allSecondaryHit = secondaryMatched.length === secondary.length;
  const anySecondaryHit = secondaryMatched.length > 0;

  let pass = false;
  switch (logic) {
    case "AND_ANY":
      pass = anySecondaryHit;
      break;
    case "AND_ALL":
      pass = allSecondaryHit;
      break;
    case "NOT_ANY":
      pass = !anySecondaryHit;
      break;
    case "NOT_ALL":
      pass = !allSecondaryHit;
      break;
  }
  return {
    matched: pass,
    matchedKeys: pass ? primaryMatched : [],
  };
}
