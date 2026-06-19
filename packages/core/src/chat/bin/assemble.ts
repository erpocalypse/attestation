/** Enclave-facing prompt-assembly CLI — the operator-blind chat's assembler.
 *
 *  This is the SINGLE file `bun build --compile`d into the aarch64 binary that
 *  runs inside the Nitro enclave (Phase 2). It contains no transport, no crypto,
 *  no secrets: it reads a batch of assembly requests as JSON on stdin and writes
 *  the assembled prompts as JSON on stdout. The enclave's Python supervisor pipes
 *  decrypted ingredients in and gets byte-identical prompts out — identical to
 *  what the API would have produced (proven by binary-parity.test.ts), so the
 *  DeepSeek prefix cache survives the move into the enclave.
 *
 *  Protocol:
 *    stdin : {"requests": AssembleRequest[]}
 *    stdout: {"results": (string | ApiMessage[])[]}   (same order as requests)
 *    errors: {"error": "<message>"} on stdout, exit 1
 */
import { runAssembleRequest, type AssembleRequest } from "../dispatch";
import { setPromptPack } from "../promptpack/active";
import type { PromptPack } from "../promptpack/types";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const { requests, promptPack } = JSON.parse(input) as {
      requests: AssembleRequest[];
      promptPack?: PromptPack;
    };
    if (!Array.isArray(requests)) throw new Error("expected { requests: [] }");
    // The PromptPack carries all proprietary prompt content; the binary ships with
    // none, so the enclave (and the parity tests) MUST supply it here. Without it
    // the first assembly throws "PromptPack not installed" — fail closed.
    if (promptPack) setPromptPack(promptPack);
    const results = requests.map(runAssembleRequest);
    process.stdout.write(JSON.stringify({ results }));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
    process.exit(1);
  }
}

await main();
