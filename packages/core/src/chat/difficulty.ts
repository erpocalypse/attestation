/** Difficulty bounds + clamp — the 1–9 "how hard to win them over" scale. Moved
 *  here (from the API's plans.ts, which now re-exports these) so the pure prompt
 *  assembly that runs in BOTH the API and the attested enclave shares one source
 *  of truth. Trivial + dependency-free on purpose. */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 9;
export const DEFAULT_DIFFICULTY = 5;

export function clampDifficulty(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, Math.round(n)));
}
