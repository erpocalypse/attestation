#!/usr/bin/env bash
# Build the enclave EIF reproducibly and emit its measurements. Run on a Nitro
# EC2 host with a PINNED toolchain: docker, git, and an exact aws-nitro-enclaves-cli
# version (the host package supplies the kernel/init blobs baked into the EIF, so
# its version is part of the reproducibility recipe — see NITRO_CLI_VERSION).
#
#   ./build.sh           # build EIF + write measurements.json
#   ./build.sh verify    # build the EIF TWICE and assert identical PCR0 (the gate)
#   ./build.sh vendor     # (re)build kmstool + assembler from pins + record hashes
#   ./build.sh assembler  # (re)compile just the prompt-assembler with pinned Bun
#
# Determinism model: every input is frozen and wall-clock time is erased.
#   - SDK pinned by COMMIT (not the movable tag)         → stable kmstool source
#   - kmstool binaries hash-verified against vendor/SHA256SUMS → fixed input layer
#   - base image digest + dnf releasever + pip hashes (in Dockerfile) → stable rootfs
#   - SOURCE_DATE_EPOCH + mtime clamp (in Dockerfile)    → no timestamp drift
set -euo pipefail
cd "$(dirname "$0")"

# ── Pins (the published recipe; bump deliberately) ──────────────────────────
SDK_REF="${SDK_REF:-v0.4.5}"
# Full commit the tag pointed to when pinned. A tag can be re-pointed; a commit
# can't. build.sh asserts the clone resolves to exactly this SHA.
SDK_COMMIT="${SDK_COMMIT:-cd61b6187c8b20867ba4368d1ae62c5790c0269a}" # v0.4.5; enforced
# The digest-pinned base (in the Dockerfile) freezes both the OS image AND its
# dnf package snapshot, so there's no separate releasever/python pin to track.
BASE_DIGEST="${BASE_DIGEST:-sha256:c0073a98af00ecdc97bcf11da04bd01cc9e93bd136d2e5400c6eb861254d09b6}"
# Bun pin for the prompt-assembler binary. The enclave assembles chat prompts
# itself (operator-blind) by running the SAME TypeScript the API runs, compiled
# to a single-file binary so the bytes are identical (DeepSeek prefix cache). Pin
# the compiler so the compiled binary is reproducible; vendored once + hash-locked
# (vendor/SHA256SUMS), exactly like kmstool. Bump deliberately.
BUN_VERSION="${BUN_VERSION:-1.3.10}"
# The assembler entrypoint in the monorepo (this script lives in infra/enclave).
ASSEMBLER_ENTRY="${ASSEMBLER_ENTRY:-../../packages/core/src/chat/bin/assemble.ts}"
# Fixed epoch (2023-11-14) — any constant works; it just must not be "now".
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"
export DOCKER_BUILDKIT=1

BUILD_ARGS=(
	--build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
)

# ── kmstool: build once from the pinned SDK, then pin its binaries by hash ───
# This is the least-reproducible part (AWS's Dockerfile.al2 dnf-installs a
# toolchain), so we don't rebuild it per enclave build. We build it ONCE, record
# the two binary hashes, and thereafter VERIFY them — turning a moving input into
# a fixed one. Reproducing the binaries themselves is a separate, rarer exercise.
vendor_kmstool() {
	rm -rf /tmp/sdk-c
	git clone --depth 1 -b "$SDK_REF" \
		https://github.com/aws/aws-nitro-enclaves-sdk-c /tmp/sdk-c
	local got
	got="$(git -C /tmp/sdk-c rev-parse HEAD)"
	if [ -n "$SDK_COMMIT" ] && [ "$got" != "$SDK_COMMIT" ]; then
		echo "SDK commit drift: expected $SDK_COMMIT, got $got" >&2
		exit 1
	fi
	echo "SDK $SDK_REF @ $got"
	# Apply --encryption-context patch (the stock kmstool-enclave-cli lacks it
	# even though the SDK library supports it since v0.4.2).
	patch -p1 -d /tmp/sdk-c <"$(dirname "$0")/patches/kmstool-encryption-context.patch"
	# Digest-pin the base the SDK build pulls (its own FROM uses the moving tag).
	sed -i "s#^FROM amazonlinux:2023#FROM amazonlinux:2023@${BASE_DIGEST}#g" \
		/tmp/sdk-c/containers/Dockerfile.al2 || true
	docker build --target kmstool-enclave-cli \
		-t inkwell-kmstool:local -f /tmp/sdk-c/containers/Dockerfile.al2 /tmp/sdk-c
	# Extract + hash the two artifacts we actually consume.
	local cid
	cid="$(docker create inkwell-kmstool:local)"
	docker cp "$cid:/kmstool_enclave_cli" vendor/kmstool_enclave_cli
	docker cp "$cid:/usr/lib64/libnsm.so" vendor/libnsm.so
	docker rm "$cid" >/dev/null
	(cd vendor && sha256sum kmstool_enclave_cli libnsm.so >SHA256SUMS)
	echo "Recorded vendor/SHA256SUMS:"
	cat vendor/SHA256SUMS
}

