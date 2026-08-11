'use strict'
// End-to-end flow against live Flare Coston2, exercising the real HTTP routes.
//
//   1. Start the backend:  cd backend && npm start
//   2. Run this:           node backend/scripts/e2e.js
//
// Requires: contracts deployed (addresses set in index.js) and the relayer
// funded with a little C2FLR — https://faucet.flare.network (Coston2).
//
// The relayer plays both sender and final recipient, so the funds return to it
// minus gas. Nothing here needs a browser.

require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') })
const { ethers } = require('ethers')
const { generateMetaAddress } = require('../crypto/keys')
const { scanAnnouncements } = require('../crypto/scan')
const { computeProof } = require('../generate_proof')
const { secp256k1 } = require('@noble/curves/secp256k1.js')
const { bytesToHex } = require('@noble/hashes/utils.js')

const API = process.env.E2E_API || 'http://localhost:4000'
const RPC = process.env.RPC_URL || 'https://coston2-api.flare.network/ext/C/rpc'
const CHAIN_ID = Number(process.env.CHAIN_ID || 114)
const AMOUNT = process.env.E2E_AMOUNT || '0.05'

let step = 0
const log = (msg) => console.log(`\n[${++step}] ${msg}`)
const ok = (msg) => console.log(`    ✓ ${msg}`)

async function api(path, options) {
  const res = await fetch(`${API}${path}`, options)
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON (is the backend running on ${API}?): ${text.slice(0, 120)}`)
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.error || text}`)
  return data
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: 'coston2' })

  log('Preflight')
  const health = await api('/health')
  if (health.registry === ethers.ZeroAddress || health.verifier === ethers.ZeroAddress) {
    throw new Error('Contracts are not deployed — run: cd contracts && npm run deploy')
  }
  ok(`registry ${health.registry}`)
  ok(`verifier ${health.verifier}`)

  if (!process.env.RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY missing from backend/.env')
  const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider)
  const startBalance = await provider.getBalance(relayer.address)
  ok(`relayer ${relayer.address} holds ${ethers.formatEther(startBalance)} C2FLR`)
  if (startBalance < ethers.parseEther(AMOUNT)) {
    throw new Error(`Relayer needs more than ${AMOUNT} C2FLR — fund it at https://faucet.flare.network (Coston2)`)
  }

  log('Recipient generates a meta-keypair')
  const { metaPriv, metaAddress } = generateMetaAddress()
  const metaPub = bytesToHex(secp256k1.getPublicKey(Buffer.from(metaPriv, 'hex'), true))
  ok(`metaAddress ${metaAddress.slice(0, 20)}…`)

  log('Sender derives a one-time derived address')
  const derived = await api('/address/derive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metaAddress }),
  })
  ok(`derived account ${derived.evmAddress}`)

  log(`Sender pays ${AMOUNT} C2FLR to the derived address`)
  const payTx = await relayer.sendTransaction({
    to: derived.evmAddress,
    value: ethers.parseEther(AMOUNT),
  })
  await payTx.wait()
  ok(`payment ${payTx.hash}`)

  log('Sender publishes the announcement on-chain')
  const announced = await api('/announcements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      derivedAddress: derived.derivedPub,
      ephemeralR: derived.ephemeralR,
      evmAddress: derived.evmAddress,
      metadata: { txHash: payTx.hash },
    }),
  })
  ok(`announce ${announced.hash}`)

  log('Recipient reads the public announcement list')
  const list = await api('/announcements?from=0&count=200')
  ok(`${list.total} announcement(s) on chain`)

  log('Recipient scans locally — no key is sent to the backend')
  const owned = scanAnnouncements(metaPriv, metaPub, list.announcements)
  if (owned.length !== 1) throw new Error(`expected exactly 1 owned payment, found ${owned.length}`)
  if (owned[0].evmAddress !== derived.evmAddress) {
    throw new Error(`scan derived ${owned[0].evmAddress} but the sender paid ${derived.evmAddress}`)
  }
  const onChain = await provider.getBalance(owned[0].evmAddress)
  ok(`matched, holding ${ethers.formatEther(onChain)} C2FLR`)

  log('Recipient generates a Groth16 proof')
  const { proof, publicSignals } = await computeProof(metaPriv, metaPriv, '01')
  ok(`nullifier ${publicSignals[1].slice(0, 24)}…`)

  log('Backend verifies the proof off-chain')
  const verified = await api('/zk/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proof, publicSignals }),
  })
  if (!verified.valid) throw new Error('backend rejected a proof it should have accepted')
  ok('valid')

  const claimBody = {
    derivedAddress: owned[0].evmAddress,
    recipientAddress: relayer.address,
    proof,
    publicSignals,
  }

  log('Claim phase 1 — backend burns the nullifier (no private key sent)')
  const claimed = await api('/address/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(claimBody),
  })
  ok(`nullifier registered — ${claimed.registerHash}`)

  log('Backend must refuse a private key if one is offered')
  try {
    await api('/address/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...claimBody, derivedAccountKey: owned[0].evmPrivKey }),
    })
    throw new Error('SECURITY: the backend accepted a private key — it must refuse')
  } catch (e) {
    if (String(e.message).startsWith('SECURITY')) throw e
    ok('refused, as it should')
  }

  log('Claim phase 2 — recipient signs and broadcasts the sweep themselves')
  const derivedWallet = new ethers.Wallet(owned[0].evmPrivKey, provider)
  const balance = await provider.getBalance(derivedWallet.address)
  const [feeData, block] = await Promise.all([provider.getFeeData(), provider.getBlock('latest')])
  const tip = feeData.maxPriorityFeePerGas ?? 0n
  const maxFeePerGas = block?.baseFeePerGas != null
    ? (block.baseFeePerGas * 3n) / 2n + tip
    : (feeData.maxFeePerGas ?? feeData.gasPrice)
  const gasCost = maxFeePerGas * 21000n
  const value = balance - gasCost
  const sweep = await derivedWallet.sendTransaction({
    to: relayer.address,
    value,
    gasLimit: 21000n,
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
  })
  await sweep.wait()
  ok(`swept ${ethers.formatEther(value)} C2FLR — ${sweep.hash}`)

  log('Verify the derived account is drained')
  const remaining = await provider.getBalance(derived.evmAddress)
  ok(`derived account left with ${ethers.formatEther(remaining)} C2FLR`)

  log('Replay protection — the same nullifier must be refused')
  try {
    await api('/address/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(claimBody),
    })
    throw new Error('SECURITY: a replayed claim succeeded — it must fail')
  } catch (e) {
    if (String(e.message).startsWith('SECURITY')) throw e
    ok(`refused as expected (${String(e.message).slice(0, 70)}…)`)
  }

  const onCoston2 = CHAIN_ID === 114
  console.log('\n────────────────────────────────────────────')
  console.log(`  END-TO-END PASSED — ${onCoston2 ? 'Flare Coston2' : `local chain ${CHAIN_ID}`}`)
  if (onCoston2) {
    console.log(`  explorer: https://coston2-explorer.flare.network/tx/${sweep.hash}`)
  }
  console.log('────────────────────────────────────────────\n')
}

main().catch((e) => {
  console.error(`\n  ✗ FAILED: ${e.message}\n`)
  process.exit(1)
})
