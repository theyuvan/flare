'use strict'
/**
 * Generate a Groth16 ZK proof for derived address ownership.
 *
 * Usage:
 *   node scripts/generate_proof.js <scanPrivHex> <spendPrivHex> <contextHex>
 *
 * Or import computeProof() and use programmatically from the backend.
 */
const path = require('path')
const snarkjs = require('snarkjs')
const { buildPoseidon } = require('circomlibjs')

const WASM_PATH = path.join(__dirname, '../build/derived_ownership_js/derived_ownership.wasm')
const ZKEY_PATH = path.join(__dirname, '../build/derived_ownership_0001.zkey')
const VKEY_PATH = path.join(__dirname, '../build/verification_key.json')

// secp256k1 and BN254 scalar field orders
const BN254_R = BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709142e0f853d26f5f35')

// Convert a hex private key to a BN254-safe field element.
// Reduces mod BN254_R so it fits in the circuit's Field type.
function privKeyToField(hexKey) {
  const clean = hexKey.replace(/^0x/i, '')
  return BigInt('0x' + (clean || '0')) % BN254_R
}

async function computeProof(scanPrivHex, spendPrivHex, contextHex = '0x01') {
  const poseidon = await buildPoseidon()
  const F = poseidon.F

  const scanPriv = privKeyToField(scanPrivHex)
  const spendPriv = privKeyToField(spendPrivHex)
  const context  = privKeyToField(contextHex)

  // Compute public values that will be posted on-chain
  const metaRaw  = poseidon([scanPriv, spendPriv])
  const nullRaw  = poseidon([scanPriv, context])

  const metaCommitment = F.toObject(metaRaw)
  const nullifier      = F.toObject(nullRaw)

  const input = {
    scanPriv:       scanPriv.toString(),
    spendPriv:      spendPriv.toString(),
    metaCommitment: metaCommitment.toString(),
    nullifier:      nullifier.toString(),
    context:        context.toString()
  }

  console.log('Generating Groth16 proof...')
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH)

  console.log('Verifying proof locally...')
  const vKey  = require(VKEY_PATH)
  const valid = await snarkjs.groth16.verify(vKey, publicSignals, proof)
  console.log('Proof valid:', valid)

  return {
    proof,
    publicSignals,
    metaCommitment: metaCommitment.toString(),
    nullifier: nullifier.toString(),
    valid
  }
}

// Only runs when invoked directly: node generate_proof.js <scanPriv> <spendPriv> [context]
if (require.main === module) {
  const [,, scanPrivHex, spendPrivHex, contextHex] = process.argv
  if (!scanPrivHex || !spendPrivHex) {
    console.error('Usage: node generate_proof.js <scanPrivHex> <spendPrivHex> [contextHex]')
    process.exit(1)
  }
  computeProof(scanPrivHex, spendPrivHex, contextHex || '01').then(result => {
    console.log('\n── Proof ─────────────────────────────────────')
    console.log(JSON.stringify(result.proof, null, 2))
    console.log('\n── Public signals ────────────────────────────')
    console.log(result.publicSignals)
    console.log('\n── Summary ───────────────────────────────────')
    console.log('metaCommitment:', result.metaCommitment.toString())
    console.log('nullifier:     ', result.nullifier.toString())
    console.log('Valid:         ', result.valid)
  }).catch(console.error)
}

module.exports = { computeProof, privKeyToField }
