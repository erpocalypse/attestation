// In-browser verification of the enclave's AWS Nitro attestation. The whole
// point of /security is that THIS runs client-side: the user's own browser
// confirms the live enclave is genuine AWS hardware running our published image,
// trusting only AWS's root CA + the code they can read — not our API.
import { decode, encode, Tag } from "cbor2";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(crypto);

// AWS Nitro Enclaves Root CA G1, SHA-256 fingerprint (published by AWS at
// docs.aws.amazon.com/enclaves/latest/user/verify-root.html). The root ships in
// the doc's cabundle; pinning its fingerprint anchors trust without a PEM.
const AWS_NITRO_ROOT_FP =
  "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b";
const MAX_SKEW_MS = 5 * 60_000;
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

// Expected enclave measurements, PINNED into this client bundle — deliberately
// NOT fetched from our API. Sourcing the expected PCR0 from the same operator API
// that serves the attestation doc would be CIRCULAR: a malicious operator could
// run a swapped (e.g. logging) image and return BOTH its real attestation AND a
// matching "expected" value, and the check would pass. Pinning here means
// subverting it requires shipping a modified — and publicly diffable — client.
// These MUST equal infra/enclave/measurements.json and the deployed ENCLAVE_PCR0
// (pcr0-pin.test.ts enforces the measurements.json match). On a PCR0 cutover,
// bump these WITH measurements.json and re-publish the attestation mirror BEFORE
// flipping the fleet, or every client's check fails.
const EXPECTED_PCR0 =
  "572ebfcb3ce3cc815bde10cc72498a3c473c117168f4b7595c28831e464165a7bb3a2eb97a312969b413bbdfafb481e2";
// Non-empty only during a measured image rollover. Both values are compiled
// into the public client; remove the old pin as soon as the old fleet drains.
const PREVIOUS_PCR0 =
  "";
const PREVIOUS_PCR1 =
  "";
const PREVIOUS_PCR2 =
  "";
const EXPECTED_PCR1 =
  "3b4a7e1b5f13c5a1000b3ed32ef8995ee13e9876329f9bc72650b918329ef9cf4e2e4d1e1e37375dab0ba56ba0974d03";
const EXPECTED_PCR2 =
  "efb876639951dc13a6a04a0b6f4121e0335307c3ccf0bf1b6ea3c6f93599afb545ad9c98636d448c918f5117cd7192f5";

export interface Check {
  ok: boolean;
  label: string;
  detail: string;
}
export interface VerificationResult {
  verified: boolean;
  checks: Check[];
  pcr0: string;
  moduleId: string;
  timestamp: number;
}

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
// WebCrypto's BufferSource type rejects Uint8Array<ArrayBufferLike> under newer
// lib.dom types; this asserts the (always ArrayBuffer-backed) bytes are fine.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const mapGet = (m: unknown, k: unknown): unknown =>
  m instanceof Map ? m.get(k) : (m as Record<string, unknown>)[k as string];

/** Challenge the enclave with a fresh nonce and fetch its signed attestation. */
export async function fetchAttestation(): Promise<{ doc: string; pcr0: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceB64 = btoa(String.fromCharCode(...nonce));
  const res = await fetch(`${API_URL}/security/attestation?nonce=${encodeURIComponent(nonceB64)}`);
  if (!res.ok) throw new Error(`attestation unavailable (${res.status})`);
  return res.json();
}

/** Verify a COSE_Sign1 Nitro attestation doc entirely in the browser. Never
 *  throws on a failed check — returns each check's result for display. */
