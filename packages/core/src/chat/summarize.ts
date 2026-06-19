/** Shared rolling-summary FOLD request builder (BAC-98).
 *
 *  The prompt bytes here were moved VERBATIM from the API's
 *  ChatService.summarizeDropped so the direct path (API-side fold) and the
 *  operator-blind path (in-enclave fold, via the bun-compiled assembler's
 *  `summarize_build` op) produce the exact same summarize request. Do not edit
 *  the strings on one side only — the API re-imports this builder, so there is
 *  a single copy to keep honest.
 *
 *  Pure: takes the dropped turns + the prior summary, returns the OpenAI-style
 *  messages plus the fixed call params. The caller supplies the model name and
 *  provider-specific `reasoning` knobs (transport concerns stay outside core). */
import { GIFT_MARKER } from "./types";
import { stripEmDash } from "./assembly";
import { pack, fill } from "./promptpack/active";

/** The slice of a Turn the summarizer reads. `role` follows the storage
 *  convention ("char" = the character/narrator, anything else = the user). */
export interface SummarizeTurn {
  role: string;
  text: string;
}

/** Label + cap the dropped turns into the excerpt both fold builders feed the
 *  model. Caps the slice so a first checkpoint over a long pre-existing thread
 *  can't send the whole history, and rewrites the GIFT_MARKER so the summary
 *  can't be used to fake paid gifts. Extracted verbatim from the legacy builder
 *  (BAC-98) — the bytes it produces must not change. */
export function excerptTurns(dropped: SummarizeTurn[], name: string): string {
  return dropped
    .slice(-120)
    .map((m) => {
      const who = m.role === "char" ? name : "User";
      const text = m.text.startsWith(GIFT_MARKER)
        ? m.text.replace(GIFT_MARKER, "(gift)")
        : m.text;
      return `${who}: ${text.slice(0, 400)}`;
    })
    .join("\n");
}

export interface SummarizeFoldInput {
  /** The current rolling summary, or null/absent on the first fold. */
  prevSummary?: string | null;
  /** The evicted turns to fold in, oldest → newest (plaintext). */
  dropped: SummarizeTurn[];
  /** The character's (or world's) display name, used to label their lines. */
  name: string;
}

/** The built summarize request: messages + the fixed sampling params the
 *  callers must use so both paths make an identical provider call. */
export interface SummarizeBuildResult {
  messages: { role: "system" | "user"; content: string }[];
  maxTokens: number;
  temperature: number;
}

/** Build the merge-summary request for a fold. Returns null when there is
 *  nothing to fold (the caller keeps the prior summary untouched). */
export function buildSummarizeMessages(
  input: SummarizeFoldInput,
): SummarizeBuildResult | null {
  if (!input.dropped || input.dropped.length === 0) return null;

  // Cap the excerpt so a first checkpoint over a long pre-existing thread
  // can't send the whole history; older context is carried by prevSummary.
  const excerpt = excerptTurns(input.dropped, input.name);

  const system = pack().summarizeSystem;
  const data = `${input.prevSummary ? `Prior summary:\n${input.prevSummary}\n\n` : ""}New messages to fold in (oldest to newest):\n${excerpt}`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: data },
    ],
    maxTokens: 320,
    temperature: 0.3,
  };
}

// ----- chapter folds (BAC-113/114) ------------------------------------------
//
// The legacy fold above re-merges the ENTIRE prior summary through the model on
// every checkpoint, so a long thread's early milestones get re-compressed over
// and over until they vanish (summary-of-summary drift). The chapter fold fixes
// the mechanism: each checkpoint writes ONE new immutable chapter covering only
// the newly evicted turns; prior chapters are passed as read-only context and
// never rewritten. The joined chapters are what assembly's STORY SO FAR block
// receives, so the assembled prompt SHAPE is unchanged.
//
// Sealed threads still run the legacy fold in-enclave (`summarize_build`) until
// the parity rebuild (BAC-118) — keep both builders intact.

/** One immutable chapter of the rolling log. `upto` is the summarizedUpto
 *  watermark this chapter advanced the thread to (how many messages, in
 *  createdAt order, are covered once it's written) — kept per-chapter so a
 *  fork-forward edit can drop ONLY the chapters describing deleted turns. */
export interface SummaryChapter {
  upto: number;
  text: string;
}

/** Hard ceiling on the JOINED chapter log, in characters (~1k tokens). The
 *  whole log rides in the prompt every turn, so it must stay bounded; when an
 *  append crosses this, the OLDEST chapters get rolled up (one bounded
 *  compression — recent chapters are never touched). Also the cap on a manual
 *  summary edit. */
export const SUMMARY_TOTAL_CHAR_CAP = 4000;

/** The newest chapters a roll-up never touches: recent events stay verbatim. */
export const ROLLUP_KEEP_RECENT = 3;

/** How many trailing chapters the chapter-fold prompt sees as read-only
 *  context (for pronoun/thread continuity) — NOT re-summarized. */
const CHAPTER_CONTEXT_TAIL = 2;

