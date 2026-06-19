/** The assembly request protocol + dispatcher — the seam between transport and
 *  pure assembly. The enclave sends exactly these shapes (plus, in later phases,
 *  ciphertext ingredients); each maps 1:1 to a pure function in this package. The
 *  SAME dispatcher runs in-process (API path) and inside the compiled binary
 *  (enclave path), so there is no second implementation to drift. */
import {
	buildMessages,
	composeCharMessages,
	composeWorldMessages,
	systemPrompt,
	worldSystemPrompt,
	type ComposeCharArgs,
	type ComposeWorldArgs,
} from "./assembly";
import {
	buildScoringMessages,
	parseScoringResult,
	type ScoringInput,
	type ScoringResult,
} from "./scoring";
import {
	applyFactRescue,
	buildFactRescueMessages,
	buildSummarizeMessages,
	chapterFoldApply,
	chapterFoldBuild,
	type ChapterFoldApplyInput,
	type ChapterFoldApplyResult,
	type ChapterFoldBuildInput,
	type FactRescueInput,
	type SummarizeBuildResult,
	type SummarizeFoldInput,
} from "./summarize";
import type {
	ApiMessage,
	ChatContext,
	EffectiveOptions,
	LoreInjection,
	Turn,
	WorldContext,
} from "./types";
import {
	assembleContext,
	type AssembleInput,
	type AssembledContext,
	type ContextSlot,
} from "@erpocalypse/core/lorebook";

export type AssembleRequest =
	// Fine-grained ops (used by the byte-parity tests).
	| {
			op: "sys";
			dto: ChatContext;
			opts: EffectiveOptions;
			lore?: LoreInjection;
	  }
	| { op: "world"; dto: WorldContext; adult: boolean; lore?: LoreInjection }
	| {
			op: "bm";
			systemContent: string;
			history: Turn[];
			budget: number;
			trailing?: string;
			loreInline?: LoreInjection["inline"];
			summary?: string;
	  }
	// Whole-turn ops the enclave actually calls: preamble + lore + system prompt +
	// budgeted transcript → the final OpenAI `messages` array.
	| ({ op: "char" } & ComposeCharArgs)
	| ({ op: "world_turn" } & ComposeWorldArgs)
	// Operator-blind SCORING (Phase 3): the enclave builds the scoring request
	// body here, makes the provider call itself, then parses the JSON content back
	// — both halves share the API's implementation (no Python re-port to drift).
	| ({ op: "score_build" } & ScoringInput)
	| ({ op: "score_parse"; content: string | null } & ScoringInput)
	// Operator-blind LOREBOOK MATCHING (enclave-side). Takes the full
	// AssembleInput (scene messages, character, persona, lorebooks + entries,
	// attachments, prevState) and runs the engine to produce matched context
	// slots. The Python server.py converts slots to a LoreInjection and injects
	// it into the main char/world_turn assembly.
	| ({ op: "lore_match" } & AssembleInput)
	// Operator-blind ROLLING-SUMMARY FOLD (BAC-98): the enclave builds the
	// merge-summary request here (the SAME bytes the API's summarizeDropped
	// sends on the direct path), makes the platform provider call itself, and
	// DEK-encrypts the merged summary for the meta frame. LEGACY since BAC-113
	// (chapter folds below) — kept so an old API and this binary stay
	// compatible during a cutover window.
	| ({ op: "summarize_build" } & SummarizeFoldInput)
	// Operator-blind CHAPTER FOLD (BAC-113/118): build the next-chapter request,
	// then apply the provider's completion to the chapter log (scrub, append,
	// roll-up bookkeeping). The enclave drives: chapter_build → provider →
	// chapter_apply (→ provider roll-up → chapter_apply with `merged`). Both
	// halves are the API foldChapter's own functions — no drift.
	| ({ op: "chapter_build" } & ChapterFoldBuildInput)
	| ({ op: "chapter_apply" } & ChapterFoldApplyInput)
	// Operator-blind FACT RESCUE (BAC-116/118, Plus+): durable facts in the
	// folded-out turns graduate into the first-person recollection. facts_build
	// → provider → facts_apply (scrub + cap).
	| ({ op: "facts_build" } & FactRescueInput)
	| { op: "facts_apply"; out: string | null; maxChars: number };

/** Build-op result (the scoring request messages + the only varying param). */
export interface ScoreBuildResult {
	messages: { role: "system" | "user"; content: string }[];
	maxTokens: number;
}

export type AssembleResult =
	| string
	| ApiMessage[]
	| ScoreBuildResult
	| ScoringResult
	| AssembledContext
	| SummarizeBuildResult
	| ChapterFoldApplyResult
	| null;

export function runAssembleRequest(r: AssembleRequest): AssembleResult {
	switch (r.op) {
		case "sys":
			return systemPrompt(r.dto, r.opts, r.lore);
		case "world":
			return worldSystemPrompt(r.dto, r.adult, r.lore);
		case "bm":
			return buildMessages(
				r.systemContent,
				r.history,
				r.budget,
				r.trailing,
				r.loreInline,
				r.summary,
			);
		case "char":
			return composeCharMessages(r);
		case "world_turn":
			return composeWorldMessages(r);
		case "score_build":
			return buildScoringMessages(r);
		case "score_parse":
			return parseScoringResult(r, r.content);
		case "lore_match":
			return assembleContext(r);
		case "summarize_build":
			return buildSummarizeMessages(r);
		case "chapter_build":
			return chapterFoldBuild(r);
		case "chapter_apply":
			return chapterFoldApply(r);
		case "facts_build":
			return buildFactRescueMessages(r);
		case "facts_apply":
			return applyFactRescue(r.out, r.maxChars);
	}
}
