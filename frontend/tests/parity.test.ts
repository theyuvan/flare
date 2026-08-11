// Cross-implementation parity check.
//
// The browser derives the derived account (lib/scan-browser.ts) and the backend
// derives it too (backend/crypto/derived.js). If those two ever disagree by so
// much as one bit, the sender pays an address the recipient cannot spend and the
// funds are stranded forever. This test pins them together.
//
// Run from frontend/:  node tests/parity.test.ts

import assert from 'node:assert'
import { createRequire } from 'node:module'
import { scanAnnouncements, sharedPointToEVMAccount, metaPubFromPriv } from '../lib/scan-browser.ts'
import { generateMetaAddress } from '../lib/keys-browser.ts'

const require = createRequire(import.meta.url)
const backendDerived = require('../../backend/crypto/derived.js')
const backendKeys = require('../../backend/crypto/keys.js')
const backendScan = require('../../backend/crypto/scan.js')

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}\n     ${(e as Error).message}`)
    failed++
  }
}

console.log('\nBrowser <-> backend parity\n')

test('browser metaPubFromPriv matches backend key generation', () => {
  const { metaPriv, metaAddress } = backendKeys.generateMetaAddress()
  assert.strictEqual(metaPubFromPriv(metaPriv), metaAddress)
})

test('browser keygen produces a pubkey the backend derivation accepts', () => {
  const { metaPriv, metaAddress } = generateMetaAddress()
  assert.strictEqual(metaPubFromPriv(metaPriv), metaAddress)
  const derived = backendDerived.deriveAddress(metaAddress)
  assert.ok(derived.evmAddress.startsWith('0x'))
})

// The critical one: sender derives on the backend, recipient scans in the browser.
test('backend-derived derived account == browser-scanned account', () => {
  for (let i = 0; i < 25; i++) {
    const { metaPriv, metaAddress } = backendKeys.generateMetaAddress()
    const { derivedPub, ephemeralR, evmAddress } = backendDerived.deriveAddress(metaAddress)

    const owned = scanAnnouncements(metaPriv, [
      { id: i, derivedAddress: derivedPub, ephemeralR, timestamp: 0 },
    ])

    assert.strictEqual(owned.length, 1, `run ${i}: browser scan did not match the announcement`)
    assert.strictEqual(
      owned[0].evmAddress,
      evmAddress,
      `run ${i}: browser and backend derived different addresses`,
    )
  }
})

test('browser and backend agree on the private key, not just the address', () => {
  const { metaPriv, metaAddress } = backendKeys.generateMetaAddress()
  const { derivedPub, ephemeralR } = backendDerived.deriveAddress(metaAddress)
  const ann = { id: 0, derivedAddress: derivedPub, ephemeralR, timestamp: 0 }

  const fromBackend = backendScan.scanAnnouncements(metaPriv, metaPubFromPriv(metaPriv), [ann])
  const fromBrowser = scanAnnouncements(metaPriv, [ann])

  assert.strictEqual(fromBackend.length, 1)
  assert.strictEqual(fromBrowser.length, 1)
  assert.strictEqual(fromBrowser[0].evmPrivKey, fromBackend[0].evmPrivKey)
  assert.strictEqual(fromBrowser[0].evmAddress, fromBackend[0].evmAddress)
  assert.strictEqual(fromBrowser[0].evmPrivKey.length, 66)
})

// A SHA256 digest can exceed the curve order; both sides must reduce mod n
// identically or ~1-in-2^128 of payments would silently break.
test('both implementations reduce the shared-point seed mod n the same way', () => {
  const { metaPriv, metaAddress } = backendKeys.generateMetaAddress()
  const { ephemeralR } = backendDerived.deriveAddress(metaAddress)
  const backendAcct = backendDerived.deriveEVMAccount(metaPriv, ephemeralR)

  const { secp256k1 } = require('../../backend/node_modules/@noble/curves/secp256k1.js')
  const S = secp256k1.Point.fromHex(ephemeralR).multiply(BigInt('0x' + metaPriv))
  const browserAcct = sharedPointToEVMAccount(S)

  assert.strictEqual(browserAcct.evmAddress, backendAcct.evmAddress)
  assert.strictEqual(browserAcct.evmPrivKey, backendAcct.evmPrivKey)
})

console.log(`\n${'─'.repeat(45)}\n  ${passed} passed  /  ${failed} failed\n`)
if (failed > 0) process.exit(1)
