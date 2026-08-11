'use client'

// Meta-keypair generation in the browser. The backend exposes POST
// /keys/generate too, but generating here means metaPriv is never transmitted
// at any point in its life.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export type MetaKeys = {
  metaPriv: string
  metaPub: string
  metaAddress: string
}

export function generateMetaAddress(): MetaKeys {
  const metaPrivBytes = secp256k1.utils.randomSecretKey()
  const metaPub = bytesToHex(secp256k1.getPublicKey(metaPrivBytes, true))
  return {
    metaPriv: bytesToHex(metaPrivBytes),
    metaPub,
    metaAddress: metaPub, // one key — share metaAddress to receive payments
  }
}

/** Loose shape check so bad input fails before any crypto runs. */
export function isValidMetaPriv(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim())
}

export function isValidMetaAddress(value: string): boolean {
  return /^0[23][0-9a-fA-F]{64}$/.test(value.trim())
}
