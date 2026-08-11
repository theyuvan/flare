'use strict'
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { bytesToHex } = require('@noble/hashes/utils.js')

function generateMetaAddress() {
  const metaPrivBytes = secp256k1.utils.randomSecretKey()
  const metaPubBytes  = secp256k1.getPublicKey(metaPrivBytes, true)
  const metaPriv = bytesToHex(metaPrivBytes)
  const metaPub  = bytesToHex(metaPubBytes)
  return {
    metaPriv,
    metaPub,
    metaAddress: metaPub, // one key — share metaAddress to receive payments
  }
}

module.exports = { generateMetaAddress }
