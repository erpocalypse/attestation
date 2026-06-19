import { describe, it, expect } from "bun:test";
import { decode } from "./cbor";
import {
	encryptToEnclave,
	decryptEFrame,
	generateTurnKeypair,
	unwrapSessionKey,
} from "./enclave";

function b64(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, "base64"));
}
function b64enc(b: Uint8Array): string {
	return Buffer.from(b).toString("base64");
}

// ── Test utilities ─────────────────────────────────────────────────────────

async function makeKeypair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 3072,
			publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
			hash: "SHA-256",
		},
		true,
		["encrypt", "decrypt"],
	) as Promise<CryptoKeyPair>;
}

// ── CBOR tests ─────────────────────────────────────────────────────────────

describe("cbor", () => {
	it("decodes unsigned integers", () => {
		expect(decode(new Uint8Array([0x00]))).toBe(0);
		expect(decode(new Uint8Array([0x17]))).toBe(23);
		expect(decode(new Uint8Array([0x18, 0x18]))).toBe(24);
		expect(decode(new Uint8Array([0x19, 0x03, 0xe8]))).toBe(1000);
		expect(decode(new Uint8Array([0x1a, 0x00, 0x05, 0x39, 0x90]))).toBe(342416);
	});

	it("decodes byte strings", () => {
		const result = decode(new Uint8Array([0x43, 0x01, 0x02, 0x03]));
		expect(result).toBeInstanceOf(Uint8Array);
		expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3]);
	});

	it("decodes text strings", () => {
		expect(
			decode(new Uint8Array([0x65, ...new TextEncoder().encode("hello")])),
		).toBe("hello");
	});

	it("decodes arrays", () => {
		const result = decode(new Uint8Array([0x83, 0x01, 0x02, 0x03]));
		expect(result).toBeInstanceOf(Array);
		expect(result as unknown[]).toEqual([1, 2, 3]);
	});

	it("decodes maps", () => {
		const result = decode(
			new Uint8Array([0xa2, 0x01, 0x61, 0x61, 0x02, 0x61, 0x62]),
		);
		expect(result).toBeInstanceOf(Map);
		const m = result as Map<unknown, unknown>;
		expect(m.get(1)).toBe("a");
		expect(m.get(2)).toBe("b");
	});

	it("decodes booleans and null", () => {
		expect(decode(new Uint8Array([0xf4]))).toBe(false);
		expect(decode(new Uint8Array([0xf5]))).toBe(true);
		expect(decode(new Uint8Array([0xf6]))).toBe(null);
	});
});

// ── Enclave crypto tests ───────────────────────────────────────────────────

