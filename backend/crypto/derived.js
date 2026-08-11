'use strict'
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { sha256 } = require('@noble/hashes/sha2.js')
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js')
const { ethers } = require('ethers')

const G = secp256k1.Point.BASE
const CURVE_N = secp256k1.Point.Fn.ORDER

function bytesToBigInt(bytes) {
  return BigInt('0x' + bytesToHex(bytes))
}

function bigIntTo32Bytes(n) {
  return hexToBytes(n.toString(16).padStart(64, '0'))
}

function pointToScalar(point) {
  return bytesToBigInt(sha256(point.toBytes(true))) % CURVE_N
}

// Derive the EVM account that holds the funds from the ECDH shared point S.
// Both sides compute the same S, so both derive the same account — the sender
// knows the address to pay, the recipient knows the key to sweep it.
//
// seed = SHA256(S_compressed) → reduced mod n so it is always a valid
// secp256k1 scalar (a raw SHA256 digest can land outside [1, n-1]).
function sharedPointToEVMAccount(sharedPoint) {
  const seed = sha256(sharedPoint.toBytes(true))
  let scalar = bytesToBigInt(seed) % CURVE_N
  if (scalar === 0n) scalar = 1n // negligible probability; keeps the key valid
  const evmPrivKey = '0x' + scalar.toString(16).padStart(64, '0')
  const wallet = new ethers.Wallet(evmPrivKey)
  return { evmAddress: wallet.address, evmPrivKey }
}

// ── Sender ────────────────────────────────────────────────────────────────────
// metaAddress = single secp256k1 public key
// r  = random scalar, R = r·G
// S  = r·metaPub  (ECDH)
// h  = SHA256(S_compressed) mod n
// P  = metaPub + h·G  (secp256k1 derived pub — used for ZK proof)
// evmAddress derived from SHA256(S_compressed)
function deriveAddress(metaPubHex) {
  const rBytes = secp256k1.utils.randomSecretKey()
  const r = bytesToBigInt(rBytes)

  const R     = G.multiply(r)
  const Kmeta = secp256k1.Point.fromHex(metaPubHex)
  const S     = Kmeta.multiply(r)
  const h     = pointToScalar(S)
  const P     = Kmeta.add(G.multiply(h))

  // Only the address — the sender never needs (and is never handed) the key.
  const { evmAddress } = sharedPointToEVMAccount(S)

  return {
    derivedPub: bytesToHex(P.toBytes(true)),
    ephemeralR: bytesToHex(R.toBytes(true)),
    evmAddress,
  }
}

// ── Recipient: derive secp256k1 spend key for ZK proof ────────────────────────
// p = (metaPriv + h) mod n
function deriveSpendKey(metaPrivHex, ephemeralRHex) {
  const km = BigInt('0x' + metaPrivHex)
  const R  = secp256k1.Point.fromHex(ephemeralRHex)
  const S  = R.multiply(km)
  const h  = pointToScalar(S)
  const derivedPriv = (km + h) % CURVE_N
  return bytesToHex(bigIntTo32Bytes(derivedPriv))
}

// ── Recipient: derive the EVM account controlling the derived funds ───────────
// S = metaPriv·R  (same shared point the sender computed)
function deriveEVMAccount(metaPrivHex, ephemeralRHex) {
  const km = BigInt('0x' + metaPrivHex)
  const R  = secp256k1.Point.fromHex(ephemeralRHex)
  const S  = R.multiply(km)
  return sharedPointToEVMAccount(S)
}

module.exports = {
  deriveAddress,
  deriveSpendKey,
  deriveEVMAccount,
  sharedPointToEVMAccount,
  pointToScalar,
  CURVE_N,
}
