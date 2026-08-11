'use strict'
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { bytesToHex } = require('@noble/hashes/utils.js')
const { pointToScalar, deriveEVMAccount } = require('./derived')

const G = secp256k1.Point.BASE

// NOTE: this module is NOT reachable from any HTTP route — the backend never
// receives metaPriv. It is kept for tests and for local/CLI tooling; the
// browser runs the equivalent logic in frontend/lib/scan-browser.ts.
function scanAnnouncements(metaPrivHex, metaPubHex, announcements) {
  const km    = BigInt('0x' + metaPrivHex)
  const Kmeta = secp256k1.Point.fromHex(metaPubHex)

  const owned = []
  for (const ann of announcements) {
    try {
      const R = secp256k1.Point.fromHex(ann.ephemeralR)
      const S = R.multiply(km)
      const h = pointToScalar(S)
      // Expected derived pub = metaPub + h·G
      const expectedP = Kmeta.add(G.multiply(h))
      if (bytesToHex(expectedP.toBytes(true)) === ann.derivedAddress) {
        const { evmAddress, evmPrivKey } = deriveEVMAccount(metaPrivHex, ann.ephemeralR)
        owned.push({ ...ann, evmAddress, evmPrivKey })
      }
    } catch {
      // skip malformed or unrelated entries
    }
  }
  return owned
}

module.exports = { scanAnnouncements }