/** Scrub a model-written chapter before it's persisted: kill the em-dash tell
 *  (BAC-114), collapse runaway whitespace, trim. Shared so the enclave-side
 *  fold (BAC-118) cleans identically. */
export function cleanChapterText(text: string): string {
  return stripEmDash(text).replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Parse a stored chapter log. Tolerates null/garbage (returns []); a legacy
 *  thread that only has the old cumulative `summary` gets it seeded as chapter
 *  0 so its continuity carries straight into the chapter era. */
export function parseChapters(
  json: string | null | undefined,
  legacySummary?: string | null,
  legacyUpto?: number,
): SummaryChapter[] {
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) {
        const out = parsed.filter(
          (c): c is SummaryChapter =>
            !!c &&
            typeof (c as SummaryChapter).upto === "number" &&
            typeof (c as SummaryChapter).text === "string" &&
            !!(c as SummaryChapter).text.trim(),
        );
        if (out.length) return out;
      }
    } catch {
      /* fall through to the legacy seed */
    }
  }
  const seed = legacySummary?.trim();
  return seed ? [{ upto: Math.max(0, legacyUpto ?? 0), text: seed }] : [];
}

/** The STORY SO FAR text: chapters in order, blank-line separated. */
export function joinChapters(chapters: SummaryChapter[]): string {
  return chapters.map((c) => c.text.trim()).filter(Boolean).join("\n\n");
}

/** Chapters that survive a fork-forward edit keeping the first `keep` messages:
 *  only those wholly inside the kept region — a chapter whose `upto` reaches
 *  past the cut describes deleted turns and must go. */
export function chaptersForTruncate(
  chapters: SummaryChapter[],
  keep: number,
): SummaryChapter[] {
  return chapters.filter((c) => c.upto <= keep);
}

/** True when the joined log has outgrown its budget AND there are old chapters
 *  eligible for a roll-up (the newest {@link ROLLUP_KEEP_RECENT} never roll). */
export function needsRollup(chapters: SummaryChapter[]): boolean {
  return (
    chapters.length > ROLLUP_KEEP_RECENT &&
    joinChapters(chapters).length > SUMMARY_TOTAL_CHAR_CAP
  );
}

/** Replace the rolled-up head of the log with its merged text, keeping the
 *  newest {@link ROLLUP_KEEP_RECENT} chapters verbatim. The merged chapter
 *  inherits the last rolled chapter's watermark. */
export function applyRollup(
  chapters: SummaryChapter[],
  mergedText: string,
): SummaryChapter[] {
  const head = chapters.slice(0, -ROLLUP_KEEP_RECENT);
  const tail = chapters.slice(-ROLLUP_KEEP_RECENT);
  if (!head.length || !mergedText.trim()) return chapters;
  return [
    { upto: head[head.length - 1]!.upto, text: mergedText.trim() },
    ...tail,
  ];
}

export interface ChapterFoldInput {
  /** Existing chapter texts, oldest → newest (the prompt only reads the tail). */
  prevChapters: string[];
  /** The evicted turns to cover, oldest → newest (plaintext). */
  dropped: SummarizeTurn[];
  /** The character's (or world's) display name, used to label their lines. */
  name: string;
}

/** Build the request for ONE new chapter covering only the new excerpt. */
export function buildChapterFoldMessages(
  input: ChapterFoldInput,
): SummarizeBuildResult | null {
  if (!input.dropped || input.dropped.length === 0) return null;

  const excerpt = excerptTurns(input.dropped, input.name);
  const system = pack().chapterFoldSystem;
  const context = input.prevChapters.slice(-CHAPTER_CONTEXT_TAIL).join("\n\n");
  const data = `${context ? `Latest chapters so far (context only, do not repeat):\n${context}\n\n` : ""}New messages to cover (oldest to newest):\n${excerpt}`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: data },
    ],
    maxTokens: 220,
    temperature: 0.3,
  };
}

/** Build the roll-up request that merges the oldest chapters into one. The
 *  caller decides eligibility via {@link needsRollup} and re-shapes the log via
 *  {@link applyRollup}. */
export function buildRollupMessages(input: {
  chapters: string[];
}): SummarizeBuildResult | null {
  if (!input.chapters.length) return null;
  const system = pack().rollupSystem;
  const data = `Chapters to merge (oldest to newest):\n${input.chapters.join("\n\n")}`;
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: data },
    ],
    maxTokens: 280,
    temperature: 0.2,
  };
}

// ----- shared fold pipeline (BAC-118 enclave parity) --------------------------
//
// The chapter fold is a two-step provider conversation (chapter, then maybe a
// roll-up) around pure bookkeeping. These build/apply halves capture EVERYTHING
// except the provider call itself, so the API's foldChapter and the enclave's
// `chapter_build`/`chapter_apply` assembler ops run literally the same code —
// the BAC-98 pattern, extended.

export interface ChapterFoldBuildInput {
  /** The legacy cumulative summary, used only to seed chapter 0. */
  prevSummary?: string | null;
  /** The stored chapter log (JSON SummaryChapter[]), or null on first fold. */
  prevChaptersJson?: string | null;
  /** The watermark BEFORE this fold (stamps the legacy seed chapter). */
  priorUpto: number;
  /** The evicted turns to cover, oldest → newest (plaintext). */
  dropped: SummarizeTurn[];
  name: string;
}