ensure_kmstool() {
	# Need the inkwell-kmstool:local image present with binaries matching the lock.
	if [ -f vendor/SHA256SUMS ] && docker image inspect inkwell-kmstool:local >/dev/null 2>&1; then
		local cid
		cid="$(docker create inkwell-kmstool:local)"
		docker cp "$cid:/kmstool_enclave_cli" /tmp/_k 2>/dev/null
		docker cp "$cid:/usr/lib64/libnsm.so" /tmp/_l 2>/dev/null
		docker rm "$cid" >/dev/null
		local want_k want_l
		want_k="$(grep kmstool_enclave_cli vendor/SHA256SUMS | awk '{print $1}')"
		want_l="$(grep libnsm.so vendor/SHA256SUMS | awk '{print $1}')"
		if [ "$(sha256sum /tmp/_k | awk '{print $1}')" = "$want_k" ] &&
			[ "$(sha256sum /tmp/_l | awk '{print $1}')" = "$want_l" ]; then
			echo "kmstool binaries verified against vendor/SHA256SUMS"
			return 0
		fi
		echo "kmstool hash mismatch — rebuilding from pinned SDK" >&2
	fi
	vendor_kmstool
}

# ── assembler: compile the chat prompt-assembler with the PINNED Bun, once ────
# Same "build once, hash-lock, then verify" model as kmstool. The compiled binary
# is byte-identical to the API's assembly output (CI proves it via
# packages/core/src/chat/binary-parity.test.ts); pinning Bun keeps the binary
# itself reproducible so it doesn't perturb PCR0 across rebuilds. Run on the
# aarch64 build host (the enclave is Graviton), so `bun build --compile` targets
# linux-aarch64 natively.
vendor_assembler() {
	local arch="aarch64"
	rm -rf /tmp/bun-dl && mkdir -p /tmp/bun-dl
	echo "Downloading Bun ${BUN_VERSION} (linux-${arch})"
	local zip="bun-linux-${arch}.zip"
	curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${zip}" \
		-o "/tmp/bun-dl/${zip}"
	# Supply-chain pin: verify the download against the release's published digests.
	# `sha256sum -c` matches by the filename in SHASUMS256.txt, so the local file
	# MUST keep that exact name.
	curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" \
		-o /tmp/bun-dl/SHASUMS256.txt
	(cd /tmp/bun-dl && grep " ${zip}\$" SHASUMS256.txt | sha256sum -c -)
	unzip -q "/tmp/bun-dl/${zip}" -d /tmp/bun-dl
	local bun="/tmp/bun-dl/bun-linux-${arch}/bun"
	chmod +x "$bun"
	echo "Compiling assembler with pinned Bun ${BUN_VERSION}"
	mkdir -p vendor
	"$bun" build "$ASSEMBLER_ENTRY" --compile --outfile vendor/inkwell-assemble
	# Record (idempotently) the assembler hash alongside kmstool's in SHA256SUMS.
	(
		cd vendor
		touch SHA256SUMS
		grep -v ' inkwell-assemble$' SHA256SUMS >SHA256SUMS.tmp || true
		sha256sum inkwell-assemble >>SHA256SUMS.tmp
		sort -k2 SHA256SUMS.tmp -o SHA256SUMS
		rm -f SHA256SUMS.tmp
	)
	echo "Recorded vendor/inkwell-assemble:"
	(cd vendor && grep inkwell-assemble SHA256SUMS)
}

ensure_assembler() {
	if [ -f vendor/inkwell-assemble ] && grep -q ' inkwell-assemble$' vendor/SHA256SUMS 2>/dev/null; then
		local want
		want="$(grep ' inkwell-assemble$' vendor/SHA256SUMS | awk '{print $1}')"
		if [ "$(sha256sum vendor/inkwell-assemble | awk '{print $1}')" = "$want" ]; then
			echo "assembler binary verified against vendor/SHA256SUMS"
			return 0
		fi
		echo "assembler hash mismatch — recompiling with pinned Bun" >&2
	fi
	vendor_assembler
}

