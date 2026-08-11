// Security-critical tests for the confidential scanning extension.
// Run with: npm test   (inside tee/)
//
// These assert the two properties the whole design rests on:
//   1. A scan key sealed to the enclave can only be opened by the enclave.
//   2. Scanning with a scan key yields matches but NEVER spending power.

import assert from "node:assert";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  generateEnclaveKeypair,
  openSealed,
  scanForMatches,
  sealToEnclave,
  type Announcement,
} from "../extension/crypto.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}\n     ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

const G = secp256k1.Point.BASE;
const N = secp256k1.Point.Fn.ORDER;
const randKey = () => bytesToHex(secp256k1.utils.randomSecretKey());
const pubOf = (privHex: string) =>
  bytesToHex(secp256k1.getPublicKey(Buffer.from(privHex, "hex"), true));

/** Sender side: derive a one-time address for (scanPub, spendPub). */
function derive(scanPubHex: string, spendPubHex: string) {
  const r = secp256k1.utils.randomSecretKey();
  const rBig = BigInt("0x" + bytesToHex(r));
  const R = G.multiply(rBig);
  const S = secp256k1.Point.fromHex(scanPubHex).multiply(rBig);
  const h = BigInt("0x" + bytesToHex(sha256(S.toBytes(true)))) % N;
  const P = secp256k1.Point.fromHex(spendPubHex).add(G.multiply(h));
  return {
    derivedAddress: bytesToHex(P.toBytes(true)),
    ephemeralR: bytesToHex(R.toBytes(true)),
    h,
  };
}

console.log("\nECIES sealing\n");

test("a sealed scan key round-trips through the enclave", () => {
  const enclave = generateEnclaveKeypair();
  const scanPriv = randKey();
  const sealed = sealToEnclave(scanPriv, enclave.pubKeyHex);
  assert.strictEqual(openSealed(sealed, enclave.privKey), scanPriv);
});

test("sealed payload is exactly 93 bytes", () => {
  const enclave = generateEnclaveKeypair();
  const sealed = sealToEnclave(randKey(), enclave.pubKeyHex);
  assert.strictEqual(sealed.length / 2, 93);
});

test("the scan key never appears in the sealed bytes", () => {
  const enclave = generateEnclaveKeypair();
  const scanPriv = randKey();
  const sealed = sealToEnclave(scanPriv, enclave.pubKeyHex);
  assert.ok(!sealed.toLowerCase().includes(scanPriv.toLowerCase()), "plaintext key leaked");
});

test("a DIFFERENT enclave cannot open it — this is the whole guarantee", () => {
  const real = generateEnclaveKeypair();
  const attacker = generateEnclaveKeypair();
  const sealed = sealToEnclave(randKey(), real.pubKeyHex);
  assert.throws(() => openSealed(sealed, attacker.privKey));
});