/** Step 1: the chapter request for the provider, or null when there is nothing
 *  to fold. */
export function chapterFoldBuild(
  input: ChapterFoldBuildInput,
): SummarizeBuildResult | null {
  const chapters = parseChapters(
    input.prevChaptersJson,
    input.prevSummary,
    input.priorUpto,
  );
  return buildChapterFoldMessages({
    prevChapters: chapters.map((c) => c.text),
    dropped: input.dropped,
    name: input.name,
  });
}

export interface ChapterFoldApplyInput extends ChapterFoldBuildInput {
  /** The watermark this fold advances to (stamps the new chapter). */
  upto: number;
  /** The provider's chapter completion (raw). */
  raw: string;
  /** The provider's roll-up completion, on the second apply pass only. */
  merged?: string | null;
}

export interface ChapterFoldApplyResult {
  /** The joined log — exactly what the STORY SO FAR block injects. */
  summary: string;
  /** The serialized chapter log to persist (encrypt-at-rest like `summary`). */
  summaryChapters: string;
  /** Present when the log outgrew its budget and no `merged` text was given:
   *  the caller makes this ONE more provider call, then re-applies with
   *  `merged`. A failed roll-up call is fine — keep this result's (over-budget)
   *  log and the next fold retries. */
  rollup?: SummarizeBuildResult;
}

/** Step 2: scrub + append the new chapter (and fold in the roll-up when its
 *  text is supplied). Pure and deterministic, so applying twice with the same
 *  inputs yields identical bytes on the API and in the enclave. */
export function chapterFoldApply(
  input: ChapterFoldApplyInput,
): ChapterFoldApplyResult | null {
  const text = cleanChapterText(input.raw);
  if (!text) return null;
  const chapters = parseChapters(
    input.prevChaptersJson,
    input.prevSummary,
    input.priorUpto,
  );
  let next = [...chapters, { upto: input.upto, text }];
  let rollup: SummarizeBuildResult | undefined;
  if (needsRollup(next)) {
    const mergedText = input.merged ? cleanChapterText(input.merged) : "";
    if (mergedText) {
      next = applyRollup(next, mergedText);
    } else {
      rollup =
        buildRollupMessages({
          chapters: next.slice(0, -ROLLUP_KEEP_RECENT).map((c) => c.text),
        }) ?? undefined;
    }
  }
  return {
    summary: joinChapters(next),
    summaryChapters: JSON.stringify(next),
    ...(rollup ? { rollup } : {}),
  };
}

// ----- fact rescue (BAC-116, shared for BAC-118 parity) -----------------------

export interface FactRescueInput {
  /** The current first-person recollection (post-computeState, when scored). */
  currentMemory?: string | null;
  /** The evicted turns whose durable facts must survive (plaintext). */
  dropped: SummarizeTurn[];
  /** The character's display name (the note stays in their first person). */
  name: string;
  /** The plan's recollection char cap; word target + token cap derive from it. */
  maxChars: number;
}

/** Build the fact-rescue request: update the recollection so durable facts in
 *  the about-to-vanish turns survive. Same bytes on the direct path
 *  (mergeFactsIntoMemory) and in the enclave (`facts_build`). */
export function buildFactRescueMessages(
  input: FactRescueInput,
): SummarizeBuildResult | null {
  if (!input.dropped || input.dropped.length === 0) return null;
  const wordTarget = Math.round(input.maxChars / 5);
  const system = fill(pack().factRescueSystem, { name: input.name, wordTarget });
  const data = `${input.currentMemory?.trim() ? `Current note:\n${input.currentMemory.trim()}\n\n` : ""}Messages about to leave context (oldest to newest):\n${excerptTurns(input.dropped, input.name)}`;
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: data },
    ],
    maxTokens: Math.ceil(input.maxChars / 3) + 60,
    temperature: 0.3,
  };
}

/** Scrub + cap the fact-rescue completion. The enclave uses this as its only
 *  over-cap fallback (`facts_apply`); the direct path tries a condense rewrite
 *  first and falls back here. Returns null when the output is unusable. */
export function applyFactRescue(
  out: string | null | undefined,
  maxChars: number,
): string | null {
  if (!out) return null;
  const clean = stripEmDash(out).trim();
  if (!clean) return null;
  return clean.length <= maxChars ? clean : sentenceTrim(clean, maxChars);
}

/** Trim to a cap on a sentence (or word) boundary, never mid-word. Moved here
 *  from the API's chat.service (which re-exports it) so the enclave's
 *  facts_apply trims byte-identically. */
export function sentenceTrim(text: string, cap: number): string {
  const t = text.trim();
  if (t.length <= cap) return t;
  const window = t.slice(0, cap);
  const lastSentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.endsWith(".") || window.endsWith("!") || window.endsWith("?")
      ? window.length - 1
      : -1,
  );
  if (lastSentence > cap * 0.5) return window.slice(0, lastSentence + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
}
