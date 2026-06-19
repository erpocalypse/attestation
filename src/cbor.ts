/**
 * Minimal CBOR decoder — only the subset used by AWS Nitro attestation docs
 * (COSE_Sign1 / tag 18). No streaming, no encoding, no indefinite-length support.
 *
 * Supported: uint, bstr, tstr, array, map, tag (18 only), bool, null.
 */

const MAJOR = 0xe0;
const EXTRA = 0x1f;

export class CborTag {
	constructor(
		public readonly number: number,
		public readonly contents: unknown,
	) {}
}

export function decode(data: ArrayBuffer | Uint8Array): unknown {
	const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
	const [val] = _decode(buf, 0);
	return val;
}

type Decoded = [value: unknown, consumed: number];

function _decode(buf: Uint8Array, off: number): Decoded {
	if (off >= buf.length) throw new Error("cbor: unexpected end");
	const ib = buf[off]!;
	const major = ib & MAJOR;
	const extra = ib & EXTRA;
	let arg: number;
	let pos: number;

	if (extra < 24) {
		arg = extra;
		pos = off + 1;
	} else if (extra === 24) {
		arg = buf[off + 1]!;
		pos = off + 2;
	} else if (extra === 25) {
		arg = (buf[off + 1]! << 8) | buf[off + 2]!;
		pos = off + 3;
	} else if (extra === 26) {
		arg =
			((buf[off + 1]! << 24) |
				(buf[off + 2]! << 16) |
				(buf[off + 3]! << 8) |
				buf[off + 4]!) >>>
			0;
		pos = off + 5;
	} else if (extra === 27) {
		arg = Number(
			((BigInt(buf[off + 1]!) << 56n) |
				(BigInt(buf[off + 2]!) << 48n) |
				(BigInt(buf[off + 3]!) << 40n) |
				(BigInt(buf[off + 4]!) << 32n) |
				(BigInt(buf[off + 5]!) << 24n) |
				(BigInt(buf[off + 6]!) << 16n) |
				(BigInt(buf[off + 7]!) << 8n) |
				BigInt(buf[off + 8]!)) &
				0xffffffffffffffffn,
		);
		pos = off + 9;
	} else {
		throw new Error(`cbor: reserved extra value ${extra}`);
	}

	switch (major) {
		case 0x00: // unsigned integer
			return [arg, pos];

		case 0x20: // negative integer
			return [-1 - arg, pos];

		case 0x40: {
			// byte string
			const b = buf.slice(pos, pos + arg);
			return [b, pos + arg];
		}

		case 0x60: {
			// text string
			const s = new TextDecoder().decode(buf.slice(pos, pos + arg));
			return [s, pos + arg];
		}

		case 0x80: {
			// array
			const items: unknown[] = [];
			let p = pos;
			for (let i = 0; i < arg; i++) {
				const [v, c] = _decode(buf, p);
				items.push(v);
				p = c;
			}
			return [items, p];
		}

		case 0xa0: {
			// map
			const map = new Map<unknown, unknown>();
			let p = pos;
			for (let i = 0; i < arg; i++) {
				const [k, ck] = _decode(buf, p);
				const [v, cv] = _decode(buf, ck);
				map.set(k, v);
				p = cv;
			}
			return [map, p];
		}

		case 0xc0: {
			// tag
			const [content, c] = _decode(buf, pos);
			return [new CborTag(arg, content), c];
		}

		case 0xe0: {
			// simple value (7)
			if (arg === 20) return [false, pos];
			if (arg === 21) return [true, pos];
			if (arg === 22) return [null, pos];
			if (arg === 23) return [undefined, pos];
			throw new Error(`cbor: unsupported simple value ${arg}`);
		}

		default:
			throw new Error(`cbor: unsupported major type ${major >> 5}`);
	}
}

/** Tag 18 = COSE_Sign1 — the AWS Nitro attestation document format. */
export const COSE_SIGN1_TAG = 18;

/** Extract the four parts from a COSE_Sign1 structure:
 *  [protected_header, unprotected_header, payload, signature] */
export function parseCoseSign1(doc: ArrayBuffer | Uint8Array): {
	protectedHeader: Uint8Array;
	unprotectedHeader: unknown;
	payload: Uint8Array;
	signature: Uint8Array;
} {
	const top = decode(doc);
	const tag = top as CborTag;
	if (!(tag instanceof CborTag) || tag.number !== COSE_SIGN1_TAG) {
		throw new Error("attestation: not a COSE_Sign1 (tag 18)");
	}
	const arr = tag.contents as unknown[];
	if (!Array.isArray(arr) || arr.length !== 4) {
		throw new Error("attestation: COSE_Sign1 must have 4 parts");
	}
	return {
		protectedHeader: arr[0] as Uint8Array,
		unprotectedHeader: arr[1],
		payload: arr[2] as Uint8Array,
		signature: arr[3] as Uint8Array,
	};
}