export async function verifyAttestation(
  docB64: string,
  expectedNonceB64: string,
): Promise<VerificationResult> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });

  const cose = decode(b64ToBytes(docB64));
  const arr = (cose instanceof Tag ? cose.contents : cose) as unknown[];
  const protectedBytes = arr[0] as Uint8Array;
  const payloadBytes = arr[2] as Uint8Array;
  const signature = arr[3] as Uint8Array;
  const payload = decode(payloadBytes);

  const pcr0 = toHex(new Uint8Array(mapGet(mapGet(payload, "pcrs"), 0) as ArrayBuffer));
  const pcr1 = toHex(new Uint8Array(mapGet(mapGet(payload, "pcrs"), 1) as ArrayBuffer));
  const pcr2 = toHex(new Uint8Array(mapGet(mapGet(payload, "pcrs"), 2) as ArrayBuffer));
  const moduleId = String(mapGet(payload, "module_id") ?? "");
  const timestamp = Number(mapGet(payload, "timestamp"));
  const certDer = new Uint8Array(mapGet(payload, "certificate") as ArrayBuffer);
  const cabundle = (mapGet(payload, "cabundle") as ArrayBuffer[]).map((c) => new Uint8Array(c));

  // 1. Genuine enclave: ES384 COSE signature verifies under the leaf cert's key.
  try {
    const leaf = new x509.X509Certificate(certDer);
    const key = await leaf.publicKey.export(crypto);
    const sigStruct = encode(["Signature1", protectedBytes, new Uint8Array(0), payloadBytes]);
    const sigOk = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      key,
      bs(signature),
      bs(sigStruct),
    );
    add(sigOk, "Signed by AWS Nitro hardware", sigOk ? "Valid ECDSA-P384 signature" : "Bad signature");
  } catch (e) {
    add(false, "Signed by AWS Nitro hardware", String(e));
  }

  // 2. Trust anchor: the cabundle root is the published AWS Nitro Root CA.
  try {
    const rootFp = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bs(cabundle[0]!))));
    add(rootFp === AWS_NITRO_ROOT_FP, "Chains to the AWS Nitro root CA",
      rootFp === AWS_NITRO_ROOT_FP ? "Root fingerprint pinned" : "Unknown root CA");
  } catch (e) {
    add(false, "Chains to the AWS Nitro root CA", String(e));
  }

  // 3. Certificate chain links (leaf → intermediates → root) all verify + valid.
  try {
    const certs = [new x509.X509Certificate(certDer), ...cabundle.slice(1).reverse().map((d) => new x509.X509Certificate(d)), new x509.X509Certificate(cabundle[0]!)];
    const now = new Date();
    let chainOk = true;
    for (let i = 0; i < certs.length; i++) {
      const c = certs[i]!;
      if (now < c.notBefore || now > c.notAfter) chainOk = false;
      const issuer = certs[i + 1] ?? certs[certs.length - 1]!;
      if (!(await c.verify({ publicKey: issuer.publicKey }, crypto))) chainOk = false;
    }
    add(chainOk, "Valid certificate chain", chainOk ? `${certs.length} certs, all in date` : "Broken chain");
  } catch (e) {
    add(false, "Valid certificate chain", String(e));
  }

  // 4. Running OUR exact published image. Expected measurements are PINNED in this
  // bundle (EXPECTED_PCR0/1/2) — NOT taken from the API response — so the operator
  // can't hand the browser a matching "expected" value for a swapped image. PCR1
  // (kernel/boot) and PCR2 (app/rootfs) are checked alongside PCR0 for full pinning.
  const acceptedMeasurements = [
    [EXPECTED_PCR0, EXPECTED_PCR1, EXPECTED_PCR2],
    [PREVIOUS_PCR0, PREVIOUS_PCR1, PREVIOUS_PCR2],
  ].filter((tuple) => tuple.every(Boolean));
  const tupleOk = acceptedMeasurements.some(
    ([p0, p1, p2]) =>
      pcr0.toLowerCase() === p0!.toLowerCase() &&
      pcr1.toLowerCase() === p1!.toLowerCase() &&
      pcr2.toLowerCase() === p2!.toLowerCase(),
  );
  add(tupleOk, "Running the published code",
    `PCR0 ${pcr0.slice(0, 24)}...`);
  add(tupleOk, "Pinned boot measurement (PCR1)",
    `PCR1 ${pcr1.slice(0, 24)}...`);
  add(tupleOk, "Pinned app measurement (PCR2)",
    `PCR2 ${pcr2.slice(0, 24)}...`);

  // 5. Freshness: the doc answers THIS challenge, recently.
  const nonceOk = toHex(new Uint8Array(mapGet(payload, "nonce") as ArrayBuffer)) ===
    toHex(b64ToBytes(expectedNonceB64));
  add(nonceOk, "Fresh (not replayed)", nonceOk ? "Nonce matches your challenge" : "Nonce mismatch");
  const skewOk = Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < MAX_SKEW_MS;
  add(skewOk, "Recent timestamp", skewOk ? new Date(timestamp).toISOString() : "Stale");

  return { verified: checks.every((c) => c.ok), checks, pcr0, moduleId, timestamp };
}

/** Fetch a fresh attestation, VERIFY it end-to-end in the browser, and return the
 *  enclave's RSA public key (DER SPKI bytes) bound INTO that verified doc. This is
 *  the trust gate for the operator-blind INBOUND path: the client seals its new
 *  message to THIS key, so only the attested enclave (running our published PCR0)
 *  can open it — the API/operator relays opaque ciphertext. Throws if any check
 *  fails (never seal to an unverified key). The pubkey is cached briefly so a
 *  burst of sends doesn't re-attest every keystroke-send. */
let _pubkeyCache: { key: Uint8Array; expires: number } | null = null;
const PUBKEY_TTL_MS = 60_000;

export async function getVerifiedEnclavePublicKey(): Promise<Uint8Array> {
  const now = Date.now();
  if (_pubkeyCache && _pubkeyCache.expires > now) return _pubkeyCache.key;

  // IGNORE the pcr0 the API returns — the expected value is pinned in this bundle
  // (EXPECTED_PCR0), checked inside verifyAttestation. Trusting the API's pcr0 here
  // would defeat the whole gate on the path that actually seals plaintext.
  const { doc, nonce } = await fetchAttestation();
  const result = await verifyAttestation(doc, nonce);
  if (!result.verified) {
    throw new Error("enclave attestation failed — refusing to seal to it");
  }
  // Re-decode the doc to pull the enclave's bound public key (the field the NSM
  // signs alongside the PCRs + nonce we just verified). Same COSE payload.
  const cose = decode(b64ToBytes(doc));
  const arr = (cose instanceof Tag ? cose.contents : cose) as unknown[];
  const payload = decode(arr[2] as Uint8Array);
  const pk = mapGet(payload, "public_key");
  if (!pk) throw new Error("attestation doc carries no enclave public key");
  const key = new Uint8Array(pk as ArrayBuffer);
  _pubkeyCache = { key, expires: now + PUBKEY_TTL_MS };
  return key;
}

/** Drop the cached enclave pubkey so the NEXT seal re-attests (BAC-205). Called
 *  on enclave-flavored stream failures — the cached key may belong to a host
 *  that no longer exists (replacement / identity rotation), and without this
 *  every retry inside the TTL keeps sealing to the dead host's key. */
export function invalidateEnclavePubkeyCache(): void {
  _pubkeyCache = null;
}
