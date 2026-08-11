'use strict'
// Pure-Node tests — no framework. Run with: node backend/tests/derived.test.js
const assert = require('assert')
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { bytesToHex } = require('@noble/hashes/utils.js')
const { ethers } = require('ethers')

const { generateMetaAddress } = require('../crypto/keys')
const { deriveAddress, deriveSpendKey, deriveEVMAccount, CURVE_N } = require('../crypto/derived')
const { scanAnnouncements } = require('../crypto/scan')

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.error(`  ✗  ${name}\n     ${e.message}`); failed++ }
}

const HEX64 = /^[0-9a-f]{64}$/
const metaPubOf = metaPriv => bytesToHex(secp256k1.getPublicKey(Buffer.from(metaPriv, 'hex'), true))

console.log('\nKey generation\n')

test('generateMetaAddress returns a valid 32-byte hex private key', () => {
  const { metaPriv } = generateMetaAddress()
  assert.ok(HEX64.test(metaPriv), `metaPriv is not 64 lowercase hex chars: ${metaPriv}`)
  const scalar = BigInt('0x' + metaPriv)
  assert.ok(scalar > 0n && scalar < CURVE_N, 'metaPriv is not in [1, n-1]')
})

test('generateMetaAddress: metaAddress equals metaPub (single-key design)', () => {
  const { metaAddress, metaPub } = generateMetaAddress()
  assert.strictEqual(metaAddress, metaPub)
})

test('generateMetaAddress: metaAddress is a compressed secp256k1 pubkey (66 chars)', () => {
  const { metaAddress, metaPriv } = generateMetaAddress()
  assert.strictEqual(metaAddress.length, 66)
  assert.ok(metaAddress.startsWith('02') || metaAddress.startsWith('03'))
  assert.strictEqual(metaAddress, metaPubOf(metaPriv), 'metaAddress does not match metaPriv')
})

test('generateMetaAddress is random each call', () => {
  const a = generateMetaAddress(), b = generateMetaAddress()
  assert.notStrictEqual(a.metaPriv, b.metaPriv)
  assert.notStrictEqual(a.metaAddress, b.metaAddress)
})

console.log('\nDerived address derivation\n')

test('deriveAddress returns derivedPub, ephemeralR, evmAddress', () => {
  const { metaAddress } = generateMetaAddress()
  const out = deriveAddress(metaAddress)
  assert.strictEqual(out.derivedPub.length, 66, 'derivedPub is not a compressed pubkey')
  assert.strictEqual(out.ephemeralR.length, 66, 'ephemeralR is not a compressed pubkey')
  assert.ok(ethers.isAddress(out.evmAddress), `evmAddress is not a valid EVM address: ${out.evmAddress}`)
  assert.strictEqual(out.evmAddress, ethers.getAddress(out.evmAddress), 'evmAddress is not EIP-55 checksummed')
})

test('deriveAddress never leaks the derived private key to the sender', () => {
  const { metaAddress } = generateMetaAddress()
  const out = deriveAddress(metaAddress)
  assert.ok(!('evmPrivKey' in out), 'sender-side derivation must not return evmPrivKey')
})

test('sender and recipient derive the SAME EVM derived account (ECDH is symmetric)', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  const { evmAddress: senderAddr, ephemeralR } = deriveAddress(metaAddress)
  const { evmAddress: recipientAddr, evmPrivKey } = deriveEVMAccount(metaPriv, ephemeralR)
  assert.strictEqual(senderAddr, recipientAddr)
  // The recipient's key must actually control that address.
  assert.strictEqual(new ethers.Wallet(evmPrivKey).address, senderAddr)
})

test('a wrong metaPriv derives a different EVM account', () => {
  const { metaAddress } = generateMetaAddress()
  const { metaPriv: wrong } = generateMetaAddress()
  const { evmAddress: senderAddr, ephemeralR } = deriveAddress(metaAddress)
  const { evmAddress: wrongAddr } = deriveEVMAccount(wrong, ephemeralR)
  assert.notStrictEqual(senderAddr, wrongAddr)
})

