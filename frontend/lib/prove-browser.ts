'use client'

// Groth16 proving in the browser via snarkjs WASM. metaPriv is read into the
// circuit witness here and never crosses the network.

const BN254_R = BigInt('0x30644e72e131a029b85045b68181585d2833e84879b9709142e0f853d26f5f35')

function privKeyToField(hexKey: string): bigint {
  const clean = hexKey.replace(/^0x/i, '')
  return BigInt('0x' + (clean || '0')) % BN254_R
}

export type ProveResult = {
  proof: object
  publicSignals: string[]
  metaCommitment: string
  nullifier: string
}

export async function generateProof(metaPrivHex: string, contextHex = '01'): Promise<ProveResult> {
  const scanPriv = privKeyToField(metaPrivHex)
  const spendPriv = privKeyToField(metaPrivHex) // single-key design
  const context = privKeyToField(contextHex)

  // Dynamic imports — these must never load during SSR.
  const snarkjs = await import('snarkjs')
  const { buildPoseidon } = await import('circomlibjs')

  const poseidon = await buildPoseidon()
  const F = poseidon.F

  const metaCommitment = F.toObject(poseidon([scanPriv, spendPriv])) as bigint
  const nullifier = F.toObject(poseidon([scanPriv, context])) as bigint

  const input = {
    scanPriv: scanPriv.toString(),
    spendPriv: spendPriv.toString(),
    metaCommitment: metaCommitment.toString(),
    nullifier: nullifier.toString(),
    context: context.toString(),
  }

  const [wasmRes, zkeyRes] = await Promise.all([
    fetch('/circuits/derived_ownership.wasm'),
    fetch('/circuits/derived_ownership_0001.zkey'),
  ])
  if (!wasmRes.ok || !zkeyRes.ok) {
    throw new Error('Circuit artifacts missing from /public/circuits/ — see README step 4')
  }

  const [wasmBuffer, zkeyBuffer] = await Promise.all([wasmRes.arrayBuffer(), zkeyRes.arrayBuffer()])

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    new Uint8Array(wasmBuffer),
    new Uint8Array(zkeyBuffer),
  )

  return {
    proof,
    publicSignals,
    metaCommitment: metaCommitment.toString(),
    nullifier: nullifier.toString(),
  }
}

/** Verify locally against the published verification key before submitting. */
export async function verifyProof(proof: object, publicSignals: string[]): Promise<boolean> {
  const snarkjs = await import('snarkjs')
  const vkey = await (await fetch('/circuits/verification_key.json')).json()
  return snarkjs.groth16.verify(vkey, publicSignals, proof)
}
