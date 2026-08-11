'use client'

// Derived-payment scanning. Runs entirely in the browser — metaPriv is never
// sent anywhere. Mirrors backend/crypto/derived.js exactly; if the two ever
// disagree, sender and recipient derive different accounts and funds strand.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { Wallet } from 'ethers'

const G = secp256k1.Point.BASE
const CURVE_N = secp256k1.Point.Fn.ORDER

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes))
}

function pointToScalar(point: { toBytes: (compressed: boolean) => Uint8Array }): bigint {
  return bytesToBigInt(sha256(point.toBytes(true))) % CURVE_N
}

/**
 * Derive the EVM account holding the funds from the ECDH shared point S.
 * The seed is reduced mod n — a raw SHA256 digest can fall outside [1, n-1],
 * and the backend does the same reduction.
 */
export function sharedPointToEVMAccount(sharedPoint: { toBytes: (c: boolean) => Uint8Array }) {
  const seed = sha256(sharedPoint.toBytes(true))
  let scalar = bytesToBigInt(seed) % CURVE_N
  if (scalar === 0n) scalar = 1n
  const evmPrivKey = '0x' + scalar.toString(16).padStart(64, '0')
  return { evmAddress: new Wallet(evmPrivKey).address, evmPrivKey }
}

export type Announcement = {
  id: number
  derivedAddress: string
  ephemeralR: string
  timestamp: number
  sender?: string
  evmAddress?: string | null
  balance?: string | null
  metadata?: { txHash?: string } | null
}

export type OwnedPayment = Announcement & {
  evmAddress: string
  evmPrivKey: string
  balance?: string | null
}

/** metaPriv (32-byte hex, no 0x) -> compressed pubkey hex. */
export function metaPubFromPriv(metaPrivHex: string): string {
  const clean = metaPrivHex.replace(/^0x/i, '')
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(clean), true))
}

/**
 * For each announcement compute S' = metaPriv·R and check whether
 * metaPub + SHA256(S')·G reproduces the published derived pubkey.
 * A match means the payment is ours, and S' yields the spending key.
 */
export function scanAnnouncements(
  metaPrivHex: string,
  announcements: Announcement[],
): OwnedPayment[] {
  const clean = metaPrivHex.replace(/^0x/i, '')
  const km = BigInt('0x' + clean)
  const Kmeta = secp256k1.Point.fromHex(metaPubFromPriv(clean))

  const owned: OwnedPayment[] = []
  for (const ann of announcements) {
    try {
      const R = secp256k1.Point.fromHex(ann.ephemeralR)
      const S = R.multiply(km)
      const h = pointToScalar(S)
      const expectedP = Kmeta.add(G.multiply(h))

      if (bytesToHex(expectedP.toBytes(true)) === ann.derivedAddress) {
        const { evmAddress, evmPrivKey } = sharedPointToEVMAccount(S)
        owned.push({ ...ann, evmAddress, evmPrivKey })
      }
    } catch {
      // skip malformed or unrelated entries
    }
  }
  return owned
}