test('different sends produce different derived addresses and ephemeralR values', () => {
  const { metaAddress } = generateMetaAddress()
  const a = deriveAddress(metaAddress)
  const b = deriveAddress(metaAddress)
  assert.notStrictEqual(a.derivedPub, b.derivedPub)
  assert.notStrictEqual(a.ephemeralR, b.ephemeralR)
  assert.notStrictEqual(a.evmAddress, b.evmAddress)
})

test('deriveSpendKey returns a valid 64-char hex scalar', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  const { ephemeralR } = deriveAddress(metaAddress)
  const spendKey = deriveSpendKey(metaPriv, ephemeralR)
  assert.ok(HEX64.test(spendKey), `spendKey is not 64 lowercase hex chars: ${spendKey}`)
  const scalar = BigInt('0x' + spendKey)
  assert.ok(scalar > 0n && scalar < CURVE_N, 'spendKey is not in [1, n-1]')
})

test('deriveSpendKey is the discrete log of derivedPub', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  const { derivedPub, ephemeralR } = deriveAddress(metaAddress)
  const spendKey = deriveSpendKey(metaPriv, ephemeralR)
  assert.strictEqual(metaPubOf(spendKey), derivedPub, 'spendKey·G != derivedPub')
})

console.log('\nAnnouncement scanning\n')

test('scanAnnouncements finds the correct owned announcement', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  const metaPub = metaPubOf(metaPriv)
  const { derivedPub, ephemeralR } = deriveAddress(metaAddress)
  const other = deriveAddress(generateMetaAddress().metaAddress)

  const owned = scanAnnouncements(metaPriv, metaPub, [
    { id: 0, derivedAddress: other.derivedPub, ephemeralR: other.ephemeralR, timestamp: 0 },
    { id: 1, derivedAddress: derivedPub, ephemeralR, timestamp: Date.now() },
  ])

  assert.strictEqual(owned.length, 1)
  assert.strictEqual(owned[0].id, 1)
  assert.ok(ethers.isAddress(owned[0].evmAddress))
  assert.strictEqual(new ethers.Wallet(owned[0].evmPrivKey).address, owned[0].evmAddress)
})

test('scanAnnouncements returns empty for the wrong private key', () => {
  const { metaAddress } = generateMetaAddress()
  const { metaPriv: wrong } = generateMetaAddress()
  const { derivedPub, ephemeralR } = deriveAddress(metaAddress)
  const owned = scanAnnouncements(wrong, metaPubOf(wrong), [
    { id: 1, derivedAddress: derivedPub, ephemeralR, timestamp: 0 },
  ])
  assert.strictEqual(owned.length, 0)
})

test('scanAnnouncements silently skips malformed entries', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  const metaPub = metaPubOf(metaPriv)
  const { derivedPub, ephemeralR } = deriveAddress(metaAddress)

  const owned = scanAnnouncements(metaPriv, metaPub, [
    { id: 0, derivedAddress: 'not-hex', ephemeralR: 'not-hex', timestamp: 0 },
    { id: 1, derivedAddress: derivedPub, ephemeralR: 'ff'.repeat(33), timestamp: 0 }, // R not on curve
    { id: 2, derivedAddress: null, ephemeralR: undefined, timestamp: 0 },
    { id: 3, derivedAddress: derivedPub, ephemeralR, timestamp: 0 },                  // the real one
  ])

  assert.strictEqual(owned.length, 1)
  assert.strictEqual(owned[0].id, 3)
})

test('scanAnnouncements on an empty list returns an empty array', () => {
  const { metaPriv } = generateMetaAddress()
  const owned = scanAnnouncements(metaPriv, metaPubOf(metaPriv), [])
  assert.deepStrictEqual(owned, [])
})

console.log(`\n${'─'.repeat(45)}\n  ${passed} passed  /  ${failed} failed\n`)
if (failed > 0) process.exit(1)