describe("enclave crypto", () => {
	it("generateTurnKeypair produces RSA-3072 keypair", async () => {
		const kp = await generateTurnKeypair();
		expect(kp.publicKeyB64).toBeTruthy();
		expect(kp.privateKey).toBeTruthy();
		const decoded = b64(kp.publicKeyB64);
		expect(decoded.length).toBeGreaterThan(400);
		expect(decoded.length).toBeLessThan(600);
	});

	it("encryptToEnclave produces valid envelope", async () => {
		const kp = await makeKeypair();
		const spki = new Uint8Array(
			await crypto.subtle.exportKey("spki", kp.publicKey!),
		);
		const enclaveKey = await crypto.subtle.importKey(
			"spki",
			spki.buffer as ArrayBuffer,
			{ name: "RSA-OAEP", hash: "SHA-256" },
			false,
			["encrypt"],
		);

		const message = "Hello, confidential chat!";
		const envelopeB64 = await encryptToEnclave(enclaveKey, message);
		expect(envelopeB64).toBeTruthy();

		const envelope = b64(envelopeB64);
		expect(envelope.length).toBeGreaterThan(384 + 12 + 16);

		// Decrypt the AES key
		const wrapped = envelope.slice(0, 384);
		const aesKeyBytes = await crypto.subtle.decrypt(
			{ name: "RSA-OAEP" },
			kp.privateKey!,
			wrapped,
		);
		expect(aesKeyBytes.byteLength).toBe(32);

		// Decrypt the message
		const iv = envelope.slice(384, 396);
		const ctTag = envelope.slice(396);
		const aesKey = await crypto.subtle.importKey(
			"raw",
			aesKeyBytes,
			{ name: "AES-GCM" },
			false,
			["decrypt"],
		);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, tagLength: 128 },
			aesKey,
			ctTag,
		);
		expect(new TextDecoder().decode(plaintext)).toBe(message);
	});

	it("unwrapSessionKey + decryptEFrame round-trips", async () => {
		const turnKp = await generateTurnKeypair();
		const sessionKeyBytes = crypto.getRandomValues(new Uint8Array(32));

		// Enclave side: wrap session key to client's ephemeral pubkey
		const pubKeyDer = b64(turnKp.publicKeyB64);
		const clientPubKey = await crypto.subtle.importKey(
			"spki",
			pubKeyDer.buffer as ArrayBuffer,
			{ name: "RSA-OAEP", hash: "SHA-256" },
			false,
			["encrypt"],
		);
		const wrappedKey = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "RSA-OAEP" },
				clientPubKey,
				sessionKeyBytes,
			),
		);
		const kFrameB64 = b64enc(wrappedKey);

		// AES-GCM encrypt a token
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const aesKey = await crypto.subtle.importKey(
			"raw",
			sessionKeyBytes,
			{ name: "AES-GCM" },
			false,
			["encrypt"],
		);
		const eCt = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, tagLength: 128 },
				aesKey,
				new TextEncoder().encode(JSON.stringify({ t: "Hello!" })),
			),
		);
		const eFrame = new Uint8Array(12 + eCt.length);
		eFrame.set(iv, 0);
		eFrame.set(eCt, 12);
		const eFrameB64 = b64enc(eFrame);

		// Client side: decrypt
		const sessionKey = await unwrapSessionKey(turnKp.privateKey, kFrameB64);
		expect(sessionKey).toBeTruthy();
		expect(sessionKey.algorithm.name).toBe("AES-GCM");

		const plaintext = await decryptEFrame(sessionKey, eFrameB64);
		expect(JSON.parse(plaintext).t).toBe("Hello!");
	});

	it("full browser→enclave→browser round-trip", async () => {
		// Enclave keypair (simulated)
		const enclaveKp = await makeKeypair();
		const enclaveSpki = new Uint8Array(
			await crypto.subtle.exportKey("spki", enclaveKp.publicKey!),
		);
		const enclaveKey = await crypto.subtle.importKey(
			"spki",
			enclaveSpki.buffer as ArrayBuffer,
			{ name: "RSA-OAEP", hash: "SHA-256" },
			false,
			["encrypt"],
		);

		const message = "Hey, can you keep a secret?";
		const sealedMessage = await encryptToEnclave(enclaveKey, message);

		// Turn keypair
		const turnKp = await generateTurnKeypair();
		const clientPubKeyDer = b64(turnKp.publicKeyB64);

		// Enclave decrypts message
		const sealed = b64(sealedMessage);
		const aesKeyBytes = await crypto.subtle.decrypt(
			{ name: "RSA-OAEP" },
			enclaveKp.privateKey!,
			sealed.slice(0, 384),
		);
		const iv = sealed.slice(384, 396);
		const ctTag = sealed.slice(396);
		const aesKey = await crypto.subtle.importKey(
			"raw",
			aesKeyBytes,
			{ name: "AES-GCM" },
			false,
			["decrypt"],
		);
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, tagLength: 128 },
			aesKey,
			ctTag,
		);
		expect(new TextDecoder().decode(decrypted)).toBe(message);

		// Enclave encrypts response
		const respSessionKey = crypto.getRandomValues(new Uint8Array(32));
		const clientPubKey = await crypto.subtle.importKey(
			"spki",
			clientPubKeyDer.buffer as ArrayBuffer,
			{ name: "RSA-OAEP", hash: "SHA-256" },
			false,
			["encrypt"],
		);
		const wrappedResp = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "RSA-OAEP" },
				clientPubKey,
				respSessionKey,
			),
		);
		const kFrameB64 = b64enc(wrappedResp);

		const respAes = await crypto.subtle.importKey(
			"raw",
			respSessionKey,
			{ name: "AES-GCM" },
			false,
			["encrypt"],
		);
		const tokens = ["The", " secret", " is", " safe"];
		const eFrames: string[] = [];
		for (const t of tokens) {
			const eIv = crypto.getRandomValues(new Uint8Array(12));
			const eCt2 = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv: eIv, tagLength: 128 },
					respAes,
					new TextEncoder().encode(JSON.stringify({ t })),
				),
			);
			const ef = new Uint8Array(12 + eCt2.length);
			ef.set(eIv, 0);
			ef.set(eCt2, 12);
			eFrames.push(b64enc(ef));
		}

		// Client decrypts response
		const sessionKey = await unwrapSessionKey(turnKp.privateKey, kFrameB64);
		let combined = "";
		for (const ef of eFrames) {
			const pt = await decryptEFrame(sessionKey, ef);
			combined += JSON.parse(pt).t;
		}
		expect(combined).toBe("The secret is safe");
	});
});
