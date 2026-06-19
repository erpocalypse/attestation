/**
 * In-browser AWS Nitro attestation document verification.
 *
 * Parses and verifies a COSE_Sign1 attestation document against the published
 * AWS Nitro Root CA G1, entirely in the browser using SubtleCrypto — no trust
 * in our servers. The result drives the "Verify it yourself" security badge.
 *
 * @module
 */

import { parseCoseSign1, decode } from "./cbor";

// ── Constants ──────────────────────────────────────────────────────────────

/** AWS Nitro Root CA G1 SHA-256 fingerprint (published by AWS). */
const AWS_NITRO_ROOT_FP =
	"641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b";

/** Maximum clock skew for timestamp validation (5 minutes). */
const MAX_SKEW_MS = 5 * 60_000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface AttestationResult {
	/** Whether the attestation passed all checks. */
	verified: boolean;
	/** Verdict details for display. */
	checks: {
		nonce: { ok: boolean; detail: string };
		timestamp: { ok: boolean; detail: string };
		pcr0: { ok: boolean; detail: string };
		certChain: { ok: boolean; detail: string };
		signature: { ok: boolean; detail: string };
	};
	/** Extracted data (present even on failure for debugging). */
	data: {
		pcr0: string;
		moduleId: string;
		/** DER SubjectPublicKeyInfo — the enclave's public key. */
		publicKeyDer: Uint8Array | null;
		/** ISO timestamp string. */
		timestamp: string;
		/** Number of certificates in the chain (leaf + intermediates + root). */
		certCount: number;
	};
}

