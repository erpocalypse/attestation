/** `@erpocalypse/core/chat` — pure, dependency-free prompt assembly shared by the
 *  API (BYOK / direct path) and the attested enclave (operator-blind path). One
 *  implementation → byte-identical prompts → DeepSeek's prefix cache survives. */
export * from "./types";
export * from "./difficulty";
export * from "./assembly";
export * from "./macros";
export * from "./dispatch";
export * from "./scoring";
export * from "./summarize";
export { WORLD_CORE, WORLD_LORE } from "./canon";
export { HOUSE_PREAMBLE, SFW_PREAMBLE } from "./house-preamble";
