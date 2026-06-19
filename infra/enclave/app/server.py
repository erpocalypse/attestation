"""
Inkwell confidential enclave — processes every chat turn in plaintext inside a
sealed AWS Nitro environment. No network interface, no standing credentials.
Operator-blind by construction: the parent relays ciphertext it can't open.

Egress is a single vsock-proxy tunnel to a configurable provider endpoint.
BYOK reseals the prompt to the client instead (the enclave can't reach
arbitrary user-specified endpoints). Scoring runs through the same tunnel.

Reference implementation — the published source that produces the PCR0
measurement users verify against their browser's attestation document.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import subprocess

from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PARENT_CID = 3
KMS_VSOCK_PORT = 8001
PROVIDER_VSOCK_PORT = 8002
LISTEN_PORT = 5005

KMS_REGION = os.environ.get("KMS_REGION", "us-west-2")
PROVIDER_HOST = os.environ.get("PROVIDER_HOST")
if PROVIDER_HOST is None:
    raise RuntimeError("PROVIDER_HOST is required")
PROVIDER_PATH = os.environ.get("PROVIDER_PATH", "/chat/completions")
PROVIDER_KEY_CIPHERTEXT_B64 = os.environ.get("PROVIDER_KEY_CIPHERTEXT_B64", "")
# PromptPack (BAC-136): the proprietary prompt CONTENT (jailbreak, world canon,
# scoring/anti-slop rubric). KMS-wrapped and injected per request by the host
# forwarder (exactly like the provider key) and unwrapped here, attestation-gated to
# this PCR0. The compiled assembler binary carries NONE of it, so PCR0 is
# reproducible from public source; the content arrives as runtime data instead.
PROMPTPACK_CIPHERTEXT_B64 = os.environ.get("PROMPTPACK_CIPHERTEXT_B64", "")
ATT_DOC_MAX = 16 * 1024

# ---- CSAM moderation (operator-blind text screen) --------------------------
# The blind path's plaintext user message exists ONLY here, so the CSAM screen
# must run in-enclave. We call DeepInfra (Llama-3.2-Vision) over a SEPARATE
# vsock-proxy tunnel (the host allow-lists api.deepinfra.com on this port), with
# its key KMS-unwrapped exactly like the provider key (attestation-gated to this
# PCR0). Text-only here — image attachments aren't operator-blind, so they're
# screened API-side. Empty DEEPINFRA_HOST disables the screen (fail-open).
DEEPINFRA_VSOCK_PORT = 8003
DEEPINFRA_HOST = os.environ.get("DEEPINFRA_HOST", "")
DEEPINFRA_PATH = os.environ.get("DEEPINFRA_PATH", "/v1/openai/chat/completions")
DEEPINFRA_MODEL = os.environ.get(
    "DEEPINFRA_MODEL", "meta-llama/Llama-3.2-11B-Vision-Instruct"
)
DEEPINFRA_KEY_CIPHERTEXT_B64 = os.environ.get("DEEPINFRA_KEY_CIPHERTEXT_B64", "")
# User-facing block copy — kept identical to the API's CSAM_BLOCK_MESSAGE.
CSAM_BLOCK_MESSAGE = (
    "This message was blocked because it appears to violate our content policy. "
    "Please edit it and resend."
)
# Kept verbatim in sync with apps/api/src/moderation/csam-prompt.ts (CSAM_PROMPT).
CSAM_PROMPT = (
    'You are a strict child-safety classifier for an adults-only (18+) fictional '
    "roleplay platform. Adult sexual content between adults is ALLOWED and must "
    "NOT be flagged. Your ONLY task is to detect child sexual abuse material "
    "(CSAM): content that sexualizes, or places in a sexual or suggestive "
    "context, anyone who is or appears to be a minor (under 18).\n\n"
    "Examine the user's message text and any images. Reply with ONLY compact "
    'JSON: {"csam": <true|false>, "reason": "<short reason>"}.\n\n'
    'Set "csam": true when sexual or suggestive content involves a subject who '
    "is or could be under 18 — signals include a stated age under 18, school "
    'grade or "student"/"schoolgirl" framing, words like child, kid, little, '
    "young, preteen, loli, or shota, or a childlike/underage depiction combined "
    "with any sexual or suggestive content. When a sexualized subject's age is "
    'genuinely ambiguous, set "csam": true.\n\n'
    'Set "csam": false for sexual content that clearly involves only adults, and '
    "for any non-sexual content. Output JSON only, no other text."
)
_CSAM_REFUSAL_RE = re.compile(
    r"\bcsam\b|child (?:sexual|abuse|porn)|minor|cannot (?:assist|comply|process|help)"
    r"|won'?t (?:assist|help)|not able to|unable to|against (?:my|our) (?:policy|guidelines)",
    re.IGNORECASE,
)
_CSAM_JSON_RE = re.compile(r'"csam"\s*:\s*(true|false)', re.IGNORECASE)


# ---- NSM attestation via libnsm (ctypes) -----------------------------------
# C API from aws-nitro-enclaves-nsm-api:
#   int32_t nsm_lib_init(void);
#   void    nsm_lib_exit(int32_t fd);
#   int     nsm_get_attestation_doc(fd, user_data*, user_data_len,
#               nonce*, nonce_len, public_key*, public_key_len,
#               att_doc*, uint32* att_doc_len);
_nsm = ctypes.CDLL("libnsm.so", use_errno=True)
_nsm.nsm_lib_init.restype = ctypes.c_int32
_nsm.nsm_get_attestation_doc.argtypes = [
    ctypes.c_int32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.POINTER(ctypes.c_uint32),
]


def attestation_document(nonce: bytes, public_key_der: bytes) -> bytes:
    """AWS-signed COSE attestation doc binding our RSA pubkey + the client nonce."""
    fd = _nsm.nsm_lib_init()
    if fd < 0:
        raise RuntimeError("nsm_lib_init failed")
    try:
        out = ctypes.create_string_buffer(ATT_DOC_MAX)
        out_len = ctypes.c_uint32(ATT_DOC_MAX)
        rc = _nsm.nsm_get_attestation_doc(
            fd, None, 0, nonce, len(nonce), public_key_der, len(public_key_der), out, ctypes.byref(out_len),
        )
        if rc != 0:
            raise RuntimeError(f"nsm_get_attestation_doc rc={rc}")
        return out.raw[: out_len.value]
    finally:
        _nsm.nsm_lib_exit(fd)


# ---- KMS: provider key released ONLY into this attested enclave -------------
KMS_WRAP_TAG = "kms:"


def kms_decrypt(
    creds: dict, ciphertext_b64: str, encryption_context: dict | None = None
) -> bytes:
    """Decrypt a KMS ciphertext via kmstool_enclave_cli, which presents this
    enclave's attestation doc to KMS. Returns plaintext only if the key policy's
    PCR0 condition matches this image. KMS authorizes on (principal AND attestation).
    The enclave has no IMDS, so creds are injected per-request."""
    if not ciphertext_b64:
        raise RuntimeError("no ciphertext to decrypt")
    if ciphertext_b64.startswith(KMS_WRAP_TAG):
        ciphertext_b64 = ciphertext_b64[len(KMS_WRAP_TAG) :]
    if not creds.get("access_key_id"):
        raise RuntimeError("aws_creds missing — the parent must inject them")
    args = [
        "/usr/bin/kmstool_enclave_cli", "decrypt", "--region", KMS_REGION,
        "--proxy-port", str(KMS_VSOCK_PORT),
        "--aws-access-key-id", creds["access_key_id"],
        "--aws-secret-access-key", creds["secret_access_key"],
        "--aws-session-token", creds.get("session_token", ""),
        "--ciphertext", ciphertext_b64,
    ]
    if encryption_context:
        args.extend(["--encryption-context", json.dumps(encryption_context)])
    p = subprocess.run(args, capture_output=True)
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace")
        lines = [ln for ln in err.splitlines() if ln.strip()]
        raise RuntimeError(
            "kmstool rc=%d: %s" % (p.returncode, " || ".join(lines[-3:])[:260])
        )
    out = p.stdout.decode()
    return base64.b64decode(out.split("PLAINTEXT:", 1)[1].strip())


_provider_key: str | None = None


def provider_key(creds: dict, ciphertext: str = "") -> str:
    """Lazy-fetch the provider API key via attestation-gated KMS unwrap."""
    global _provider_key
    if _provider_key is None:
        ct = ciphertext or PROVIDER_KEY_CIPHERTEXT_B64
        if not ct:
            raise RuntimeError("no provider-key ciphertext")
        _provider_key = kms_decrypt(creds, ct).decode("utf-8").strip()
    return _provider_key


_deepinfra_key: str | None = None


def deepinfra_key(creds: dict, ciphertext: str = "") -> str:
    """Lazy-fetch the DeepInfra moderation key via attestation-gated KMS unwrap.
    Mirrors provider_key — wrapped under the provider CMK, released only into
    this attested PCR0."""
    global _deepinfra_key
    if _deepinfra_key is None:
        ct = ciphertext or DEEPINFRA_KEY_CIPHERTEXT_B64
        if not ct:
            raise RuntimeError("no deepinfra-key ciphertext")
        _deepinfra_key = kms_decrypt(creds, ct).decode("utf-8").strip()
    return _deepinfra_key


# ---- PromptPack: the assembler's prompt content, unwrapped attestation-gated ----
# The bun-compiled assembler ships with NO proprietary strings (so PCR0 is
# reproducible from the public source). The content rides in as a KMS-wrapped JSON
# blob the forwarder injects into assembler ops; we unwrap it here and feed it to
# the assembler on stdin. Unwrapped once and cached for the process lifetime, like
# the provider key.
_prompt_pack: dict | None = None
_pp_source: dict = {"creds": None, "ciphertext": ""}


def set_prompt_pack_source(creds: dict, ciphertext: str) -> None:
    """Record where to KMS-unwrap the PromptPack from for THIS request (called once
    per request in main()). The unwrap itself is LAZY — only assembler ops trigger
    it — so non-assembling ops (reseal_history / content_encrypt / unwrap_dek) keep
    working even when no pack ciphertext is injected."""
    global _pp_source
    _pp_source = {"creds": creds or {}, "ciphertext": ciphertext or ""}


def active_prompt_pack() -> dict:
    """The unwrapped PromptPack fed to the assembler. The pack (~40 KB JSON) far
    exceeds KMS's 4 KB direct-encrypt limit, so it is delivered ENVELOPE-encrypted:
    a base64 JSON {"wrapped": <KMS ciphertext of a 256-bit data key>, "ct": <base64
    iv(12) || AES-256-GCM(ct||tag)>}. We KMS-unwrap the data key (attestation-gated
    to this PCR0 — the host's creds are useless anywhere else) and AES-open the pack.
    Cached after the first unwrap. Raises when nothing was injected — FAIL CLOSED:
    the binary has no built-in content, so a missing pack must error, never assemble
    a blank/identity-free prompt."""
    global _prompt_pack
    if _prompt_pack is None:
        raw = _pp_source["ciphertext"] or PROMPTPACK_CIPHERTEXT_B64
        if not raw:
            raise RuntimeError("promptpack unavailable: no ciphertext injected")
        env = json.loads(base64.b64decode(raw))
        key = kms_decrypt(_pp_source["creds"], env["wrapped"])
        blob = base64.b64decode(env["ct"])
        pack_json = AESGCM(key).decrypt(blob[:12], blob[12:], None).decode("utf-8")
        _prompt_pack = json.loads(pack_json)
    return _prompt_pack


def _deepinfra_post(api_key: str, body: bytes) -> bytes:
    """POST to DeepInfra over its OWN vsock tunnel (port 8003 → api.deepinfra.com);
    return the full raw HTTP response. Bounded by a socket timeout so the screen
    can't HANG: a stuck classifier raises (→ csam_blocks fails open) within the
    window rather than leaving the verdict pending until the gate's join-timeout."""
    raw = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    raw.settimeout(8)
    raw.connect((PARENT_CID, DEEPINFRA_VSOCK_PORT))
    ctx = ssl.create_default_context()
    tls = ctx.wrap_socket(raw, server_hostname=DEEPINFRA_HOST)
    try:
        req = (
            f"POST {DEEPINFRA_PATH} HTTP/1.1\r\nHost: {DEEPINFRA_HOST}\r\n"
            f"Authorization: Bearer {api_key.strip()}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode() + body
        tls.sendall(req)
        out = b""
        while True:
            b = tls.recv(65536)
            if not b:
                break
            out += b
        return out
    finally:
        tls.close()


def csam_blocks(creds: dict, di_ciphertext: str, text: str) -> bool:
    """True iff `text` is classified CSAM by the DeepInfra screen. FAILS OPEN
    (False) on any error/unparseable reply so a screen outage never blocks all
    blind chat; a provider refusal counts as a block. Text-only (image
    attachments are screened API-side). No-op (False) when DEEPINFRA_HOST is
    unset. Mirrors the API's ModerationService verdict semantics."""
    if not DEEPINFRA_HOST or not text or not text.strip():
        return False
    try:
        key = deepinfra_key(creds, di_ciphertext)
        body = json.dumps({
            "model": DEEPINFRA_MODEL,
            "temperature": 0,
            "max_tokens": 80,
            "messages": [
                {"role": "system", "content": CSAM_PROMPT},
                {"role": "user", "content": text[:12000]},
            ],
        }).encode()
        raw = _deepinfra_post(key, body)
        content = _http_body(raw).decode("utf-8", "replace")
        try:
            j = json.loads(content)
            content = (j.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        except Exception:
            pass
        m = _CSAM_JSON_RE.search(content)
        if m:
            return m.group(1).lower() == "true"
        return bool(_CSAM_REFUSAL_RE.search(content))
    except Exception:
        return False


# ---- provider egress: TLS over the host vsock-proxy tunnel ------------------
def stream_provider(conn: socket.socket, api_key: str, body: bytes) -> None:
    """POST to the provider, stream the response back as it arrives.
    Each TLS read is forwarded as a {"chunk": b64} frame, terminated by {"done": true}."""
    raw = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    raw.connect((PARENT_CID, PROVIDER_VSOCK_PORT))
    ctx = ssl.create_default_context()
    tls = ctx.wrap_socket(raw, server_hostname=PROVIDER_HOST)
    try:
        req = (
            f"POST {PROVIDER_PATH} HTTP/1.1\r\nHost: {PROVIDER_HOST}\r\n"
            f"Authorization: Bearer {api_key.strip()}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode() + body
        tls.sendall(req)
        while True:
            b = tls.recv(65536)
            if not b:
                break
            send_frame(conn, {"chunk": base64.b64encode(b).decode()})
        send_frame(conn, {"done": True})
    finally:
        tls.close()


# ---- prompt assembly (operator-blind): run the pinned bun-compiled binary -----
ASSEMBLER = "/usr/local/bin/inkwell-assemble"


def assemble_messages(requests: list) -> list:
    """Run the bun-compiled assembler — same @erpocalypse/core/chat TypeScript the
    API runs, producing a byte-identical prompt. The PromptPack (proprietary prompt
    content, KMS-unwrapped) rides in the stdin envelope; the binary carries none, so
    a missing pack raises here (fail closed) rather than assembling blank."""
    payload = json.dumps(
        {"requests": requests, "promptPack": active_prompt_pack()}
    ).encode()
    p = subprocess.run([ASSEMBLER], input=payload, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(
            "assembler rc=%d: %s"
            % (p.returncode, p.stderr.decode("utf-8", "replace")[:200])
        )
    out = json.loads(p.stdout.decode())
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError("assembler: %s" % str(out["error"])[:200])
    return out["results"]


def run_assembler(requests: list) -> list:
    """General form of assembler call, used for scoring ops too."""
    return assemble_messages(requests)


# ---- framing + main loop ----------------------------------------------------
def _recv_exact(c: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        b = c.recv(n - len(buf))
        if not b:
            raise ConnectionError("peer closed")
        buf += b
    return buf


def recv_frame(c: socket.socket) -> dict:
    (n,) = struct.unpack(">I", _recv_exact(c, 4))
    return json.loads(_recv_exact(c, n).decode())


def send_frame(c: socket.socket, obj: dict) -> None:
    data = json.dumps(obj).encode()
    c.sendall(struct.pack(">I", len(data)) + data)


def unseal(priv: "rsa.RSAPrivateKey", sealed: bytes) -> bytes:
    """Hybrid-decrypt a client-sealed payload: RSA-OAEP(aes_key) || iv || ciphertext.
    The client wraps a random AES-256 key with RSA-OAEP and encrypts with AES-256-GCM."""
    keybytes = priv.key_size // 8
    wrapped, iv, ct_tag = (
        sealed[:keybytes],
        sealed[keybytes : keybytes + 12],
        sealed[keybytes + 12 :],
    )
    aes_key = priv.decrypt(
        wrapped,
        padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
        ),
    )
    return AESGCM(aes_key).decrypt(iv, ct_tag, None)


# ---- reverse direction: seal enclave→client per-session key ----------------
class ClientSealer:
    """Per-request session-key sealer for the operator-blind reply path."""

    def __init__(self, conn: socket.socket, client_pubkey_der: bytes) -> None:
        self.conn = conn
        self.session_key = os.urandom(32)
        self.aes = AESGCM(self.session_key)
        pub = serialization.load_der_public_key(client_pubkey_der)
        wrapped = pub.encrypt(
            self.session_key,
            padding.OAEP(
                mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
            ),
        )
        send_frame(conn, {"k": base64.b64encode(wrapped).decode()})

    def emit(self, obj: dict) -> None:
        """AES-256-GCM-seal a JSON object under the session key, frame as {"e"}."""
        iv = os.urandom(12)
        ct = self.aes.encrypt(iv, json.dumps(obj).encode(), None)
        send_frame(self.conn, {"e": base64.b64encode(iv + ct).decode()})


# ---- content-at-rest cipher (matches @erpocalypse/core/crypto) --------------
CONTENT_TAG = "v1:"


def content_decrypt(dek: bytes, value: str, user_id: str) -> str:
    """Decrypt stored content (v1:iv:tag:ct, AES-256-GCM, AAD=userId)."""
    if not value.startswith(CONTENT_TAG):
        return value
    iv_b64, tag_b64, ct_b64 = value[len(CONTENT_TAG) :].split(":")
    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ct = base64.b64decode(ct_b64)
    pt = AESGCM(dek).decrypt(iv, ct + tag, user_id.encode())
    return pt.decode("utf-8")


def content_encrypt(dek: bytes, plaintext: str, user_id: str) -> str:
    """Encrypt content to stored form: v1:iv:tag:ct, AES-256-GCM, AAD=userId."""
    iv = os.urandom(12)
    ct_tag = AESGCM(dek).encrypt(iv, plaintext.encode("utf-8"), user_id.encode())
    ct, tag = ct_tag[:-16], ct_tag[-16:]
    return CONTENT_TAG + ":".join(
        [base64.b64encode(iv).decode(), base64.b64encode(tag).decode(), base64.b64encode(ct).decode()]
    )


# ---- reply transform --------------------------------------------------------
_EM_DASH_RE = re.compile(r"\s*—\s*")


def strip_em_dash(text: str) -> str:
    """Replace em-dash (U+2014) + surrounding whitespace with ", ". Used in SSE parsing."""
    return _EM_DASH_RE.sub(", ", text)


# ---- provider call helpers (sealed reply path) ------------------------------
def _provider_tls() -> ssl.SSLSocket:
    raw = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    raw.connect((PARENT_CID, PROVIDER_VSOCK_PORT))
    ctx = ssl.create_default_context()
    return ctx.wrap_socket(raw, server_hostname=PROVIDER_HOST)


def _provider_post(api_key: str, body: bytes) -> bytes:
    """POST to the provider, return full raw HTTP response. Used for non-streaming scoring."""
    tls = _provider_tls()
    try:
        req = (
            f"POST {PROVIDER_PATH} HTTP/1.1\r\nHost: {PROVIDER_HOST}\r\n"
            f"Authorization: Bearer {api_key.strip()}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode() + body
        tls.sendall(req)
        out = b""
        while True:
            b = tls.recv(65536)
            if not b:
                break
            out += b
        return out
    finally:
        tls.close()


def _http_body(raw: bytes) -> bytes:
    """Extract response body, de-chunk if needed."""
    idx = raw.find(b"\r\n\r\n")
    if idx < 0:
        return b""
    headers = raw[:idx].decode("latin1").lower()
    body = raw[idx + 4 :]
    if "transfer-encoding" in headers and "chunked" in headers:
        out = b""
        while True:
            nl = body.find(b"\r\n")
            if nl < 0:
                break
            try:
                size = int(body[:nl], 16)
            except ValueError:
                break
            if size == 0:
                break
            out += body[nl + 2 : nl + 2 + size]
            body = body[nl + 2 + size + 2 :]
        return out
    return body


def provider_json_response(api_key: str, body: dict) -> dict | None:
    """Non-streaming provider call, return the parsed JSON response (or None).
    Callers read choices[0].message.content and, for cost metering, `usage`."""
    raw = _provider_post(api_key, json.dumps(body).encode())
    payload = _http_body(raw)
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception:
        return None


def provider_json_content(api_key: str, body: dict) -> str | None:
    """Non-streaming provider call, return choices[0].message.content."""
    j = provider_json_response(api_key, body)
    if not isinstance(j, dict):
        return None
    return j.get("choices", [{}])[0].get("message", {}).get("content")


# ---- cost calculation -------------------------------------------------------
def turn_cost_micros(usage: dict | None) -> int:
    """Token usage → cost in micro-dollars, matching @erpocalypse/api/chat/usage-cost."""
    if not usage:
        return 0
    hit = usage.get("prompt_cache_hit_tokens") or 0
    miss = usage.get("prompt_cache_miss_tokens") or 0
    if not hit and not miss:
        details = usage.get("prompt_tokens_details") or {}
        hit = details.get("cached_tokens") or 0
        total = usage.get("prompt_tokens") or 0
        miss = max(0, total - hit)
    if hit < 0:
        hit = 0
    if miss < 0:
        miss = 0
    total_t = hit + miss
    if total_t == 0:
        total_t = usage.get("prompt_tokens") or 0
        miss = total_t - hit
    completion = usage.get("completion_tokens") or 0
    raw = miss * 0.12 + hit * 0.003 + completion * 0.21
    return max(0, round(raw))


# ---- operator-blind streaming reply -----------------------------------------
def stream_sealed_reply(
    conn, sealer: "ClientSealer", api_key: str, body: bytes,
    score_req: dict | None, dek: bytes | None, user_id: str | None,
    user_msg_pt: str | None = None, user_msg_kind: str | None = None,
    fold_job: dict | None = None,
    aws_creds: dict | None = None, di_ciphertext: str = "",
) -> None:
    """SSE reply path: parse provider stream in-enclave, seal each delta to the
    client session key as {"e": {"t": delta}}. At stream end, run scoring in-
    enclave and seal final state. At-rest ciphertext rides the clear {"meta"} frame.

    CSAM gate (BAC-135): the user message is screened in PARALLEL (a thread calls
    the DeepInfra classifier) while the provider streams; sealed deltas are
    BUFFERED until the verdict, then flushed. On a block, nothing is revealed or
    persisted — we emit a clear {"meta": {"blocked": true}} frame (the API maps it
    to the inline block error) and stop. The screen is text-only; images aren't
    operator-blind and are screened API-side."""
    # Start the screen concurrently with generation. mod["v"]: None=pending,
    # True=block, False=allow. Fails open (allow) on any error.
    import threading

    mod: dict = {"v": None}
    mod_thread = None
    if DEEPINFRA_HOST and user_msg_pt and user_msg_pt.strip():
        def _screen() -> None:
            try:
                mod["v"] = csam_blocks(aws_creds or {}, di_ciphertext, user_msg_pt)
            except Exception:
                mod["v"] = False
        mod_thread = threading.Thread(target=_screen, daemon=True)
        mod_thread.start()
    else:
        mod["v"] = False  # gate disengaged → stream immediately
    buffered: list[str] = []
    released = mod["v"] is False
    blocked = False
    tls = _provider_tls()
    full_reply = ""
    try:
        req = (
            f"POST {PROVIDER_PATH} HTTP/1.1\r\nHost: {PROVIDER_HOST}\r\n"
            f"Authorization: Bearer {api_key.strip()}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode() + body
        tls.sendall(req)
        buf = b""
        headers_done = False
        chunked = False
        sse = ""
        finish_reason = None
        reply_usage = None
        while True:
            b = tls.recv(65536)
            if not b:
                break
            buf += b
            if not headers_done:
                idx = buf.find(b"\r\n\r\n")
                if idx < 0:
                    continue
                hdr = buf[:idx].decode("latin1").lower()
                chunked = "transfer-encoding" in hdr and "chunked" in hdr
                buf = buf[idx + 4 :]
                headers_done = True
            if chunked:
                while True:
                    nl = buf.find(b"\r\n")
                    if nl < 0:
                        break
                    try:
                        size = int(buf[:nl], 16)
                    except ValueError:
                        size = -1
                    if size <= 0:
                        if size == 0:
                            buf = b""
                        break
                    if len(buf) < nl + 2 + size + 2:
                        break
                    sse += buf[nl + 2 : nl + 2 + size].decode("utf-8", "replace")
                    buf = buf[nl + 2 + size + 2 :]
            else:
                sse += buf.decode("utf-8", "replace")
                buf = b""
            lines = sse.split("\n")
            sse = lines.pop()
            for line in lines:
                t = line.strip()
                if not t.startswith("data:"):
                    continue
                data = t[5:].strip()
                if data == "[DONE]":
                    continue
                try:
                    j = json.loads(data)
                except Exception:
                    continue
                if j.get("usage"):
                    reply_usage = j["usage"]
                ch = (j.get("choices") or [{}])[0]
                fr = ch.get("finish_reason")
                if fr:
                    finish_reason = fr
                delta = (ch.get("delta") or {}).get("content")
                if delta:
                    delta = strip_em_dash(delta)
                    full_reply += delta
                    if not released:
                        v = mod["v"]
                        if v is None:
                            buffered.append(delta)  # verdict pending → hold
                            continue
                        if v is True:
                            blocked = True
                            break
                        for d in buffered:  # safe → flush held deltas, go live
                            sealer.emit({"t": d})
                        buffered = []
                        released = True
                    sealer.emit({"t": delta})
            if blocked:
                break
    finally:
        tls.close()

    # Settle the verdict if generation finished before the screen returned — never
    # release an unverified reply.
    if not blocked and not released:
        if mod_thread is not None:
            mod_thread.join(timeout=10)
        if mod["v"] is True:
            blocked = True
        else:
            for d in buffered:
                sealer.emit({"t": d})
            buffered = []
            released = True
    if blocked:
        # CSAM: reveal nothing, persist nothing (no ciphertext / user_message in
        # meta). The clear {blocked} flag is mapped to the inline block error by
        # the API; {done} terminates the stream.
        send_frame(conn, {"meta": {"blocked": True}})
        send_frame(conn, {"done": True})
        return

    state = None
    love_delta = 0
    if score_req is not None:
        try:
            built = run_assembler(
                [{**score_req, "op": "score_build", "reply": full_reply}]
            )[0]
            content = provider_json_content(
                api_key, {
                    "model": score_req["model"],
                    "messages": built["messages"],
                    "stream": False,
                    **score_req.get("reasoning", {}),
                    "response_format": {"type": "json_object"},
                    "temperature": 0.6,
                    "max_tokens": built["maxTokens"],
                },
            )
            parsed = run_assembler(
                [{**score_req, "op": "score_parse", "reply": full_reply, "content": content}]
            )[0]
            if parsed is not None:
                state = parsed
                love_delta = int(parsed.get("love") or 0)
        except Exception:
            state = None
    sealer.emit({"state": state})
    # Rolling-summary fold (BAC-98): when the bundle carried a fold plan, merge
    # the evicted turns into the summary AFTER the reply finished streaming (one
    # extra non-streaming call; the user-visible reply latency is unaffected).
    # Failure must NOT fail the turn — the meta fields are simply omitted and
    # the API treats it as no-fold.
    fold_out = None
    facts_out = None
    if fold_job is not None and dek is not None and user_id is not None:
        fold_out = run_summary_fold(api_key, dek, user_id, fold_job)
        # Fact rescue (BAC-116/118): only after a landed fold (same dropped
        # turns), building on the memory computeState just merged when this
        # turn was scored — mirroring the direct path's precedence.
        if fold_out is not None:
            base_memory = (state or {}).get("memory") or fold_job.get("prev_memory")
            facts_out = run_fact_rescue(api_key, dek, user_id, fold_job, base_memory)
    meta: dict = {
        "love": love_delta,
        "finish_reason": finish_reason,
        "cost_micros": turn_cost_micros(reply_usage)
        + (25 if score_req is not None else 0)
        + (fold_out.get("cost_micros", 0) if fold_out else 0)
        + (facts_out.get("cost_micros", 0) if facts_out else 0),
    }
    if fold_out:
        meta["summary_ciphertext"] = fold_out["summary_ciphertext"]
        meta["summary_chapters_ciphertext"] = fold_out["summary_chapters_ciphertext"]
        meta["summarized_upto"] = fold_out["summarized_upto"]
    if dek is not None and user_id is not None and user_msg_pt is not None:
        meta["user_message"] = {
            "text": content_encrypt(dek, user_msg_pt, user_id),
            "kind": user_msg_kind,
        }
    if dek is not None and user_id is not None and full_reply.strip():
        ct: dict = {"reply": content_encrypt(dek, full_reply, user_id)}
        if state is not None:
            if state.get("memory") is not None:
                ct["memory"] = content_encrypt(dek, state["memory"], user_id)
            acts = state.get("actions") or []
            ct["actions"] = [content_encrypt(dek, a, user_id) for a in acts]
            ct["reason"] = state.get("reason", "")
            ct["has_state"] = True
        # Fact rescue supersedes the plain scored merge (it already built on
        # top of it) — same precedence as the direct path's summaryPatch.memory.
        if facts_out is not None:
            ct["memory"] = facts_out["memory_ciphertext"]
        meta["ciphertext"] = ct
    send_frame(conn, {"meta": meta})
    send_frame(conn, {"done": True})


# ---- operator-blind inbound decryption --------------------------------------
GIFT_MARKER = "[GIFT]"


def _decrypt_turns(dek: bytes, turns: list, user_id: str) -> list:
    """Decrypt ciphertext history turns (content-cipher v1:, AAD=userId)."""
    out = []
    for t in turns or []:
        text = content_decrypt(dek, t.get("text", ""), user_id)
        if t.get("kind") == "gift":
            text = f"{GIFT_MARKER} {text}"
        out.append({"role": t.get("role"), "text": text})
    return out


def decrypt_bundle_content(bundle: dict, dek: bytes, user_id: str) -> None:
    """Decrypt all ciphertext ingredients in-place: history turns, memory, rolling
    summary, and the client-sealed new user message. Mutates bundle so the assembler
    sees plaintext."""
    assemble = bundle.get("assemble") or {}
    score = bundle.get("score") or {}
    dto = assemble.get("dto") or {}
    history = _decrypt_turns(dek, dto.get("messages") or [], user_id)

    new_msg = bundle.get("new_user_message")
    if new_msg:
        priv = bundle["__priv"]
        text = unseal(priv, base64.b64decode(new_msg)).decode("utf-8")
        bundle["__user_msg_pt"] = text
        kind = bundle.get("new_user_message_kind")
        if kind == "gift":
            text = f"{GIFT_MARKER} {text}"
        history.append({"role": "user", "text": text})
    dto["messages"] = history

    a_opts = assemble.get("opts")
    if isinstance(a_opts, dict) and a_opts.get("memory"):
        a_opts["memory"] = content_decrypt(dek, a_opts["memory"], user_id)
    # User-pinned facts (BAC-100): ride as ciphertext on opts.pins and are
    # decrypted here so the shared core assembly injects them byte-identically
    # to the direct path. Mirrors memory/globalPrompt.
    if isinstance(a_opts, dict) and a_opts.get("pins"):
        a_opts["pins"] = [
            content_decrypt(dek, p, user_id) for p in a_opts["pins"]
        ]
    d_opts = dto.get("options")
    if isinstance(d_opts, dict) and d_opts.get("memory"):
        d_opts["memory"] = content_decrypt(dek, d_opts["memory"], user_id)
    # User-authored global prompt (BAC-78): the API can't decrypt it under
    # operator-blind, so it rides as ciphertext on dto.globalPrompt and is
    # decrypted here, in-enclave, before the assembler injects it. Mirrors memory.
    if dto.get("globalPrompt"):
        dto["globalPrompt"] = content_decrypt(dek, dto["globalPrompt"], user_id)
    if assemble.get("rollingSummary"):
        assemble["rollingSummary"] = content_decrypt(dek, assemble["rollingSummary"], user_id)
    # Chapter log (BAC-113/118): the serialized SummaryChapter[] behind the
    # rolling summary, decrypted for the chapter_build/chapter_apply ops. The
    # prompt itself only ever sees the joined rollingSummary above.
    if bundle.get("summary_chapters_ciphertext"):
        bundle["summary_chapters_ciphertext"] = content_decrypt(
            dek, bundle["summary_chapters_ciphertext"], user_id
        )
    if score:
        score["dto"] = dto
    encrypted_sp = bundle.get("encrypted_style_profile")
    if encrypted_sp and score:
        try:
            pt = content_decrypt(dek, encrypted_sp, user_id)
            if isinstance(pt, str) and pt.strip():
                score["styleProfile"] = pt
        except Exception:
            pass


# ---- lorebook engine helpers -------------------------------------------------
LORE_CHAR_CAP = 6000


def slots_to_lore_injection(slots: list) -> dict:
    """Convert ContextSlot[] from lore_match into LoreInjection buckets.
    Mirrors @erpocalypse/core/chat assembly.ts:slotsToLoreInjection."""
    lore: dict = {"top": [], "afterProfile": [], "inline": []}
    used = 0
    for s in slots or []:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        if used + len(text) > LORE_CHAR_CAP:
            break
        used += len(text)
        pos = s.get("position", "")
        if pos == "After character profile":
            lore["afterProfile"].append(text)
        elif pos == "Inline with recent messages":
            lore["inline"].append({"depth": s.get("depth", 4), "text": text})
        else:
            lore["top"].append(text)
    return lore if (lore["top"] or lore["afterProfile"] or lore["inline"]) else {}


def run_lore_matching(bundle: dict) -> dict | None:
    """Run the lorebook engine insde the assembler if lore data is present."""
    lorebooks = bundle.get("lorebooks")
    attachments = bundle.get("lore_attachments")
    if not lorebooks or not attachments:
        return None
    assemble = bundle.get("assemble") or {}
    dto = assemble.get("dto") or {}
    try:
        result = run_assembler([{
            "op": "lore_match",
            "scene": {"id": bundle.get("conversation_id", ""), "messages": dto.get("messages", [])},
            "character": bundle.get("lore_character", {}),
            "persona": bundle.get("lore_persona", {}),
            "lorebooks": lorebooks,
            "attachments": attachments,
            "prevState": bundle.get("lore_prev_state") or {},
            "budgetTokens": bundle.get("lore_budget_tokens", 1024),
            "triggerType": bundle.get("lore_trigger_type", "normal"),
        }])[0]
        if not result or not isinstance(result, dict):
            return None
        return slots_to_lore_injection(result.get("slots") or [])
    except Exception:
        return None


# ---- rolling-summary fold (BAC-98) -------------------------------------------
def extract_fold_job(bundle: dict) -> dict | None:
    """Read the API's fold PLAN out of a decrypted bundle. Must run AFTER
    decrypt_bundle_content (it slices the PLAINTEXT history + reads the
    decrypted prior summary). The plan's start/end index the bundle's own
    history array (the watermark-sliced tail; the appended new user message
    sits at the END, beyond any head slice). Absent/malformed plan → None
    (today's no-fold behavior)."""
    fold = bundle.get("fold")
    if not isinstance(fold, dict):
        return None
    try:
        start = int(fold.get("start", 0))
        end = int(fold.get("end", 0))
        upto = int(fold["summarized_upto"])
    except Exception:
        return None
    assemble = bundle.get("assemble") or {}
    dto = assemble.get("dto") or {}
    msgs = dto.get("messages") or []
    if not (0 <= start < end <= len(msgs)) or upto <= 0:
        return None
    return {
        # Plaintext turns to fold ({"role","text"}; GIFT marker already
        # restored by _decrypt_turns, matching the direct path's history).
        "dropped": msgs[start:end],
        # Decrypted prior summary (decrypt_bundle_content already opened it).
        "prev_summary": assemble.get("rollingSummary") or None,
        # Decrypted chapter log (BAC-113/118), or None on a legacy thread —
        # chapter_build then seeds chapter 0 from prev_summary at prior_upto.
        "prev_chapters_json": bundle.get("summary_chapters_ciphertext") or None,
        "prior_upto": int(fold.get("prior_upto") or 0),
        # Decrypted recollection (the SHARED HISTORY note), the fact-rescue
        # base when this turn wasn't scored (BAC-116/118).
        "prev_memory": (dto.get("options") or {}).get("memory") or None,
        # Plan-derived fact-rescue budgets, or None below Plus (BAC-116).
        "facts": bundle.get("facts") if isinstance(bundle.get("facts"), dict) else None,
        "name": str(fold.get("name") or ""),
        "model": fold.get("model"),
        "reasoning": fold.get("reasoning") or {},
        "summarized_upto": upto,
    }


def _fold_provider_call(api_key: str, job: dict, built: dict):
    """One non-streaming platform call for a fold-pipeline request (chapter,
    roll-up, fact rescue): returns (content, cost_micros) or (None, 0)."""
    j = provider_json_response(api_key, {
        "model": job["model"],
        "messages": built["messages"],
        "stream": False,
        **job.get("reasoning", {}),
        "temperature": built["temperature"],
        "max_tokens": built["maxTokens"],
    })
    if not isinstance(j, dict):
        return None, 0
    content = j.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        return None, turn_cost_micros(j.get("usage"))
    return content, turn_cost_micros(j.get("usage"))


def run_summary_fold(api_key: str, dek: bytes, user_id: str, job: dict) -> dict | None:
    """Chapter fold (BAC-113/118), replacing the legacy cumulative merge: the
    assembler's chapter_build/chapter_apply ops (the API foldChapter's own
    functions) bracket one platform call for the new chapter, plus at most one
    more when the log outgrew its budget and the oldest chapters roll up. Both
    the joined summary and the serialized chapter log come back DEK-encrypted.
    Returns {"summary_ciphertext","summary_chapters_ciphertext",
    "summarized_upto","cost_micros"} or None on ANY failure — a failed fold
    must never fail the turn (the API keeps the old summary + watermark and
    replans next turn)."""
    try:
        base = {
            "prevSummary": job.get("prev_summary"),
            "prevChaptersJson": job.get("prev_chapters_json"),
            "priorUpto": job.get("prior_upto", 0),
            "dropped": job["dropped"],
            "name": job["name"],
        }
        built = run_assembler([{**base, "op": "chapter_build"}])[0]
        if not isinstance(built, dict):
            return None
        content, cost = _fold_provider_call(api_key, job, built)
        if content is None:
            return None
        apply_req = {
            **base,
            "op": "chapter_apply",
            "upto": job["summarized_upto"],
            "raw": content,
        }
        applied = run_assembler([apply_req])[0]
        if not isinstance(applied, dict):
            return None
        rollup = applied.get("rollup")
        if isinstance(rollup, dict):
            # Roll-up failure keeps the (over-budget) unrolled log — the next
            # fold retries; never silently lose chapters.
            merged, c2 = _fold_provider_call(api_key, job, rollup)
            cost += c2
            if merged is not None:
                applied2 = run_assembler([{**apply_req, "merged": merged}])[0]
                if isinstance(applied2, dict):
                    applied = applied2
        return {
            "summary_ciphertext": content_encrypt(dek, applied["summary"], user_id),
            "summary_chapters_ciphertext": content_encrypt(
                dek, applied["summaryChapters"], user_id
            ),
            "summarized_upto": job["summarized_upto"],
            "cost_micros": cost,
        }
    except Exception:
        return None


def run_fact_rescue(
    api_key: str, dek: bytes, user_id: str, job: dict, current_memory
) -> dict | None:
    """Fact rescue (BAC-116/118, Plus+ — the API only sends `facts` budgets for
    paid plans): durable facts in the folded-out turns graduate into the
    first-person recollection via the shared facts_build/facts_apply ops. Runs
    only after a successful fold (same dropped turns). Returns
    {"memory_ciphertext","cost_micros"} or None — best-effort like the fold."""
    facts = job.get("facts")
    if not isinstance(facts, dict):
        return None
    try:
        max_chars = int(facts["max_chars"])
        built = run_assembler([{
            "op": "facts_build",
            "currentMemory": current_memory,
            "dropped": job["dropped"],
            "name": job["name"],
            "maxChars": max_chars,
        }])[0]
        if not isinstance(built, dict):
            return None
        content, cost = _fold_provider_call(api_key, job, built)
        if content is None:
            return None
        applied = run_assembler([
            {"op": "facts_apply", "out": content, "maxChars": max_chars}
        ])[0]
        if not isinstance(applied, str) or not applied.strip():
            return None
        return {
            "memory_ciphertext": content_encrypt(dek, applied, user_id),
            "cost_micros": cost,
        }
    except Exception:
        return None


# ---- command dispatch -------------------------------------------------------
def handle_chat_body(conn, priv, req: dict, opened: bytes, api_key: str, assemble: bool) -> None:
    """Dispatch a chat/assemble_chat to either legacy relay or sealed-reply path."""
    if assemble:
        bundle = json.loads(opened)
        client_pubkey = bundle.get("client_pubkey")
        score = bundle.get("score")
        wrapped_dek = bundle.get("wrapped_dek")
        user_id = bundle.get("user_id")
        body = bundle["body"]
        sealed_dek = None
        if wrapped_dek:
            sealed_dek = kms_decrypt(
                req.get("aws_creds") or {},
                wrapped_dek,
                {"userId": user_id} if user_id else None,
            )
            bundle["__priv"] = priv
            decrypt_bundle_content(bundle, sealed_dek, user_id)
            score = bundle.get("score")
            # Fold plan (BAC-98): captured AFTER decryption (it slices the
            # plaintext history + reads the decrypted prior summary).
            bundle["__fold_job"] = extract_fold_job(bundle)
            lore = run_lore_matching(bundle)
            if lore:
                a_req = bundle.get("assemble") or {}
                a_req["lore"] = lore
                if score is not None:
                    score["lore"] = lore
        body["messages"] = assemble_messages([bundle["assemble"]])[0]
        bundle["__dek"] = sealed_dek
    else:
        parsed = json.loads(opened)
        if isinstance(parsed, dict) and "client_pubkey" in parsed:
            body = parsed["body"]
            client_pubkey = parsed.get("client_pubkey")
            score = parsed.get("score")
            wrapped_dek = parsed.get("wrapped_dek")
            user_id = parsed.get("user_id")
        else:
            stream_provider(conn, api_key, opened)
            return

    if not client_pubkey:
        stream_provider(conn, api_key, json.dumps(body).encode())
        return

    dek = bundle.get("__dek") if assemble else None
    if dek is None and wrapped_dek:
        dek = kms_decrypt(
            req.get("aws_creds") or {},
            wrapped_dek,
            {"userId": user_id} if user_id else None,
        )

    user_msg_pt = None
    user_msg_kind = None
    if assemble:
        user_msg_pt = bundle.get("__user_msg_pt")
        if user_msg_pt is not None:
            user_msg_kind = bundle.get("new_user_message_kind")

    sealer = ClientSealer(conn, base64.b64decode(client_pubkey))
    stream_sealed_reply(
        conn, sealer, api_key, json.dumps(body).encode(), score, dek, user_id,
        user_msg_pt, user_msg_kind,
        bundle.get("__fold_job") if assemble else None,
        aws_creds=req.get("aws_creds") or {},
        di_ciphertext=req.get("deepinfra_key_ciphertext", ""),
    )


def assemble_and_reseal(conn, priv, req: dict) -> None:
    """BYOK assembly: build the prompt in-enclave, reseal it to the client session key
    without a provider call for the REPLY (egress is locked to DeepSeek + KMS).
    A rolling-summary fold (BAC-98), when planned, still runs here on the
    PLATFORM key: the direct path also summarizes BYOK threads on the platform
    model, and DeepSeek is exactly the enclave's allowed egress."""
    bundle = json.loads(unseal(priv, base64.b64decode(req["sealed"])))
    client_pubkey = bundle["client_pubkey"]
    wrapped_dek = bundle["wrapped_dek"]
    user_id = bundle.get("user_id")
    dek = kms_decrypt(req.get("aws_creds") or {}, wrapped_dek, {"userId": user_id} if user_id else None)
    bundle["__priv"] = priv
    decrypt_bundle_content(bundle, dek, user_id)
    fold_job = extract_fold_job(bundle)
    messages = assemble_messages([bundle["assemble"]])[0]

    sealer = ClientSealer(conn, base64.b64decode(client_pubkey))
    sealer.emit({"messages": messages})
    meta: dict = {}
    user_msg_pt = bundle.get("__user_msg_pt")
    if dek is not None and user_id is not None and user_msg_pt is not None:
        meta["user_message"] = {
            "text": content_encrypt(dek, user_msg_pt, user_id),
            "kind": bundle.get("new_user_message_kind"),
        }
    # In-enclave fold (BAC-98). The platform key is fetched lazily — reseal
    # turns don't otherwise need it; if it's unavailable the fold is skipped
    # (best-effort, like every other fold failure).
    if fold_job is not None and dek is not None and user_id is not None:
        try:
            key = provider_key(
                req.get("aws_creds") or {}, req.get("provider_key_ciphertext", "")
            )
            fold_out = run_summary_fold(key, dek, user_id, fold_job)
            # Fact rescue on BYOK reseal turns (BAC-116/118): no scored state at
            # assemble time, so the pre-turn recollection is the base; the later
            # /byok-turn scoring reloads the rescued note and merges on top.
            facts_out = (
                run_fact_rescue(key, dek, user_id, fold_job, fold_job.get("prev_memory"))
                if fold_out is not None
                else None
            )
        except Exception:
            fold_out = None
            facts_out = None
        if fold_out:
            meta["summary_ciphertext"] = fold_out["summary_ciphertext"]
            meta["summary_chapters_ciphertext"] = fold_out["summary_chapters_ciphertext"]
            meta["summarized_upto"] = fold_out["summarized_upto"]
        if facts_out:
            meta["memory_ciphertext"] = facts_out["memory_ciphertext"]
            meta["cost_micros"] = fold_out["cost_micros"]
    send_frame(conn, {"meta": meta})
    send_frame(conn, {"done": True})


def main() -> None:
    priv = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pub_der = priv.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    srv = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    srv.bind((socket.VMADDR_CID_ANY, LISTEN_PORT))
    srv.listen(128)

    while True:
        conn, _ = srv.accept()
        try:
            req = recv_frame(conn)
            op = req.get("op")
            # Where to KMS-unwrap the PromptPack for this request (lazy — only the
            # assembler ops actually unwrap it; injected by the forwarder for those).
            set_prompt_pack_source(
                req.get("aws_creds") or {}, req.get("promptpack_ciphertext", "")
            )
            if op == "ping":
                send_frame(conn, {"ok": True})
            elif op == "attest":
                nonce = base64.b64decode(req["nonce"])
                doc = attestation_document(nonce, pub_der)
                send_frame(conn, {"doc": base64.b64encode(doc).decode()})
            elif op == "chat":
                opened = unseal(priv, base64.b64decode(req["sealed"]))
                key = provider_key(req.get("aws_creds") or {}, req.get("provider_key_ciphertext", ""))
                handle_chat_body(conn, priv, req, opened, key, assemble=False)
            elif op == "assemble_chat":
                opened = unseal(priv, base64.b64decode(req["sealed"]))
                key = provider_key(req.get("aws_creds") or {}, req.get("provider_key_ciphertext", ""))
                handle_chat_body(conn, priv, req, opened, key, assemble=True)
            elif op == "reseal_history":
                bundle = json.loads(unseal(priv, base64.b64decode(req["sealed"])))
                user_id = bundle["user_id"]
                dek = kms_decrypt(req.get("aws_creds") or {}, bundle["wrapped_dek"], {"userId": user_id})
                sealer = ClientSealer(conn, base64.b64decode(bundle["client_pubkey"]))
                for m in bundle.get("messages", []):
                    out = {
                        "role": m.get("role"), "kind": m.get("kind"), "id": m.get("id"),
                        "createdAt": m.get("createdAt"),
                        "text": content_decrypt(dek, m["text"], user_id),
                    }
                    # Swipe variants (BAC-87): the API ships each variant's text as
                    # ciphertext too; decrypt them so the client rebuilds the swipe
                    # stack on reload. Present only when a message holds >1 variant.
                    variants = m.get("variants")
                    if variants:
                        out["variants"] = [
                            content_decrypt(dek, v, user_id) for v in variants
                        ]
                        out["activeVariant"] = m.get("activeVariant")
                    sealer.emit(out)
                send_frame(conn, {"done": True})
            elif op == "content_encrypt":
                bundle = json.loads(unseal(priv, base64.b64decode(req["sealed"])))
                user_id = bundle["user_id"]
                dek = kms_decrypt(req.get("aws_creds") or {}, bundle["wrapped_dek"], {"userId": user_id})
                cts = [content_encrypt(dek, v, user_id) for v in bundle["values"]]
                send_frame(conn, {"values": cts})
            elif op == "content_encrypt_sealed":
                outer = json.loads(unseal(priv, base64.b64decode(req["sealed"])))
                user_id = outer["user_id"]
                dek = kms_decrypt(req.get("aws_creds") or {}, outer["wrapped_dek"], {"userId": user_id})
                cts = []
                for sv in outer["sealed_values"]:
                    pt = unseal(priv, base64.b64decode(sv)).decode("utf-8")
                    cts.append(content_encrypt(dek, pt, user_id))
                send_frame(conn, {"values": cts})
            elif op == "score_sealed":
                outer = json.loads(unseal(priv, base64.b64decode(req["sealed"])))
                user_id = outer["user_id"]
                dek = kms_decrypt(req.get("aws_creds") or {}, outer["wrapped_dek"], {"userId": user_id})
                score = outer.get("score") or {}
                sdto = score.get("dto") or {}
                if sdto.get("messages"):
                    sdto["messages"] = _decrypt_turns(dek, sdto["messages"], user_id)
                    opts = sdto.get("options")
                    if isinstance(opts, dict):
                        mem = opts.get("memory")
                        if mem:
                            opts["memory"] = content_decrypt(dek, mem, user_id)
                key = provider_key(req.get("aws_creds") or {}, req.get("provider_key_ciphertext", ""))
                sealed_reply_b64 = outer.get("sealed_reply", "")
                reply = unseal(priv, base64.b64decode(sealed_reply_b64)).decode("utf-8")
                try:
                    built = run_assembler([{**score, "op": "score_build", "reply": reply}])[0]
                    content = provider_json_content(key, {
                        "model": score.get("model"),
                        "messages": built["messages"],
                        "stream": False,
                        **score.get("reasoning", {}),
                        "response_format": {"type": "json_object"},
                        "temperature": 0.6,
                        "max_tokens": built["maxTokens"],
                    })
                    parsed = run_assembler([{**score, "op": "score_parse", "reply": reply, "content": content}])[0]
                except Exception:
                    parsed = None
                love_delta = 0
                state_out = {}
                if parsed is not None:
                    love_delta = int(parsed.get("love") or 0)
                    state_out["love"] = love_delta
                    state_out["reason"] = parsed.get("reason", "")
                    mem = parsed.get("memory")
                    if mem:
                        state_out["memory"] = content_encrypt(dek, mem, user_id)
                    acts = parsed.get("actions") or []
                    if len(acts):
                        state_out["actions"] = [content_encrypt(dek, a, user_id) for a in acts]
                send_frame(conn, {"state": state_out})
            elif op == "assemble_reseal":
                assemble_and_reseal(conn, priv, req)
            elif op == "unwrap_dek":
                dek = kms_decrypt(req.get("aws_creds") or {}, req.get("wrapped", ""))
                send_frame(conn, {"dek_sha256": hashlib.sha256(dek).hexdigest()})
            else:
                send_frame(conn, {"error": "bad_op"})
        except Exception as exc:
            try:
                send_frame(conn, {"error": type(exc).__name__, "detail": str(exc)[:220]})
            except Exception:
                pass
        finally:
            conn.close()


if __name__ == "__main__":
    main()