export interface VerifyOpts {
	/** Expected PCR0 hex string. */
	expectedPcr0: string;
	/** The nonce the client sent. */
	nonce: Uint8Array;
	/** Optional: override now (ms since epoch). */
	now?: number;
	/** Optional: override root fingerprint. */
	rootFingerprint?: string;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Verify a full AWS Nitro attestation document in the browser.
 *
 * Steps (per AWS spec /docs/enclaves/verify-root):
 *   1. Decode COSE_Sign1 → extract [protected, unprotected, payload, sig]
 *   2. Parse payload: cert, cabundle, pcrs, nonce, timestamp, public_key
 *   3. Verify nonce matches (freshness)
 *   4. Verify timestamp within skew
 *   5. Verify PCR0 matches the published measurement
 *   6. Verify X.509 cert chain leaf → root, pinned to AWS Nitro Root CA
 *   7. Verify COSE ES384 signature over payload with leaf cert's key
 */
export async function verifyAttestation(
	doc: ArrayBuffer | Uint8Array,
	opts: VerifyOpts,
): Promise<AttestationResult> {
	const now = opts.now ?? Date.now();

	try {
		const cose = parseCoseSign1(doc);

		// Parse payload
		const payloadRaw = decode(cose.payload);
		const payload =
			payloadRaw instanceof Map
				? payloadRaw
				: new Map(Object.entries(payloadRaw as Record<string, unknown>));
		const get = (k: string): unknown =>
			payload instanceof Map ? payload.get(k) : undefined;

		// Extract fields
		const nonce = get("nonce") as Uint8Array | undefined;
		const timestamp = get("timestamp") as number | undefined;
		const pcrsMap = get("pcrs") as Map<number, Uint8Array> | undefined;
		const leafCertDer = get("certificate") as Uint8Array | undefined;
		const caBundle = get("cabundle") as Uint8Array[] | undefined;
		const publicKey = get("public_key") as Uint8Array | undefined;
		const moduleId = String(get("module_id") ?? "");

		const checks: AttestationResult["checks"] = {
			nonce: { ok: false, detail: "Not checked" },
			timestamp: { ok: false, detail: "Not checked" },
			pcr0: { ok: false, detail: "Not checked" },
			certChain: { ok: false, detail: "Not checked" },
			signature: { ok: false, detail: "Not checked" },
		};

		// 3. Nonce check
		const myNonce = opts.nonce;
		checks.nonce.ok =
			!!nonce &&
			nonce.length === myNonce.length &&
			nonce.every((b, i) => b === myNonce[i]);
		checks.nonce.detail = checks.nonce.ok
			? `Matches your challenge (${bytesToHex(nonce!).slice(0, 12)}...)`
			: `Nonce mismatch: expected ${bytesToHex(myNonce).slice(0, 12)}..., got ${bytesToHex(nonce ?? new Uint8Array(0)).slice(0, 12)}...`;

		// 4. Timestamp check
		checks.timestamp.ok =
			typeof timestamp === "number" &&
			Number.isFinite(timestamp) &&
			Math.abs(now - timestamp) <= MAX_SKEW_MS;
		checks.timestamp.detail = checks.timestamp.ok
			? `Recent (${new Date(timestamp!).toISOString()})`
			: timestamp
				? `Stale or skewed: ${new Date(timestamp!).toISOString()} (${Math.abs(now - timestamp) / 1000}s off)`
				: "No timestamp in attestation";

		// 5. PCR0 check
		const pcr0Raw = pcrsMap instanceof Map ? pcrsMap.get(0) : undefined;
		const pcr0 = pcr0Raw ? bytesToHex(new Uint8Array(pcr0Raw)) : "";
		checks.pcr0.ok =
			!!pcr0 && pcr0.toLowerCase() === opts.expectedPcr0.toLowerCase();
		checks.pcr0.detail = checks.pcr0.ok
			? `Matches published PCR0 (${pcr0.slice(0, 8)}...${pcr0.slice(-8)})`
			: `PCR0 mismatch: expected ${opts.expectedPcr0.slice(0, 16)}..., got ${pcr0.slice(0, 16)}...`;

		// 6. Certificate chain verification
		let certChainOk = false;
		let certDetail = "No certificates";
		if (leafCertDer && caBundle && caBundle.length > 0) {
			try {
				certChainOk = await verifyCertChainInBrowser(leafCertDer, caBundle, {
					rootFingerprint: opts.rootFingerprint,
					now,
				});
				certDetail = certChainOk
					? `Valid chain (${caBundle.length + 1} certs, all in date)`
					: "Certificate chain verification failed";
			} catch (e) {
				certDetail = `Chain error: ${(e as Error).message}`;
			}
		} else {
			certDetail = leafCertDer
				? "Missing CA bundle (cabundle)"
				: "No leaf certificate in attestation";
		}
		checks.certChain = { ok: certChainOk, detail: certDetail };

		// 7. COSE signature verification
		let sigOk = false;
		let sigDetail = "Not checked";
		if (certChainOk && leafCertDer) {
			try {
				sigOk = await verifyCoseSignatureInBrowser(cose, leafCertDer);
				sigDetail = sigOk
					? "Valid ECDSA-P384 signature"
					: "Bad COSE signature (tampered or wrong key)";
			} catch (e) {
				sigDetail = `Signature error: ${(e as Error).message}`;
			}
		} else if (!leafCertDer) {
			sigDetail = "No leaf certificate to verify against";
		} else {
			sigDetail = "Skipped (cert chain failed)";
		}
		checks.signature = { ok: sigOk, detail: sigDetail };

		const verified =
			checks.nonce.ok &&
			checks.timestamp.ok &&
			checks.pcr0.ok &&
			checks.certChain.ok &&
			checks.signature.ok;

		return {
			verified,
			checks,
			data: {
				pcr0,
				moduleId,
				publicKeyDer: publicKey ? new Uint8Array(publicKey) : null,
				timestamp: timestamp ? new Date(timestamp).toISOString() : "",
				certCount: (leafCertDer ? 1 : 0) + (caBundle?.length ?? 0),
			},
		};
	} catch (e) {
		// Parsing-level failure
		return {
			verified: false,
			checks: {
				nonce: { ok: false, detail: "Parse error" },
				timestamp: { ok: false, detail: "Parse error" },
				pcr0: { ok: false, detail: "Parse error" },
				certChain: { ok: false, detail: "Parse error" },
				signature: {
					ok: false,
					detail: `Failed to parse attestation: ${(e as Error).message}`,
				},
			},
			data: {
				pcr0: "",
				moduleId: "",
				publicKeyDer: null,
				timestamp: "",
				certCount: 0,
			},
		};
	}
}

// ── Certificate chain verification (SubtleCrypto) ─────────────────────────

/** Verify X.509 certificate chain: leaf → intermediates → root,
 *  anchoring on the AWS Nitro root fingerprint. */
async function verifyCertChainInBrowser(
	leafDer: Uint8Array,
	caBundle: Uint8Array[],
	opts: { rootFingerprint?: string; now?: number } = {},
): Promise<boolean> {
	const rootFp = (opts.rootFingerprint ?? AWS_NITRO_ROOT_FP).toLowerCase();
	const now = opts.now ?? Date.now();

	if (caBundle.length < 1) throw new Error("Empty CA bundle");

	// Build chain: [leaf, ...intermediates (reverse order), root]
	const root = caBundle[0]!;
	const intermediates = caBundle.slice(1).reverse();
	const chain = [leafDer, ...intermediates, root];

	// Check root fingerprint
	const rootFingerprint = await sha256fingerprint(root);
	if (rootFingerprint !== rootFp) {
		throw new Error(
			`Root CA fingerprint mismatch: expected ${rootFp.slice(0, 16)}..., got ${rootFingerprint.slice(0, 16)}...`,
		);
	}

	// Verify each link in the chain
	for (let i = 0; i < chain.length - 1; i++) {
		const cert = chain[i]!;
		const issuer = chain[i + 1]!;

		// Check validity period
		const validity = parseCertValidity(cert);
		if (now < validity.notBefore || now > validity.notAfter) {
			const name =
				i === 0
					? "Leaf"
					: i === chain.length - 2
						? "Intermediate"
						: `Cert[${i}]`;
			throw new Error(
				`${name} certificate expired (valid ${validity.notBeforeISO} — ${validity.notAfterISO})`,
			);
		}

		// Verify issuer's signature on this cert
		const issuerPubKey = await importCertPublicKey(issuer);
		const { tbs, signature } = extractSignature(cert);
		const ok = await crypto.subtle.verify(
			{ name: "ECDSA", hash: { name: "SHA-384" } },
			issuerPubKey,
			signature.buffer as ArrayBuffer,
			tbs.buffer as ArrayBuffer,
		);
		if (!ok) {
			const name = i === 0 ? "Leaf" : `Cert[${i}]`;
			throw new Error(`${name} signature not valid under issuer`);
		}
	}

	return true;
}

// ── DER parsing helpers ────────────────────────────────────────────────────

interface DerLength {
	len: number;
	end: number;
}

/** Decode a DER length field starting at offset `pos`. */
function derLength(buf: Uint8Array, pos: number): DerLength {
	if (buf[pos]! < 0x80) {
		return { len: buf[pos]!, end: pos + 1 };
	}
	const n = buf[pos]! & 0x7f;
	if (n < 1 || n > 8) throw new Error(`Bad DER length encoding at ${pos}`);
	let len = 0;
	for (let i = 0; i < n; i++) {
		len = (len << 8) | buf[pos + 1 + i]!;
	}
	return { len, end: pos + 1 + n };
}

/** Skip one DER element, returning the offset after it. */
function derSkip(buf: Uint8Array, pos: number): number {
	if (pos >= buf.length) return pos;
	if ((buf[pos]! & 0xc0) === 0x80) {
		// Constructed or primitive — move past tag
		const tag = buf[pos]!;
		if (tag === 0x00 || tag === 0xff) return pos + 1;
		const { len, end } = derLength(buf, pos + 1);
		if (tag === 0x05) return end; // NULL
		if (tag === 0x03) {
			// BIT STRING — skip leading unused-bits byte
			return end + len;
		}
		return end + len;
	}
	// Context-specific constructed — skip tag + length + content
	const { len, end } = derLength(buf, pos + 1);
	return end + len;
}

/** Extract the TBS (to-be-signed) portion from a DER X.509 certificate.
 *  TBS is the second SEQUENCE after the outer SEQUENCE's first child. */
function extractCertParts(cert: Uint8Array): {
	tbs: Uint8Array;
	sig: Uint8Array;
} {
	// Outer Certificate SEQUENCE
	if (cert[0] !== 0x30) throw new Error("Cert must start with SEQUENCE");
	const outer = derLength(cert, 1);
	// The TBS Certificate is the first element (SEQUENCE)
	const tbsStart = outer.end;
	if (cert[tbsStart] !== 0x30) throw new Error("TBS must be SEQUENCE");
	const tbsLen = derLength(cert, tbsStart + 1);
	const tbsEnd = tbsStart + 1 + (tbsLen.end - (tbsStart + 1)) + tbsLen.len;
	const tbs = cert.slice(tbsStart, tbsEnd);

	// The last two elements are: signatureAlgorithm (SEQUENCE), signatureValue (BIT STRING)
	// Walk past all elements between TBS end and signature
	const pos = tbsEnd;

	// Skip BIT STRING at the end
	// Find last BIT STRING (0x03)
	let lastBitString = -1;
	for (let i = pos; i < cert.length; i++) {
		if (cert[i] === 0x03) lastBitString = i;
	}
	if (lastBitString < 0) throw new Error("No BIT STRING in cert");

	// Signature value is at the BIT STRING
	const sigStart = lastBitString + 1;
	const sigLen = derLength(cert, sigStart);
	const sig = cert.slice(
		sigStart + sigLen.end - sigStart + 1,
		sigStart + sigLen.end - sigStart + 1 + sigLen.len - 1,
	);

	return { tbs, sig };
}

/** Extract the signature from a DER X.509 certificate for verification. */
function extractSignature(cert: Uint8Array): {
	tbs: Uint8Array;
	signature: Uint8Array;
} {
	const { tbs, sig } = extractCertParts(cert);
	return { tbs, signature: sig };
}

/** Import the SubjectPublicKeyInfo from a DER X.509 certificate as a CryptoKey. */
async function importCertPublicKey(certDer: Uint8Array): Promise<CryptoKey> {
	// Find the SubjectPublicKeyInfo (SPKI) sequence inside the certificate
	const { spki } = extractSpki(certDer);
	return crypto.subtle.importKey(
		"spki",
		spki.buffer as ArrayBuffer,
		{ name: "ECDSA", namedCurve: "P-384" },
		false,
		["verify"],
	);
}

/** Extract the SubjectPublicKeyInfo SEQUENCE from a DER X.509 certificate.
 *  The SPKI is inside the TBS Certificate section. */
function extractSpki(cert: Uint8Array): { spki: Uint8Array } {
	if (cert[0] !== 0x30) throw new Error("Expected SEQUENCE");

	const { tbs } = extractCertParts(cert);

	// Inside TBS: [version, serialNumber, signature, issuer, validity, subject, spki, ...]
	// Skip: version [0] EXPLICIT, serialNumber INTEGER, signature SEQUENCE, issuer SEQUENCE,
	//       validity SEQUENCE OF, subject SEQUENCE
	let pos = 2; // past the outer SEQUENCE tag+length of TBS

	// Skip version ([0] EXPLICIT context tag)
	if (tbs[pos] === 0xa0) pos = derSkip(tbs, pos);

	// Skip serial (INTEGER)
	if ((tbs[pos]! & 0xc0) === 0x80) pos = derSkip(tbs, pos);

	// Skip signature algo (SEQUENCE)
	pos = derSkip(tbs, pos);

	// Skip issuer (SEQUENCE)
	pos = derSkip(tbs, pos);

	// Skip validity (SEQUENCE of two UTCTime/GENERALIZEDTIME)
	pos = derSkip(tbs, pos);

	// Skip subject (SEQUENCE)
	pos = derSkip(tbs, pos);

	// Now at SPKI — a SEQUENCE tagged 0x30
	if (tbs[pos] !== 0x30) {
		// Could be [2] IMPLICIT (issuer unique id) — skip it
		while (pos < tbs.length && tbs[pos] !== 0x30) {
			pos = derSkip(tbs, pos);
		}
	}
	if (pos >= tbs.length || tbs[pos] !== 0x30)
		throw new Error("Could not find SPKI in certificate");

	const { len, end } = derLength(tbs, pos + 1);
	const spki = tbs.slice(pos, end + len);
	return { spki };
}

/** Parse validity period from a DER X.509 certificate. */
function parseCertValidity(cert: Uint8Array): {
	notBefore: number;
	notAfter: number;
	notBeforeISO: string;
	notAfterISO: string;
} {
	const { tbs } = extractCertParts(cert);

	// Walk to validity section — skip version, serial, signature, issuer
	let pos = 2;
	if (tbs[pos] === 0xa0) pos = derSkip(tbs, pos); // version
	pos = derSkip(tbs, pos); // serial
	pos = derSkip(tbs, pos); // signature alg
	pos = derSkip(tbs, pos); // issuer

	// Validity SEQUENCE containing [notBefore, notAfter]
	if (tbs[pos] !== 0x30) throw new Error("Expected validity SEQUENCE");
	const { len: vLen, end: vEnd } = derLength(tbs, pos + 1);
	const validityStart = vEnd;
	const validity = tbs.slice(validityStart, validityStart + vLen);

	// Two date values: UTCTime (0x17) or GENERALIZEDTIME (0x18)
	const dates: number[] = [];
	let dp = 0;
	while (dp < validity.length && dates.length < 2) {
		const tag = validity[dp]!;
		if (tag === 0x17 || tag === 0x18) {
			const l = validity[dp + 1]!;
			const dateStr = new TextDecoder().decode(
				validity.slice(dp + 2, dp + 2 + l),
			);
			dates.push(parseDerDate(dateStr, tag === 0x18).getTime());
			dp += 2 + l;
		} else {
			dp++;
		}
	}

	if (dates.length < 2) throw new Error("Could not parse validity dates");

	return {
		notBefore: dates[0]!,
		notAfter: dates[1]!,
		notBeforeISO: new Date(dates[0]!).toISOString(),
		notAfterISO: new Date(dates[1]!).toISOString(),
	};
}

function parseDerDate(s: string, generalized: boolean): Date {
	if (generalized) {
		// YYYYMMDDHHMMSSZ
		return new Date(
			Number(s.slice(0, 4)),
			Number(s.slice(4, 6)) - 1,
			Number(s.slice(6, 8)),
			Number(s.slice(8, 10)),
			Number(s.slice(10, 12)),
			Number(s.slice(12, 14)),
		);
	}
	// YYMMDDHHMMSSZ — UTCTime. YY >= 50 → 1900, else 2000
	const yy = Number(s.slice(0, 2));
	const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy;
	return new Date(
		yyyy,
		Number(s.slice(2, 4)) - 1,
		Number(s.slice(4, 6)),
		Number(s.slice(6, 8)),
		Number(s.slice(8, 10)),
		Number(s.slice(10, 12)),
	);
}

// ── COSE signature verification ───────────────────────────────────────────

/**
 * Build the COSE_Sign1 `Sig_structure` as defined by RFC 8152:
 *   ["Signature1", protected, external_aad (empty), payload]
 * as definite-length CBOR. Hand-encoded because we can't rely on a full
 * CBOR encoder being available on all platforms. */
function buildSigStructure(
	protectedHeader: Uint8Array,
	payload: Uint8Array,
): Uint8Array {
	// CBOR: array(4) = 0x84
	// text("Signature1") = 0x6a + "Signature1" (10 bytes)
	// bstr(protected) = cborBstr(protected)
	// bstr(empty) = 0x40 (empty byte string)
	// bstr(payload) = cborBstr(payload)

	const parts: Uint8Array[] = [
		new Uint8Array([0x84]),
		cborTstr("Signature1"),
		cborBstr(protectedHeader),
		new Uint8Array([0x40]), // empty bstr for external_aad
		cborBstr(payload),
	];
	const totalLen = parts.reduce((s, p) => s + p.length, 0);
	const result = new Uint8Array(totalLen);
	let off = 0;
	for (const p of parts) {
		result.set(p, off);
		off += p.length;
	}
	return result;
}

function cborTstr(s: string): Uint8Array {
	const b = new TextEncoder().encode(s);
	if (b.length >= 24) throw new Error("cborTstr: only short strings");
	const h = new Uint8Array([0x60 | b.length]);
	const r = new Uint8Array(h.length + b.length);
	r.set(h, 0);
	r.set(b, h.length);
	return r;
}

function cborBstr(b: Uint8Array): Uint8Array {
	let head: Uint8Array;
	if (b.length < 24) head = new Uint8Array([0x40 | b.length]);
	else if (b.length < 0x100) head = new Uint8Array([0x58, b.length]);
	else if (b.length < 0x10000)
		head = new Uint8Array([0x59, b.length >> 8, b.length & 0xff]);
	else
		head = new Uint8Array([
			0x5a,
			(b.length >>> 24) & 0xff,
			(b.length >>> 16) & 0xff,
			(b.length >>> 8) & 0xff,
			b.length & 0xff,
		]);

	const r = new Uint8Array(head.length + b.length);
	r.set(head, 0);
	r.set(b, head.length);
	return r;
}

/** Verify the COSE ES384 (ECDSA P-384) signature over the payload using the
 *  leaf certificate's key. The COSE signature is already in IEEE P1363 format
 *  (raw r||s, 96 bytes). */
async function verifyCoseSignatureInBrowser(
	cose: ReturnType<typeof parseCoseSign1>,
	leafCertDer: Uint8Array,
): Promise<boolean> {
	const leafPubKey = await importCertPublicKey(leafCertDer);
	const sigStructure = buildSigStructure(cose.protectedHeader, cose.payload);

	return crypto.subtle.verify(
		{ name: "ECDSA", hash: { name: "SHA-384" } },
		leafPubKey,
		cose.signature.buffer as ArrayBuffer,
		sigStructure.buffer as ArrayBuffer,
	);
}

// ── SHA-256 fingerprint ───────────────────────────────────────────────────

async function sha256fingerprint(der: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", der.buffer as ArrayBuffer);
	const hex = bytesToHex(new Uint8Array(hash));
	return hex.toLowerCase();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}
