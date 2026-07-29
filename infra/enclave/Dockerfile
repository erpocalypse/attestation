# Reproducible enclave image (arm64/Graviton). The whole point of this file is a
# BIT-FOR-BIT identical rootfs on every build, so the EIF's PCR0 is a stable
# number we can publish and a client can verify against the live attestation.
# Determinism is achieved by freezing every input and erasing wall-clock time:
#   • base image pinned by DIGEST (not the moving :2023 tag)
#   • dnf frozen to an AL2023 dated repo SNAPSHOT (releasever) + exact pkg version
#   • pip locked by exact version (transitive too); hash-locking (--require-hashes)
#     is a TODO, not yet enforced — so installs are not yet hash-verified
#   • kmstool/libnsm copied from a digest-pinned prebuilt stage (see build.sh)
#   • all mtimes clamped to SOURCE_DATE_EPOCH and volatile state pruned at the end
# Change any input → PCR0 changes (that's the feature). build.sh enforces the
# pins and runs a build-twice gate that fails if two PCR0s differ.

# Pinnable inputs — build.sh is the single source of truth and passes them in.
ARG SOURCE_DATE_EPOCH=1700000000

# Step-1 output (built once from a commit-pinned SDK in build.sh); its binaries
# are hash-verified before this build runs, so this stage is effectively pinned.
FROM inkwell-kmstool:local AS kmstool

# arm64 (Graviton). Digest-pinned: the tag :2023 moves, the digest does not.
# Crucially, the AL2023 image is itself built against a DATED repo snapshot baked
# into its dnf config — so pinning the digest freezes the entire package universe
# too. `dnf install` below resolves to a fixed version with no extra releasever
# pin needed (one pin that can't disagree with itself, vs. two that must match).
FROM amazonlinux:2023@sha256:c0073a98af00ecdc97bcf11da04bd01cc9e93bd136d2e5400c6eb861254d09b6
ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    PIP_NO_COMPILE=1 \
    PYTHONDONTWRITEBYTECODE=1

# `python3` on AL2023 is 3.9.x, frozen by the digest-pinned base's snapshot.
# `--setopt=tsflags=nodocs` drops man pages (volatile, irrelevant) to shrink the
# rootfs surface that PCR0 measures.
RUN dnf -y --setopt=tsflags=nodocs install python3 python3-pip \
 && dnf clean all

# AWS-built primitives: the KMS-in-enclave CLI + the attestation lib (ctypes).
COPY --from=kmstool /kmstool_enclave_cli /usr/bin/kmstool_enclave_cli
COPY --from=kmstool /usr/lib64/libnsm.so /usr/lib64/libnsm.so
RUN chmod 0755 /usr/bin/kmstool_enclave_cli

# Python deps: EXACT-version pinned (incl. transitive) → byte-identical installs
# from PyPI's immutable wheels. Hardening step is `--require-hashes` once the
# build host has generated the hash lock (see requirements.txt / `build.sh lock`).
COPY app/requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

COPY app/server.py app/memory_cadence.py app/provider_routing.py /app/

# The chat prompt-assembler: a Bun-compiled single-file binary running the SAME
# @erpocalypse/core/chat TypeScript the API runs, so the prompts it builds inside
# the enclave are byte-identical to the API's (DeepSeek prefix cache survives).
# Hash-pinned in vendor/SHA256SUMS and compiled once by build.sh (pinned Bun), so
# it's a fixed input layer — exactly like kmstool. server.py shells out to it.
COPY vendor/inkwell-assemble /usr/local/bin/inkwell-assemble
RUN chmod 0755 /usr/local/bin/inkwell-assemble

# Erase wall-clock time AND non-deterministic package-manager state: clamp every
# mtime to SOURCE_DATE_EPOCH and delete the volatile state dnf/pip leave behind.
# Critically this includes the WHOLE rpm + dnf databases, not just dnf history:
# /var/lib/rpm/rpmdb.sqlite embeds per-install transaction ids + sqlite page
# layout, so its *content* (not just mtime) differs on every build — it was the
# sole source of PCR2 non-determinism (proven: two from-scratch builds differ in
# exactly this one file). The enclave never uses rpm/dnf at runtime, so dropping
# both DBs is safe and makes the rootfs byte-identical → reproducible PCR0. This
# must be the LAST filesystem layer so nothing re-stamps after it.
RUN rm -rf /var/cache/* /var/log/* /var/lib/dnf /var/lib/rpm /tmp/* /root/.cache \
 && find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
        -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} + 2>/dev/null || true

# Inference egress target. server.py requires PROVIDER_HOST at startup; it's
# reached ONLY through host vsock-proxy tunnels whose allowlist is crof, MiMo,
# DeepInfra, and KMS (see user-data.sh.tftpl). Provider hosts, paths, and model
# ids are baked here so the exact egress contract is part of the measured,
# reproducible image users attest.
ENV PROVIDER_HOST=crof.ai \
    PROVIDER_PATH=/v1/chat/completions \
    MIMO_HOST=api.xiaomimimo.com \
    MIMO_PATH=/v1/chat/completions \
    MIMO_MODEL=mimo-v2.5 \
    KMS_REGION=us-west-2

# CSAM moderation egress (BAC-135): the in-enclave child-safety screen calls
# DeepInfra (Llama-3.2-Vision) over a SECOND vsock-proxy tunnel the host
# allow-lists to this host. Baked here so the moderation endpoint is part of the
# measured, attested image — like the provider above. The key is injected per
# request (KMS-wrapped); empty DEEPINFRA_HOST would disable the screen.
ENV DEEPINFRA_HOST=api.deepinfra.com \
    DEEPINFRA_PATH=/v1/openai/chat/completions \
    DEEPINFRA_MODEL=meta-llama/Llama-3.2-11B-Vision-Instruct

# No shell is reachable in production; this is the only entrypoint.
CMD ["python3", "/app/server.py"]
