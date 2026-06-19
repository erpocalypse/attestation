/** `@erpocalypse/core/chat` — pure, dependency-free prompt assembly shared by the
 *  API (BYOK / direct path) and the attested enclave (operator-blind path). One
 *  implementation → byte-identical prompts → DeepSeek's prefix cache survives. */
export * from "./types";
export * from "./difficulty";
export * from "./assembly";
export * from "./dispatch";
export * from "./scoring";
export * from "./summarize";
// The proprietary prompt CONTENT (house preamble, world canon, rubrics) is NOT
// here: it lives in the private PromptPack, delivered to the engine at runtime as
// data (the enclave receives it KMS-wrapped, attestation-gated to PCR0; the API
// installs it at boot). That is exactly what lets this source be public and the
// compiled assembler reproduce the published PCR0 without leaking the content.
// See ./promptpack/types.ts for the (content-free) interface.
export type { PromptPack } from "./promptpack/types";
export { setPromptPack, hasPromptPack, pack, fill } from "./promptpack/active";
