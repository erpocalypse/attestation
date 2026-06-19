# inkwell.rip — operator-blind enclave attestation

This is the public source mirror for the part of [inkwell.rip](https://inkwell.rip)
that has to be public to be trustworthy: the **AWS Nitro enclave** that processes
private ("sealed") chats operator-blind, and the **in-browser verifier** behind
[inkwell.rip/security](https://inkwell.rip/security).

It is not the whole product — only the code on the trust boundary. With it you can:

1. **Read** the exact code that touches sealed-chat plaintext (the enclave
   supervisor + the prompt assembler it runs).
2. **Rebuild** that code and reproduce the enclave measurement (**PCR0**) we
   publish — see [`infra/enclave/REPRODUCIBILITY.md`](infra/enclave/REPRODUCIBILITY.md).
3. **Verify**, from your own browser, that the *live* enclave is genuine AWS Nitro
   hardware running that exact measured image — trusting only AWS's root CA and the
   code in this repo, not our API.

## What is and isn't claimed

**Claimed:** the host operator (us) cannot read sealed-chat plaintext. Sealed
messages are encrypted in your browser to a key bound into a fresh attestation
document, and can only be opened inside an enclave whose measurement matches the
PCR0 pinned in the published browser client (`src/attestation.ts`). That measurement
is reproducible from the source here. The operator relays only opaque ciphertext.

**Not claimed:** that *no one* can ever see the text. Model **inference** runs at an
external provider, which is a separate trust boundary — the enclave makes the host
blind, not the inference provider. And the prompt **wording** is delivered to the
measured binary as runtime data, so it is *not* itself attested (it cannot make the
measured code leak plaintext, but it isn't part of PCR0). The `/security` page states
both limits plainly; so does `REPRODUCIBILITY.md`.

## Layout

```
infra/enclave/            the measured enclave image + its reproducible build
  Dockerfile, build.sh    pinned, deterministic EIF build (PCR0)
  app/server.py           the in-enclave supervisor (KMS unwrap, vsock, assemble)
  measurements.json       the published PCR0 / PCR1 / PCR2
  REPRODUCIBILITY.md      how to rebuild and reproduce PCR0 yourself
packages/core/src/chat/   the prompt assembler compiled into the measured binary
  bin/assemble.ts         the single entrypoint Bun-compiles into the enclave
  promptpack/             the CONTENT interface (types only) — no prompt strings
packages/core/src/lorebook/  context-assembly engine used by the assembler
src/                      the in-browser attestation verifier (drives /security)
```

## Why the prompt content isn't here (and why that's fine)

The measured binary `vendor/inkwell-assemble` is compiled from
`packages/core/src/chat/bin/assemble.ts`. As of the PromptPack split it contains
**only assembly logic** — none of the proprietary prompt content (jailbreak, world
canon, scoring rubric). That content is supplied at runtime as data: the enclave
KMS-unwraps it (attestation-gated to this same PCR0) and pipes it to the binary on
stdin. The private values live in `promptpack/default.ts`, which is **excluded from
this mirror and never reachable from `bin/assemble.ts`**.

That split is exactly what makes the source here reproduce the published PCR0
*without* exposing prompt IP: the binary measures pure logic. The honest consequence,
spelled out in `REPRODUCIBILITY.md`: the *code* that processes plaintext is public and
measured; the prompt *wording* is unattested runtime data.

## Reproduce PCR0

On a Nitro-capable Graviton host (`c6g`, with `aws-nitro-enclaves-cli`):

```sh
cd infra/enclave
./build.sh verify    # builds the EIF twice, asserts an identical PCR0 (REPRO_OK)
```

Then compare the result against `infra/enclave/measurements.json` and against the
live enclave's attestation, which your browser checks on `/security`. Full procedure,
determinism notes, and current verification status are in
[`infra/enclave/REPRODUCIBILITY.md`](infra/enclave/REPRODUCIBILITY.md).

## Requirements

- [Bun](https://bun.sh) >= 1.3.0 (the pinned compiler for the assembler binary; the
  exact version is set in `infra/enclave/build.sh`)
- Docker + `aws-nitro-enclaves-cli` on an aarch64 Nitro host to build the EIF
