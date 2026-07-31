"""Measured first-party provider routing for the confidential enclave.

This module is deliberately dependency-free so its provider selection, auth,
and request-body enforcement can be unit-tested outside Nitro hardware.
"""
from __future__ import annotations

import os

PROVIDER_VSOCK_PORT = 8002

PROVIDER_HOST = os.environ.get("PROVIDER_HOST")
if PROVIDER_HOST is None:
    raise RuntimeError("PROVIDER_HOST is required")
PROVIDER_PATH = os.environ.get("PROVIDER_PATH", "/chat/completions")
MIMO_MODEL = os.environ.get("MIMO_MODEL", "mimo-v2.5-pro")

CROF_FLASH_PRICES = {"in_miss": 0.12, "in_cached": 0.003, "out": 0.21}
CROF_MIMO_PRO_PRICES = {"in_miss": 0.40, "in_cached": 0.003, "out": 0.80}


def reply_provider_target(platform_model: str | None) -> dict:
    """Map a sealed first-party model id to an attested egress target.

    Unknown and legacy values fail safely to Squid.
    """
    if platform_model == "octopus":
        return {
            "id": "octopus",
            "host": PROVIDER_HOST,
            "path": PROVIDER_PATH,
            "port": PROVIDER_VSOCK_PORT,
            "auth": "bearer",
            "provider": "crof",
            "model": MIMO_MODEL,
            "prices": CROF_MIMO_PRO_PRICES,
            "supports_vision": False,
        }
    return {
        "id": "squid",
        "host": PROVIDER_HOST,
        "path": PROVIDER_PATH,
        "port": PROVIDER_VSOCK_PORT,
        "auth": "bearer",
        "provider": "crof",
        "model": "deepseek-v4-flash",
        "prices": CROF_FLASH_PRICES,
        "supports_vision": False,
    }


def reply_prompt_variant(target: dict) -> str:
    """Choose the prompt preamble beside the measured reply-provider route."""
    return "mimo" if target.get("id") == "octopus" else "default"


def prepare_reply_body(body: dict, target: dict) -> dict:
    """Enforce provider-specific model and reasoning knobs in-enclave."""
    out = dict(body)
    out["model"] = target["model"]
    out["reasoning_effort"] = "none"
    out.pop("thinking", None)
    out.pop("enable_thinking", None)
    out.pop("chat_template_kwargs", None)
    return out


def attach_image_parts(messages: list, images: list | None, target: dict) -> list:
    """Fold this turn's clear image attachments into the LAST user turn as
    OpenAI vision content parts (SYS-43).

    `images` is the bundle's `attachment_images` ([{"b64", "mime"}]) — set by
    the API only on turns that carry an upload. Images are deliberately NOT
    operator-blind: the API ownership-checks and CSAM-screens them before the
    bundle is built, so they arrive here in the clear. Only the vision
    provider accepts content-parts arrays, so a text-only target returns the
    messages untouched; likewise a turn with no images returns
    byte-identical messages, keeping text-only prompts (and the DeepSeek
    prefix cache) unaffected. Malformed entries are skipped, never fatal.
    """
    if not images or not target.get("supports_vision"):
        return messages
    for msg in reversed(messages):
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        parts = []
        text = msg.get("content")
        if isinstance(text, str) and text:
            parts.append({"type": "text", "text": text})
        for img in images:
            b64 = img.get("b64") if isinstance(img, dict) else None
            if not isinstance(b64, str) or not b64:
                continue
            mime = img.get("mime") or "image/jpeg"
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": "data:%s;base64,%s" % (mime, b64)},
                }
            )
        # Only rewrite the turn when a real image part made it in — a list of
        # malformed entries must not degrade the turn to a parts array.
        if any(p.get("type") == "image_url" for p in parts):
            msg["content"] = parts
        return messages
    return messages


def normalize_usage(usage: dict | None) -> dict:
    """Normalize DeepSeek/OpenAI-style usage into stable token buckets."""
    usage = usage or {}
    hit = usage.get("prompt_cache_hit_tokens") or 0
    miss = usage.get("prompt_cache_miss_tokens") or 0
    if not hit and not miss:
        details = usage.get("prompt_tokens_details") or {}
        hit = details.get("cached_tokens") or 0
        total = usage.get("prompt_tokens") or 0
        miss = max(0, total - hit)
    hit = max(0, hit)
    miss = max(0, miss)
    total = max(0, usage.get("prompt_tokens") or 0)
    if total > 0:
        hit = min(hit, total)
        # Anything the provider did not explicitly classify as a cache hit is
        # conservatively billed as a miss. This also reconciles inconsistent
        # hit/miss subcounts to the authoritative prompt_tokens total.
        miss = total - hit
    prompt_total = total or hit + miss
    completion = max(0, usage.get("completion_tokens") or 0)
    return {
        "prompt_tokens": prompt_total,
        "cached_tokens": hit,
        "completion_tokens": completion,
        "miss_tokens": miss,
    }


def usage_cost_micros(usage: dict | None, prices: dict) -> int:
    """Convert provider token usage to integer micro-dollars."""
    normalized = normalize_usage(usage)
    raw = (
        normalized["miss_tokens"] * prices["in_miss"]
        + normalized["cached_tokens"] * prices["in_cached"]
        + normalized["completion_tokens"] * prices["out"]
    )
    return max(0, round(raw))


def provider_usage_event(kind: str, usage: dict | None, target: dict) -> dict:
    """Build the non-content usage record returned to the API ledger."""
    normalized = normalize_usage(usage)
    return {
        "kind": kind,
        "provider": target["provider"],
        "model": target["model"],
        "prompt_tokens": normalized["prompt_tokens"],
        "cached_tokens": normalized["cached_tokens"],
        "completion_tokens": normalized["completion_tokens"],
        "cost_micros": usage_cost_micros(usage, target["prices"]),
    }


def provider_http_status(headers: bytes) -> int:
    """Parse the status from an HTTP response header block."""
    first = headers.split(b"\r\n", 1)[0].decode("ascii", "replace")
    parts = first.split()
    if len(parts) < 2 or not parts[1].isdigit():
        raise RuntimeError("provider returned a malformed HTTP status")
    return int(parts[1])


def provider_request(target: dict, api_key: str, body: bytes) -> bytes:
    """Build the raw HTTPS request sent through the selected vsock tunnel."""
    auth = (
        f"api-key: {api_key.strip()}"
        if target["auth"] == "api-key"
        else f"Authorization: Bearer {api_key.strip()}"
    )
    return (
        f"POST {target['path']} HTTP/1.1\r\nHost: {target['host']}\r\n"
        f"{auth}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode() + body
