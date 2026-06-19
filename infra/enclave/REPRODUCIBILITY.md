# PCR0 Reproducibility

## What this is

PCR0 is the enclave's measurement — a SHA-384 hash of the initial enclave state
(kernel, init, application rootfs + Docker image). Every EIF build produces a
unique PCR0. When the EIF is built from identical inputs (same source tree, same
Docker base image digest, same vendored binaries, same SOURCE_DATE_EPOCH), two
builds on the **same hardware** should produce the same PCR0.

## Prompt content is runtime data, not measured (BAC-136)

The measured binary `vendor/inkwell-assemble` is compiled from
`packages/core/src/chat/bin/assemble.ts` and its imports. As of the PromptPack
split it contains **only assembly logic** — none of the proprietary prompt content
(jailbreak, world canon, scoring/anti-slop rubric). That content is supplied to the
binary at runtime as a JSON **PromptPack** on stdin (`{ requests, promptPack }`); in
production the enclave KMS-unwraps it, attestation-gated to this same PCR0, and pipes
it in. The private values live in `packages/core/src/chat/promptpack/default.ts`,
which is **excluded from the public mirror** and is never reachable from
`bin/assemble.ts` (enforced by an import-graph check: `assembly/scoring/summarize/
dispatch/bin` never import `default.ts` / `canon.ts` / `house-preamble.ts`).

Consequence for verification: the published engine source reproduces the PCR0
**without** exposing prompt IP. What attestation proves is therefore precise — the
exact *code* that processes plaintext is public and measured; the prompt *wording* is
unattested runtime data (it cannot make the measured code leak plaintext). State this
honestly on `/security`; do not imply the prompts themselves are attested.

**Outsider reproduction** (anyone, from the public mirror):
1. Clone the `erpocalypse/attestation` mirror (ships `infra/enclave/**` +
   `packages/core/src/chat/**` minus `promptpack/default.ts`, plus
   `packages/core/src/lorebook/**`).
2. `./build.sh assembler` — compiles the content-free assembler with the pinned Bun.
3. `./build.sh verify` on a fresh c6g from the pinned AMI `ami-0a2a049c945b84826` —
   builds the EIF twice and asserts identical PCR0.
4. Compare against the committed `measurements.json` PCR0 (and the live enclave's
   attestation doc, which the browser checks on `/security`).

## Verification procedure

`build.sh verify` builds the EIF twice and asserts identical PCR0:

```bash
./build.sh verify
# Expected output:
# PCR0 #1: <hash>
# PCR0 #2: <hash>
# REPRO_OK <hash>
```

This is a **same-host** reproducibility check. It verifies that no build input
(src timestamps, network-dependent layers, etc.) varies between consecutive
runs. The check runs automatically during the deploy procedure.

## Cross-host reproducibility

Two different Nitro EC2 instances (same instance type, e.g. both c6g.xlarge)
should produce the same PCR0 from the same inputs, **provided**:
- The same `nitro-cli` version is installed (pinned via build.sh)
- The same kernel/init blob version is present (NITRO_CLI_ARTIFACTS)
- The Docker base image digest is identical (pinned via build.sh)

**Cross-host reproducibility is CONFIRMED for the live image** (`4d7e01f2…`): three
independent fresh hosts built from this public mirror and produced byte-identical
PCR0, **on the pinned build AMI** below. Every file that enters the enclave
(assembler, kmstool, libnsm, server.py, the nitro boot blobs → PCR1) is byte-identical
across hosts; the only build-host-sensitive part is the rootfs ramdisk *packing
metadata* (PCR2), which the pinned AMI makes deterministic.

To reproduce:
1. Launch a c6g host from AMI `ami-0a2a049c945b84826`
   (`al2023-ami-2023.11.20260526.0-kernel-6.1-arm64`).
2. Run `./build.sh verify` — builds the EIF twice and asserts identical PCR0.
3. Compare the PCR0 to the committed `measurements.json` and the live `/security`
   attestation. (CPU serial numbers etc. do NOT affect PCR0 — only the EIF content.)

## Current status

| Check | Status |
|---|---|
| Same-host reproducible | Verified for `4d7e01f2…` (`build.sh verify` builds twice `--no-cache`, REPRO_OK) |
| Cross-host reproducible | **Confirmed** for `4d7e01f2…` — 3 independent fresh hosts on the pinned AMI produced identical PCR0 |
| Cross-AMI reproducible | Build on the pinned AMI `ami-0a2a049c945b84826`; rootfs packing (PCR2) is AMI-sensitive |

## Determinism fixes (what made cross-host reproducible)

Two non-source inputs were leaking per-build entropy into the rootfs (PCR2); both
are now fixed and PCR1 was always stable:

1. **RPM/dnf databases** — `/var/lib/rpm/rpmdb.sqlite` embeds per-install
   transaction ids + sqlite page layout, so its *content* differs on every build.
   The Dockerfile's final layer now deletes `/var/lib/rpm` and `/var/lib/dnf`
   (the enclave never uses them at runtime). This was the sole same-host diff.
2. **BuildKit layer non-determinism** — BuildKit emits non-reproducible layer
   tars (entry ordering + metadata vary per build) even when file content is
   identical, and `nitro-cli` faithfully packs whatever image it's given.
   `build_eif` now **flattens** the built image to a single normalized layer
   (`docker export` → sorted, fixed-mtime, root-owned tar → `docker import`,
   carrying ENV/CMD forward) before `nitro-cli build-enclave`. `nitro-cli` itself
   is deterministic given an identical image, so this yields a stable PCR0.

`build.sh verify` now builds `--no-cache` on both passes so it actually exercises
image determinism (a plain rebuild hit the BuildKit cache and masked the drift).

## If reproducibility fails

1. Check `nitro-cli --version` matches across hosts
2. Check `sha256sum` of blobs in NITRO_CLI_ARTIFACTS
3. Check that `docker image inspect inkwell-enclave:latest` returns the same
   image digest
4. Check that `vendor/SHA256SUMS` matches the installed vendor binaries
5. The most common cause: the Dockerfile's `pip install` downloads packages
   that vary by platform/python-version; pin them via `requirements.lock`