# ── EIF build: deterministic rootfs → flatten → nitro-cli pack → PCR0 ────────
# NOCACHE=1 forces a from-scratch image rebuild (re-runs dnf/pip + the cleanup
# layer). `verify` sets it so the two builds genuinely re-derive the rootfs — a
# plain rebuild hits the BuildKit cache and would mask rootfs non-determinism
# (this is the gap that let the rpmdb.sqlite drift ship undetected).
#
# THE FLATTEN (the cross-host reproducibility fix): BuildKit's per-layer tars are
# NOT byte-reproducible across builds/hosts even when the file *content* is
# identical — entry ordering and per-build metadata vary — and nitro-cli faithfully
# packs whatever image it's handed, so a plain `docker build` → nitro-cli yields a
# different PCR every time. nitro-cli itself IS deterministic given an identical
# image (verified: same image in → same PCR out). So we collapse the image to one
# normalized layer: export the rootfs, re-pack it as a sorted, fixed-mtime,
# root-owned tar, and re-import (carrying the image's ENV/CMD forward verbatim via
# `docker inspect`, so the Dockerfile stays authoritative). Identical content →
# identical tar → identical image → identical PCR0, on any host. (Content
# determinism is the Dockerfile's job — pinned base/deps + rpm/dnf DB removal.)
build_eif() { # $1 = output .eif path
	docker build ${NOCACHE:+--no-cache} "${BUILD_ARGS[@]}" -t inkwell-enclave:raw .
	# Export → normalize → re-import as a single deterministic layer.
	local cid; cid="$(docker create inkwell-enclave:raw)"
	rm -rf /tmp/eif-rootfs && mkdir -p /tmp/eif-rootfs
	docker export "$cid" | tar -C /tmp/eif-rootfs -xf -
	docker rm "$cid" >/dev/null
	tar --sort=name --format=ustar --mtime="@${SOURCE_DATE_EPOCH}" \
		--owner=0 --group=0 --numeric-owner -C /tmp/eif-rootfs -cf /tmp/eif-rootfs.tar . 2>/dev/null
	# Carry ENV + CMD forward from the built image (don't hardcode → no drift).
	local import_args=()
	while IFS= read -r e; do [ -n "$e" ] && import_args+=( -c "ENV $e" ); done \
		< <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' inkwell-enclave:raw)
	import_args+=( -c "CMD $(docker inspect -f '{{json .Config.Cmd}}' inkwell-enclave:raw)" )
	docker import "${import_args[@]}" /tmp/eif-rootfs.tar inkwell-enclave:latest >/dev/null
	[ -f /etc/profile.d/nitro-cli-env.sh ] && . /etc/profile.d/nitro-cli-env.sh || true
	export NITRO_CLI_ARTIFACTS="${NITRO_CLI_ARTIFACTS:-/usr/share/nitro_enclaves/blobs}"
	nitro-cli build-enclave --docker-uri inkwell-enclave:latest --output-file "$1" >/dev/null
	nitro-cli describe-eif --eif-path "$1" | jq -r '.Measurements.PCR0'
}

case "${1:-build}" in
vendor)
	vendor_kmstool
	vendor_assembler
	;;
assembler)
	vendor_assembler
	;;
lock)
	# Generate a hash lock for the pinned deps (run on the aarch64 build host).
	# Binary-only is deliberate: an sdist would make PCR0 depend on an unpinned
	# compiler toolchain. On AL2023/aarch64 pip selects exactly these wheels.
	rm -rf /tmp/wheels && mkdir -p /tmp/wheels
	pip3 download --no-deps --only-binary=:all: -d /tmp/wheels \
		-r app/requirements.txt
	{ grep -vE '^\s*#|^\s*$' app/requirements.txt | while read -r pkg; do
		f="$(ls /tmp/wheels | grep -iE "^${pkg%%==*}-" | head -1)"
		[ -n "$f" ] || {
			echo "No binary wheel downloaded for $pkg" >&2
			exit 1
		}
		printf '%s \\\n    --hash=sha256:%s\n' "$pkg" \
			"$(sha256sum "/tmp/wheels/$f" | awk '{print $1}')"
	done; } >app/requirements.lock
	echo "Wrote app/requirements.lock:"
	cat app/requirements.lock
	;;
build)
	ensure_kmstool
	ensure_assembler
	# build_eif runs in a subshell (command substitution), so its export of
	# NITRO_CLI_ARTIFACTS doesn't reach here — set it for the blobs step below.
	[ -f /etc/profile.d/nitro-cli-env.sh ] && . /etc/profile.d/nitro-cli-env.sh || true
	export NITRO_CLI_ARTIFACTS="${NITRO_CLI_ARTIFACTS:-/usr/share/nitro_enclaves/blobs}"
	PCR0="$(build_eif inkwell-enclave.eif)"
	nitro-cli describe-eif --eif-path inkwell-enclave.eif |
		jq '{PCR0: .Measurements.PCR0, PCR1: .Measurements.PCR1, PCR2: .Measurements.PCR2}' \
			>measurements.json
	# The kernel/init blobs are also part of PCR0's provenance — publish them.
	(cd "${NITRO_CLI_ARTIFACTS}" && sha256sum * 2>/dev/null) >blobs.sha256 || true
	echo "PCR0=$PCR0"
	echo "Wrote measurements.json + blobs.sha256"
	;;
verify)
	# The acceptance test: same recipe must yield the same PCR0. Build the
	# enclave EIF twice (kmstool + assembler pinned once as fixed inputs) and
	# compare. NOCACHE=1 forces each build to re-derive the rootfs from scratch so
	# this actually tests image determinism, not just nitro-cli packing.
	ensure_kmstool
	ensure_assembler
	NOCACHE=1
	A="$(build_eif /tmp/a.eif)"
	echo "PCR0 #1: $A"
	B="$(build_eif /tmp/b.eif)"
	echo "PCR0 #2: $B"
	if [ "$A" = "$B" ]; then echo "REPRO_OK $A"; else
		echo "REPRO_FAIL $A != $B"
		exit 1
	fi
	;;
*)
	echo "usage: build.sh [build|verify|vendor|assembler|lock]" >&2
	exit 2
	;;
esac
