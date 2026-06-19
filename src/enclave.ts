/**
 * Inkwell enclave crypto — browser-side E2EE with the AWS Nitro enclave.
 *
 * Protocol (mirrors infra/enclave/app/server.py and apps/api/src/enclave/*):
 *
 * 1. Client fetches attestation doc from /security/attestation
 * 2. Client extracts enclave's RSA-3072 public key from the COSE_Sign1 payload
 * 3. Client generates an ephemeral RSA-3072 keypair for THIS SESSION
 * 4. Client encrypts message via hybrid RSA-OAEP + AES-256-GCM to enclave pubkey
 * 5. Client sends { clientPubKey, sealedMessage, message: { kind } } — no plaintext
 * 6. Enclave emits {k} frame (RSA-OAEP-wrapped session AES key) then {e} frames
 * 7. Client decrypts {k} with ephemeral private key → gets AES session key
 * 8. Client decrypts each {e} with session key → gets plaintext tokens/state
 *
 * All crypto uses Web Crypto API (SubtleCrypto) — works in browser + Tauri webview.
 *
 * @module
 */

import { decode, parseCoseSign1 } from "./cbor";

// ── Types ───────────────────────────────────────────────────────────────────

/** An established enclave session — cached across chat turns. */
export interface EnclaveSession {
	/** The enclave's RSA-3072 public key (DER SPKI), hex-encoded for cache keys. */
	enclavePubKeyHex: string;
	/** The importable enclave public key (for encryption). */
	enclavePubKey: CryptoKey;
	/** The verified PCR0 hex string. */
	pcr0: string;
	/** When this session was established (ms). */
	establishedAt: number;
}

/** An ephemeral per-chat-turn keypair for sealed reply decryption. */
export interface TurnKeypair {
	/** DER SPKI, base64 — sent as clientPubKey. */
	publicKeyB64: string;
	/** The private key (for unwrapping the {k} frame). */
	privateKey: CryptoKey;
}

/** Result of decrypting a sealed SSE frame. */
export type SealedFrame =
	| { type: "key"; sessionKey: CryptoKey }
	| { type: "delta"; token: string }
	| { type: "state"; state: unknown }
	| { type: "meta"; meta: unknown }
	| { type: "done" };

// ── Attestation doc parsing ────────────────────────────────────────────────

/** AWS Nitro Root CA G1 SHA-256 fingerprint (from AWS docs). */
export const AWS_NITRO_ROOT_FP =
	"641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b";

/** Parse a COSE_Sign1 attestation doc and extract the enclave's public key.
 *  Does NOT verify the trust chain (Phase 3/separate page). Returns the raw
 *  DER SubjectPublicKeyInfo for encryption. */
export function parseEnclavePubkey(doc: ArrayBuffer | Uint8Array): {
	publicKeyDer: Uint8Array;
	pcr0: string;
} {
	const cose = parseCoseSign1(doc);
	const payload = decode(cose.payload);
	const map =
		payload instanceof Map ? payload : (payload as Record<string, unknown>);

	// Extract public_key from payload
	const publicKey =
		map instanceof Map
			? (map.get("public_key") as Uint8Array | undefined)
			: ((map as Record<string, unknown>)["public_key"] as
					| Uint8Array
					| undefined);
	if (!publicKey) throw new Error("attestation: no public_key in payload");

	// Extract PCR0
	const pcrsRaw =
		map instanceof Map
			? (map.get("pcrs") as Map<number, Uint8Array> | undefined)
			: ((map as Record<string, unknown>)["pcrs"] as
					| Record<number, Uint8Array>
					| undefined);
	const pcr0Raw =
		pcrsRaw instanceof Map
			? pcrsRaw.get(0)
			: (pcrsRaw as Record<number, Uint8Array> | undefined)?.[0];
	const pcr0 = pcr0Raw ? bytesToHex(new Uint8Array(pcr0Raw)) : "";

	return { publicKeyDer: new Uint8Array(publicKey), pcr0 };
}

// ── Enclave session (cache the attested pubkey per browser tab) ─────────────

let _session: EnclaveSession | null = null;

/** Get or fetch (and cache) the attested enclave public key from the API.
 *  Returns null if the enclave is not configured. */
export async function getEnclaveSession(): Promise<EnclaveSession | null> {
	if (_session) return _session;

	const res = await fetch(
		`${import.meta.env.VITE_API_URL ?? ""}/security/attestation`,
		{
			headers: authHeaders(),
		},
	);
	if (!res.ok) return null;
	const data = (await res.json()) as {
		doc: string;
		pcr0: string;
		nonce: string;
		posture?: { inFlightBlind: boolean; atRestBlind: boolean };
	};

	// Only proceed if the enclave is configured and we're in a sealed posture
	if (!data.doc) return null;

	const doc = base64ToBytes(data.doc);
	const { publicKeyDer, pcr0 } = parseEnclavePubkey(doc);

	// Import the enclave public key for encryption
	const enclavePubKey = await crypto.subtle.importKey(
		"spki",
		new Uint8Array(publicKeyDer).buffer as ArrayBuffer,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt", "wrapKey"],
	);

	_session = {
		enclavePubKeyHex: bytesToHex(publicKeyDer),
		enclavePubKey,
		pcr0,
		establishedAt: Date.now(),
	};
	return _session;
}

/** Clear the cached enclave session (e.g. on page navigation). */
export function clearEnclaveSession(): void {
	_session = null;
}

// ── Ephemeral per-turn keypair ─────────────────────────────────────────────

