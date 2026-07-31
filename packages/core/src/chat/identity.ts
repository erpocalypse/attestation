/**
 * `@erpocalypse/core/chat` — pure, dependency-free identity extraction.
 *
 * Targets the #1 "the character forgot my name" complaint with a cheap,
 * deterministic, LLM-free heuristic that runs on the user's turn BEFORE the
 * fold can evict it. English-only by design (v1); non-English or ambiguous
 * intros fall through to the model-authored memory at the computeState cadence.
 *
 * Returns the FIRST confident name hit and/or explicitly-stated pronouns, or
 * null. A name requires an explicit "my name is/name's" or "call me" phrase,
 * plus a Capitalized captured token. Conversational "I am/I'm" phrases are not
 * identity evidence.
 */

/** A user-stated identity, surfaced as a durable auto-pin. */
export interface ExtractedIdentity {
	name?: string;
	pronouns?: "he" | "she" | "they";
}

// Trigger phrases are matched case-insensitively; the captured token is then
// re-validated for Capitalization below, so the `i` flag can't leak into the
// name-token check (which must stay case-sensitive to reject lowercase).
const NAME_TRIGGERS: RegExp[] = [
	/\bmy name(?: is|'s)\s+([A-Za-z][\w'’-]{1,19})\b/i,
	/\bcall me\s+([A-Za-z][\w'’-]{1,19})\b/i,
];

const PRONOUN_TRIGGER =
	/\bmy pronouns are\s+(they|she|he)[\s/](?:them|her|him)\b/i;

/** True only for a Capitalized token: starts upper-case AND has a lower-case
 *  letter (so "Ren"/"Aria"/"McKenzie" pass; "ren"/"SO"/"THE" don't). */
function isCapitalized(token: string): boolean {
	return /^[A-Z]/.test(token) && /[a-z]/.test(token);
}

/** Best-effort identity extraction from a user-authored turn. Returns the first
 *  confident name hit and/or stated pronouns, or null when nothing matches. */
export function extractIdentity(text: string): ExtractedIdentity | null {
	const trimmed = text?.trim();
	if (!trimmed) return null;

	let name: string | undefined;
	for (const re of NAME_TRIGGERS) {
		const m = trimmed.match(re);
		const tok = m?.[1];
		if (tok && isCapitalized(tok)) {
			name = tok;
			break;
		}
	}

	let pronouns: ExtractedIdentity["pronouns"];
	const pm = trimmed.match(PRONOUN_TRIGGER);
	if (pm?.[1]) {
		const p = pm[1].toLowerCase();
		if (p === "he" || p === "she" || p === "they") pronouns = p;
	}

	if (!name && !pronouns) return null;
	return {
		...(name ? { name } : {}),
		...(pronouns ? { pronouns } : {}),
	};
}
