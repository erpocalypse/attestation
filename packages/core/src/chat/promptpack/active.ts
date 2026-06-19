/** The active PromptPack — a process-wide, set-once handle the engine reads its
 *  prompt content from. This module is in the assembler binary's import graph, so
 *  it MUST NOT import `default.ts` (that would pull the secret strings back into
 *  the measured image). Instead:
 *    - the enclave binary installs the pack from its stdin envelope (bin/assemble),
 *    - the API installs the default pack at boot (via ./install-default),
 *    - tests install the default pack the same way.
 *  `pack()` throws if nothing is installed — fail closed, never silently assemble
 *  with missing content. */
import type { PromptPack } from "./types";

let activePack: PromptPack | null = null;

export function setPromptPack(p: PromptPack): void {
  activePack = p;
}

export function hasPromptPack(): boolean {
  return activePack !== null;
}

export function pack(): PromptPack {
  if (!activePack) {
    throw new Error(
      "PromptPack not installed: call setPromptPack() (API boot / test setup) " +
        "or pipe { requests, promptPack } into the assembler stdin.",
    );
  }
  return activePack;
}

/** Fill `{token}` placeholders in a content string from `vars`. Used ONLY for
 *  pack strings that carry interpolation AND no literal curly braces (the engine
 *  keeps brace-bearing content — e.g. scoring's JSON spec — verbatim, never
 *  through fill). Unknown tokens render empty. */
export function fill(
  tpl: string,
  vars: Record<string, string | number>,
): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) =>
    k in vars ? String(vars[k]) : "",
  );
}