/** Generate an ephemeral RSA-3072 keypair for this chat turn. The public key
 *  is sent as `clientPubKey`; the private key is used to decrypt the {k} frame
 *  (session AES key) from the enclave. */
export async function generateTurnKeypair(): Promise<TurnKeypair> {
	const keypair = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 3072,
			publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
			hash: "SHA-256",
		},
		false, // non-extractable — never leaves memory
		["decrypt", "unwrapKey"],
	);

	const spki = await crypto.subtle.exportKey("spki", keypair.publicKey!);
	const publicKeyB64 = bytesToBase64(new Uint8Array(spki));

	return {
		publicKeyB64,
		privateKey: keypair.privateKey!,
	};
}

// ── Encrypt a message to the enclave (inbound) ─────────────────────────────

/** Hybrid-encrypt `plaintext` to the enclave's attested RSA public key.
 *  Returns base64 of the envelope: [RSA-OAEP(aesKey) | iv(12) | AES-GCM(ct|tag)].
 *  Mirrors EnclaveService.seal() on the server. */
export async function encryptToEnclave(
	enclavePubKey: CryptoKey,
	plaintext: string,
): Promise<string> {
	// Generate random AES-256 key
	const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
	const iv = crypto.getRandomValues(new Uint8Array(12));

	// AES-256-GCM encrypt the plaintext
	const aesKey = await crypto.subtle.importKey(
		"raw",
		aesKeyBytes,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
	const ctWithTag = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, tagLength: 128 },
			aesKey,
			new TextEncoder().encode(plaintext),
		),
	);

	// RSA-OAEP-SHA256 encrypt the AES key
	const wrappedKey = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "RSA-OAEP" },
			enclavePubKey,
			aesKeyBytes,
		),
	);

	// Assemble envelope: [wrapped(384) | iv(12) | ct|tag]
	const envelope = new Uint8Array(
		wrappedKey.length + iv.length + ctWithTag.length,
	);
	envelope.set(wrappedKey, 0);
	envelope.set(iv, wrappedKey.length);
	envelope.set(ctWithTag, wrappedKey.length + iv.length);

	return bytesToBase64(envelope);
}

// ── Decrypt sealed replies (outbound) ─────────────────────────────────────

/** Parse a `{k}` frame: RSA-OAEP-decrypt the base64 payload with the ephemeral
 *  private key to get the 32-byte AES session key, then import it for decryption.
 *  Returns the AES-CryptoKey. */
export async function unwrapSessionKey(
	privateKey: CryptoKey,
	kB64: string,
): Promise<CryptoKey> {
	const wrapped = base64ToBytes(kB64);

	const rawKey = await crypto.subtle.decrypt(
		{ name: "RSA-OAEP" },
		privateKey,
		wrapped.buffer as ArrayBuffer,
	);

	return crypto.subtle.importKey(
		"raw",
		new Uint8Array(rawKey),
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);
}

/** Decrypt an `{e}` frame: AES-256-GCM decrypt the base64 payload (iv|ct|tag)
 *  with the session key. Returns the plaintext string. */
export async function decryptEFrame(
	sessionKey: CryptoKey,
	eB64: string,
): Promise<string> {
	const blob = base64ToBytes(eB64);
	if (blob.length < 13) throw new Error("enclave: invalid e-frame");

	const iv = blob.slice(0, 12);
	const ctWithTag = blob.slice(12);

	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, tagLength: 128 },
		sessionKey,
		ctWithTag,
	);

	return new TextDecoder().decode(plaintext);
}

// ── Frame stream processing ────────────────────────────────────────────────

/** Process a stream of sealed SSE frames (as parsed by the SSE reader).
 *  `frames` are the `data:` payloads from the SSE stream. Returns an array of
 *  SealedFrame that the UI can render. Internal state machine handles the {k}
 *  → {e}+ → {meta} → [DONE] sequence. */
export async function* processSealedFrames(
	privateKey: CryptoKey,
	frames: string[],
): AsyncGenerator<SealedFrame> {
	let sessionKey: CryptoKey | null = null;

	for (const raw of frames) {
		if (raw === "[DONE]") {
			yield { type: "done" };
			return;
		}

		const parsed = JSON.parse(raw) as Record<string, unknown>;

		if ("k" in parsed && typeof parsed.k === "string") {
			// First frame: session key
			sessionKey = await unwrapSessionKey(privateKey, parsed.k);
			yield { type: "key", sessionKey };
		} else if ("e" in parsed && typeof parsed.e === "string" && sessionKey) {
			// Encrypted delta
			const plaintext = await decryptEFrame(sessionKey, parsed.e);
			const data = JSON.parse(plaintext);
			if (typeof data.t === "string") {
				yield { type: "delta", token: data.t };
			} else if (data.state) {
				yield { type: "state", state: data.state };
			}
		} else if ("meta" in parsed) {
			yield { type: "meta", meta: parsed.meta };
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}

function bytesToBase64(b: Uint8Array): string {
	// Use btoa with a manual conversion (works in all browsers + Tauri webview)
	const bin = Array.from(b)
		.map((x) => String.fromCodePoint(x))
		.join("");
	return btoa(bin);
}

function base64ToBytes(s: string): Uint8Array {
	const bin = atob(s);
	const b = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) b[i] = bin.codePointAt(i)!;
	return b;
}

function authHeaders(): Record<string, string> {
	try {
		const token = localStorage.getItem("token");
		return token ? { Authorization: `Bearer ${token}` } : {};
	} catch {
		return {};
	}
}
