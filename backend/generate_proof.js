'use strict'
const path = require('path')
const snarkjs = require('snarkjs')
const { buildPoseidon } = require('circomlibjs')

const WASM_PATH = path.join(__dirname, '../circuits/build/derived_ownership_js/derived_ownership.wasm')
const ZKEY_PATH = path.join(__dirname, '../circuits/build/derived_ownership_0001.zkey')
const VKEY_PATH = path.join(__dirname, '../circuits/build/verification_key.json')

const BN254_R = BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709142e0f853d26f5f35')

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

module.exports = { computeProof, privKeyToField }
