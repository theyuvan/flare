/**
 * Crypto for the confidential scanning extension.
 *
 * Two separable pieces:
 *
 *   1. ECIES — how a scan key reaches the enclave. The instruction payload
 *      travels on-chain and is public to the world, so the key is sealed to a
 *      keypair that only ever exists inside the enclave.
 *
 *   2. The scan itself — the same secp256k1 ECDH matching as
 *      backend/crypto/derived.js, generalised to a split scan/spend key.
 *
 * On the split: FlarePay's Circom circuit already takes `scanPriv` and
 * `spendPriv` as separate signals; today the app passes metaPriv for both.
 * Scanning only ever needs the scan half, so delegating it here hands out
 * detection ability without spending ability. When scanPriv == spendPriv the
 * maths below reduces exactly to the current single-key behaviour, so this
 * works against announcements already on chain.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const G = secp256k1.Point.BASE;
const CURVE_N = secp256k1.Point.Fn.ORDER;

const EPH_PUB_LEN = 33; // compressed secp256k1 point
const IV_LEN = 12; // AES-GCM nonce
const TAG_LEN = 16; // AES-GCM auth tag

function bytesToBigInt(b: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(b));
}

/** SHA256 of the compressed shared point, reduced into the curve order. */
function pointToScalar(point: { toBytes: (compressed: boolean) => Uint8Array }): bigint {
  return bytesToBigInt(sha256(point.toBytes(true))) % CURVE_N;
}

// ── Enclave keypair ──────────────────────────────────────────────────────────

export interface EnclaveKeypair {
  privKey: Uint8Array;
  pubKeyHex: string;
}

/**
 * Generate the enclave's encryption keypair.
 *
 * Called once at startup and held only in memory — it is never written to disk
 * and never leaves the process. Restarting the extension rotates it, which is
 * intentional: a scan key sealed to an old instance cannot be opened by a new
 * one, so a compromised-then-restarted enclave cannot replay old payloads.
 */
export function generateEnclaveKeypair(): EnclaveKeypair {
  const privKey = secp256k1.utils.randomSecretKey();
  return { privKey, pubKeyHex: bytesToHex(secp256k1.getPublicKey(privKey, true)) };
}

// ── ECIES ────────────────────────────────────────────────────────────────────

/**
 * Seal a 32-byte scan key to the enclave's public key.
 *
 * Layout: ephPub(33) || iv(12) || tag(16) || ciphertext(32) = 93 bytes.
 * Client-side helper — the enclave itself only ever decrypts. Exported so the
 * frontend and the tests share one implementation rather than two that drift.
 */
export function sealToEnclave(scanPrivHex: string, enclavePubHex: string): string {
  const scanPriv = hexToBytes(scanPrivHex.replace(/^0x/i, ""));
  if (scanPriv.length !== 32) throw new Error("scan key must be 32 bytes");

  const ephPriv = secp256k1.utils.randomSecretKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);

  const shared = secp256k1.Point.fromHex(enclavePubHex).multiply(bytesToBigInt(ephPriv));
  const aesKey = sha256(shared.toBytes(true));

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(scanPriv), cipher.final()]);
  const tag = cipher.getAuthTag();

  return bytesToHex(Buffer.concat([ephPub, iv, tag, ciphertext]));
}

/**
 * Open a sealed scan key inside the enclave.
 *
 * Throws on any tampering — AES-GCM authentication means a payload altered in
 * transit or on-chain fails here rather than silently scanning with a wrong key.
 */
export function openSealed(sealedHex: string, enclavePriv: Uint8Array): string {
  const blob = hexToBytes(sealedHex.replace(/^0x/i, ""));
  const expected = EPH_PUB_LEN + IV_LEN + TAG_LEN + 32;
  if (blob.length !== expected) {
    throw new Error(`sealed payload must be ${expected} bytes, got ${blob.length}`);
  }

  const ephPub = blob.subarray(0, EPH_PUB_LEN);
  const iv = blob.subarray(EPH_PUB_LEN, EPH_PUB_LEN + IV_LEN);
  const tag = blob.subarray(EPH_PUB_LEN + IV_LEN, EPH_PUB_LEN + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(EPH_PUB_LEN + IV_LEN + TAG_LEN);

  const shared = secp256k1.Point.fromHex(bytesToHex(ephPub)).multiply(bytesToBigInt(enclavePriv));
  const aesKey = sha256(shared.toBytes(true));

  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  const scanPriv = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return bytesToHex(scanPriv);
}

// ── Scanning ─────────────────────────────────────────────────────────────────

export interface Announcement {
  id: number;
  derivedAddress: string; // compressed secp256k1 pubkey, hex
  ephemeralR: string; // compressed secp256k1 pubkey, hex
}

/**
 * Return the ids of announcements addressed to (scanPriv, spendPub).
 *
 * Only ids leave this function. The enclave never derives or returns a spending
 * key — that requires spendPriv, which by construction it does not hold.
 */
export function scanForMatches(
  scanPrivHex: string,
  spendPubHex: string,
  announcements: Announcement[],
): number[] {
  const scanPriv = BigInt("0x" + scanPrivHex.replace(/^0x/i, ""));
  const spendPub = secp256k1.Point.fromHex(spendPubHex.replace(/^0x/i, ""));

  const matches: number[] = [];
  for (const ann of announcements) {
    try {
      const R = secp256k1.Point.fromHex(ann.ephemeralR.replace(/^0x/i, ""));
      const S = R.multiply(scanPriv);
      const h = pointToScalar(S);
      const expected = spendPub.add(G.multiply(h));

      if (bytesToHex(expected.toBytes(true)) === ann.derivedAddress.replace(/^0x/i, "").toLowerCase()) {
        matches.push(ann.id);
      }
    } catch {
      // Malformed or unrelated entry — skip, exactly as the browser scanner does.
    }
  }
  return matches;
}
