/**
 * ★ MAIN CUSTOMIZATION POINT — FlarePay confidential scanning.
 *
 * The problem this solves: finding which payments are yours means trial-ECDH
 * against every announcement ever posted. In the browser that is private but
 * linear — at scale a phone grinds. Handing the key to a normal server would
 * make it fast and tell the operator exactly which payments you own, which is
 * the entire property FlarePay exists to protect.
 *
 * So the scan runs here instead. The scan key arrives sealed to a keypair that
 * only exists inside the enclave, the matching happens in enclave memory, and
 * only the matching announcement ids come back out. The operator sees ciphertext
 * in and ids out.
 *
 * What deliberately does NOT happen here: deriving a spending key. That needs
 * spendPriv, which never leaves the user's device. A total compromise of this
 * extension costs users their privacy for the delegated window — never funds.
 *
 * Each handler follows the scaffold's 4-step shape: decode, validate, execute,
 * respond. Handler contract: (originalMessageHex) => [dataHexOrNull, status,
 * errorOrNull], status 0 = error, 1 = success.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";

import { decodeScanRequest } from "./abi.js";
import {
  MAX_SCAN_BATCH,
  OP_COMMAND_GET_ENCLAVE_KEY,
  OP_COMMAND_SCAN,
  OP_TYPE_FLAREPAY,
} from "./config.js";
import { generateEnclaveKeypair, openSealed, scanForMatches, type EnclaveKeypair } from "./crypto.js";
import { fetchAnnouncements, getAnnouncementCount } from "./registry.js";

// --- Extension state ---------------------------------------------------------
// The framework serialises handler calls, so plain module state is safe.
//
// The keypair is generated on first use and held only in memory. Nothing here
// records a scan key, a match, or who asked — the counters below are
// deliberately aggregate-only, because per-user scan history kept inside the
// enclave would recreate the very linkability this is meant to remove.
let enclaveKeys: EnclaveKeypair | null = null;
let scansServed = 0;
let announcementsScanned = 0;

function keys(): EnclaveKeypair {
  if (!enclaveKeys) enclaveKeys = generateEnclaveKeypair();
  return enclaveKeys;
}

/** Reset all state. Used by tests; not part of the wire contract. */
export function resetState(): void {
  enclaveKeys = null;
  scansServed = 0;
  announcementsScanned = 0;
}

/** Wire handlers to (opType, opCommand) pairs. */
export function register(framework: Framework): void {
  framework.handle(OP_TYPE_FLAREPAY, OP_COMMAND_GET_ENCLAVE_KEY, handleGetEnclaveKey);
  framework.handle(OP_TYPE_FLAREPAY, OP_COMMAND_SCAN, handleScan);
}

/**
 * Snapshot returned by GET /state.
 *
 * Note what is absent: no keys, no matches, no requester identity. State is
 * public, so anything placed here is a leak.
 */
export function reportState(): unknown {
  return {
    enclavePubKey: keys().pubKeyHex,
    scansServed,
    announcementsScanned,
  };
}

function ok(payload: unknown): HandlerResult {
  return [bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")), 1, null];
}

/**
 * FLAREPAY/GET_ENCLAVE_KEY — publish the enclave's public encryption key.
 *
 * Clients seal their scan key to this before putting it on-chain. Publishing
 * the public half is safe; the private half never leaves enclave memory.
 *
 * In production the caller should bind this key to the attestation quote before
 * trusting it — otherwise a malicious operator could substitute their own key
 * and read scan keys. See README §Attestation.
 */
export function handleGetEnclaveKey(_msg: string): HandlerResult {
  return ok({ enclavePubKey: keys().pubKeyHex, algorithm: "ECIES-secp256k1-AES256GCM" });
}

/**
 * FLAREPAY/SCAN — the confidential computation.
 *
 * Payload is ABI-encoded (bytes sealedScanKey, bytes spendPub, uint256 fromId,
 * uint256 count). Returns the ids of announcements addressed to that key.
 */
export async function handleScan(msg: string): Promise<HandlerResult> {
  // 1. Decode
  let hex: string;
  try {
    hex = bytesToHex(hexToBytes(msg));
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let req;
  try {
    req = decodeScanRequest(hex as `0x${string}`);
  } catch (e) {
    return [null, 0, `decoding request: ${e instanceof Error ? e.message : String(e)}`];
  }

  // 2. Validate
  const spendPub = req.spendPub.replace(/^0x/i, "").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(spendPub)) {
    return [null, 0, "spendPub must be a 33-byte compressed secp256k1 public key"];
  }
  if (req.count === 0n) {
    return [null, 0, "count must be greater than zero"];
  }
  if (req.count > BigInt(MAX_SCAN_BATCH)) {
    return [null, 0, `count exceeds the ${MAX_SCAN_BATCH} announcement limit for a single scan`];
  }

  // 3. Execute — the only place a scan key exists in plaintext.
  let scanPriv: string;
  try {
    scanPriv = openSealed(req.sealedScanKey, keys().privKey);
  } catch (e) {
    // Includes the AES-GCM auth failure, so a tampered or wrongly-sealed
    // payload lands here rather than scanning against a garbage key.
    return [null, 0, `unsealing scan key: ${e instanceof Error ? e.message : String(e)}`];
  }

  try {
    const total = await getAnnouncementCount();
    const from = Number(req.fromId);
    if (from >= total) {
      return ok({ total, scanned: 0, matches: [] });
    }

    const announcements = await fetchAnnouncements(from, Number(req.count));
    const matches = scanForMatches(scanPriv, spendPub, announcements);

    scansServed++;
    announcementsScanned += announcements.length;

    // 4. Respond — ids only. Never the key, never a derived spending key.
    return ok({ total, scanned: announcements.length, matches });
  } catch (e) {
    return [null, 0, `scanning: ${e instanceof Error ? e.message : String(e)}`];
  } finally {
    // Best-effort hygiene. JS strings are immutable and GC-managed so this is
    // not a guarantee — it drops the last reference rather than wiping memory.
    scanPriv = "";
  }
}