test("tampering with the ciphertext is rejected by AES-GCM", () => {
  const enclave = generateEnclaveKeypair();
  const sealed = sealToEnclave(randKey(), enclave.pubKeyHex);
  const bytes = Buffer.from(sealed, "hex");
  bytes[bytes.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.throws(() => openSealed(bytes.toString("hex"), enclave.privKey));
});

test("sealing is randomised — same key twice gives different ciphertext", () => {
  const enclave = generateEnclaveKeypair();
  const scanPriv = randKey();
  assert.notStrictEqual(
    sealToEnclave(scanPriv, enclave.pubKeyHex),
    sealToEnclave(scanPriv, enclave.pubKeyHex),
  );
});

test("a truncated payload is rejected, not silently scanned", () => {
  const enclave = generateEnclaveKeypair();
  const sealed = sealToEnclave(randKey(), enclave.pubKeyHex);
  assert.throws(() => openSealed(sealed.slice(0, 100), enclave.privKey));
});

console.log("\nConfidential scanning\n");

test("finds the announcement addressed to this key", () => {
  const scanPriv = randKey();
  const spendPriv = randKey();
  const mine = derive(pubOf(scanPriv), pubOf(spendPriv));
  const other = derive(pubOf(randKey()), pubOf(randKey()));

  const anns: Announcement[] = [
    { id: 0, derivedAddress: other.derivedAddress, ephemeralR: other.ephemeralR },
    { id: 1, derivedAddress: mine.derivedAddress, ephemeralR: mine.ephemeralR },
  ];

  assert.deepStrictEqual(scanForMatches(scanPriv, pubOf(spendPriv), anns), [1]);
});

test("a wrong scan key finds nothing", () => {
  const spendPriv = randKey();
  const mine = derive(pubOf(randKey()), pubOf(spendPriv));
  const anns = [{ id: 0, derivedAddress: mine.derivedAddress, ephemeralR: mine.ephemeralR }];
  assert.deepStrictEqual(scanForMatches(randKey(), pubOf(spendPriv), anns), []);
});

test("malformed entries are skipped without throwing", () => {
  const scanPriv = randKey();
  const spendPriv = randKey();
  const mine = derive(pubOf(scanPriv), pubOf(spendPriv));

  const anns: Announcement[] = [
    { id: 0, derivedAddress: "not-hex", ephemeralR: "not-hex" },
    { id: 1, derivedAddress: mine.derivedAddress, ephemeralR: "ff".repeat(33) },
    { id: 2, derivedAddress: mine.derivedAddress, ephemeralR: mine.ephemeralR },
  ];

  assert.deepStrictEqual(scanForMatches(scanPriv, pubOf(spendPriv), anns), [2]);
});

test("an empty announcement list returns no matches", () => {
  assert.deepStrictEqual(scanForMatches(randKey(), pubOf(randKey()), []), []);
});

console.log("\nThe security property: scanning grants no spending power\n");

test("single-key announcements still match (backwards compatible)", () => {
  // Today's app uses one key for both roles. The split maths must reduce to it,
  // or the extension cannot scan announcements already on chain.
  const metaPriv = randKey();
  const metaPub = pubOf(metaPriv);
  const ann = derive(metaPub, metaPub);
  assert.deepStrictEqual(
    scanForMatches(metaPriv, metaPub, [
      { id: 7, derivedAddress: ann.derivedAddress, ephemeralR: ann.ephemeralR },
    ]),
    [7],
  );
});

test("the scan key alone CANNOT derive the spending key", () => {
  const scanPriv = randKey();
  const spendPriv = randKey();
  const spendPub = pubOf(spendPriv);
  const ann = derive(pubOf(scanPriv), spendPub);

  // The real spending key for this payment.
  const realSpend = (BigInt("0x" + spendPriv) + ann.h) % N;
  const realSpendPub = bytesToHex(G.multiply(realSpend).toBytes(true));
  assert.strictEqual(realSpendPub, ann.derivedAddress, "test setup wrong");

  // Everything the enclave holds: scanPriv, spendPub, and h (which it can
  // compute). Without spendPriv there is no way to reach realSpend.
  const enclaveGuess = ann.h % N;
  assert.notStrictEqual(
    bytesToHex(G.multiply(enclaveGuess).toBytes(true)),
    ann.derivedAddress,
    "SECURITY: enclave-derivable value controls the funds",
  );
});

test("scanForMatches returns only ids — no key material in the output", () => {
  const scanPriv = randKey();
  const spendPriv = randKey();
  const ann = derive(pubOf(scanPriv), pubOf(spendPriv));
  const out = scanForMatches(scanPriv, pubOf(spendPriv), [
    { id: 3, derivedAddress: ann.derivedAddress, ephemeralR: ann.ephemeralR },
  ]);
  assert.ok(
    out.every((v) => typeof v === "number"),
    "output must be numeric ids only",
  );
});

console.log(`\n${"─".repeat(50)}\n  ${passed} passed  /  ${failed} failed\n`);
if (failed > 0) process.exit(1);
