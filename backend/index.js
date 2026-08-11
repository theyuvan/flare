'use strict'
require('dotenv').config({ quiet: true })

const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const { ethers } = require('ethers')

const { deriveAddress } = require('./crypto/derived')

// ── Flare Coston2 config ──────────────────────────────────────────────────────
// Update REGISTRY_ADDR / VERIFIER_ADDR after running the Hardhat deploy —
// `npm run deploy` in contracts/ rewrites these two lines for you.
// RPC_URL/CHAIN_ID are overridable only so the e2e suite can point at a local
// Hardhat node; leave them unset for Coston2.
const COSTON2_RPC   = process.env.RPC_URL || 'https://coston2-api.flare.network/ext/C/rpc'
const CHAIN_ID      = Number(process.env.CHAIN_ID || 114)
const REGISTRY_ADDR = '0xd7931Df30821100BC7C9c161a691bCD70994B6AC' // DerivedRegistry.sol
const VERIFIER_ADDR = '0x729991fBE0Fb0f0caF6E5b6Df39e85d416202bFa' // ZKVerifier.sol

const EXPLORER = 'https://coston2-explorer.flare.network'

const { REGISTRY_ABI, VERIFIER_ABI } = require('./abi')

const provider = new ethers.JsonRpcProvider(COSTON2_RPC, {
  chainId: CHAIN_ID,
  name: 'coston2',
})

// Read-only contract handles — always available.
const registryRead = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, provider)
const verifierRead = new ethers.Contract(VERIFIER_ADDR, VERIFIER_ABI, provider)

// The relayer signs contract mutations (announce, registerProof). It holds no
// user funds. Built lazily so the server still boots for read-only routes.
let _relayer = null
function relayerWallet() {
  if (_relayer) return _relayer
  const key = process.env.RELAYER_PRIVATE_KEY
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set — required for on-chain writes')
  _relayer = new ethers.Wallet(key, provider)
  return _relayer
}

function assertDeployed() {
  if (REGISTRY_ADDR === ethers.ZeroAddress || VERIFIER_ADDR === ethers.ZeroAddress) {
    throw new Error('Contracts not deployed — set REGISTRY_ADDR / VERIFIER_ADDR in backend/index.js')
  }
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(bodyParser.json())

const DATA_DIR = path.join(__dirname, 'data')
fs.ensureDirSync(DATA_DIR)

// Sidecar: stores evmAddress + txHash per announcement (not on-chain).
// Indexed by derivedPub (the secp256k1 compressed pubkey stored on-chain).
const ANN_META_FILE = path.join(DATA_DIR, 'announcement_meta.json')
if (!fs.existsSync(ANN_META_FILE)) fs.writeJsonSync(ANN_META_FILE, {})

const META_MAP_FILE = path.join(DATA_DIR, 'meta_map.json')
if (!fs.existsSync(META_MAP_FILE)) fs.writeJsonSync(META_MAP_FILE, {})

function readAnnMeta() {
  try { return fs.readJsonSync(ANN_META_FILE) } catch { return {} }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decimal bigint string (snarkjs public signal) → 0x-prefixed bytes32. */
function toBytes32(n) {
  return '0x' + BigInt(n).toString(16).padStart(64, '0')
}

/** Hex string (with or without 0x) → 0x-prefixed, for `bytes` calldata. */
function toHexBytes(hex) {
  return '0x' + String(hex).replace(/^0x/i, '')
}

/** On-chain Announcement struct → the JSON shape the frontend expects. */
function mapAnnouncement(raw, annMeta) {
  const derivedAddress = String(raw.derivedAddress).replace(/^0x/i, '')
  const ephemeralR     = String(raw.ephemeralR).replace(/^0x/i, '')
  const sidecar = annMeta[derivedAddress] || {}
  return {
    id: Number(raw.id),
    derivedAddress,
    ephemeralR,
    evmAddress: sidecar.evmAddress || null,
    sender: raw.sender,
    timestamp: Number(raw.timestamp) * 1000, // block seconds → JS ms
    metadata: sidecar.txHash ? { txHash: sidecar.txHash } : null,
  }
}

// Encode a snarkjs proof into 256 bytes, hashed as an on-chain audit trail.
// pi_a is passed as-is (snarkjs does not negate it); pi_b keeps snarkjs's
// [imag, real] Fq2 ordering.
function encodeProofBytes(proof) {
  const b = n => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex')
  return Buffer.concat([
    b(proof.pi_a[0]),    b(proof.pi_a[1]),
    b(proof.pi_b[0][0]), b(proof.pi_b[0][1]),
    b(proof.pi_b[1][0]), b(proof.pi_b[1][1]),
    b(proof.pi_c[0]),    b(proof.pi_c[1]),
  ])
}

function fail(res, code, e) {
  return res.status(code).json({ error: e instanceof Error ? e.message : String(e) })
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  ok: true,
  chainId: CHAIN_ID,
  rpc: COSTON2_RPC,
  registry: REGISTRY_ADDR,
  verifier: VERIFIER_ADDR,
}))

// ── Announcements (on-chain via DerivedRegistry) ──────────────────────────────

app.get('/announcements', async (req, res) => {
  const from  = Math.max(0, parseInt(req.query.from, 10) || 0)
  const count = Math.min(200, Math.max(1, parseInt(req.query.count, 10) || 20))
  try {
    assertDeployed()
    const total = Number(await registryRead.getCount())
    if (total === 0 || from >= total) return res.json({ total, announcements: [] })

    const batch = await registryRead.getAnnouncements(from, count)
    const annMeta = readAnnMeta()
    res.json({ total, announcements: batch.map(a => mapAnnouncement(a, annMeta)) })
  } catch (e) {
    fail(res, 500, e)
  }
})

app.post('/announcements', async (req, res) => {
  const { derivedAddress, ephemeralR, evmAddress, metadata } = req.body
  if (!derivedAddress || !ephemeralR) return res.status(400).json({ error: 'missing fields' })
  try {
    assertDeployed()
    const registry = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, relayerWallet())
    const tx = await registry.announce(toHexBytes(derivedAddress), toHexBytes(ephemeralR))
    const receipt = await tx.wait()

    // Persist sidecar metadata (not stored in the contract: evmAddress + txHash)
    const annMeta = readAnnMeta()
    annMeta[String(derivedAddress).replace(/^0x/i, '')] = {
      evmAddress: evmAddress || null,
      txHash: metadata?.txHash || null,
    }
    fs.writeJsonSync(ANN_META_FILE, annMeta)

    res.json({ ok: true, hash: receipt.hash, explorer: `${EXPLORER}/tx/${receipt.hash}` })
  } catch (e) {
    fail(res, 500, e)
  }
})

// ── Key routes ────────────────────────────────────────────────────────────────
//
// There is deliberately no route that generates a meta-keypair. Doing so
// server-side would mean metaPriv existed in this process and crossed the
// network, which is the exact property the whole design rests on not doing.
// Key generation lives in frontend/lib/keys-browser.ts. These routes handle
// only the public half.

app.post('/keys/register', (req, res) => {
  const { walletAddress, metaAddress } = req.body
  if (!walletAddress || !metaAddress) return res.status(400).json({ error: 'walletAddress and metaAddress required' })
  const map = fs.readJsonSync(META_MAP_FILE)
  if (!map[walletAddress]) {
    map[walletAddress] = { metaAddress, registeredAt: Date.now() }
    fs.writeJsonSync(META_MAP_FILE, map)
  }
  res.json({ ok: true, metaAddress: map[walletAddress].metaAddress })
})

app.get('/keys/meta/:walletAddress', (req, res) => {
  const map = fs.readJsonSync(META_MAP_FILE)
  const entry = map[req.params.walletAddress]
  if (!entry) return res.json({ exists: false })
  res.json({ exists: true, ...entry })
})

// Build an unsigned EVM tx that anchors metaAddress to the user's wallet:
// a zero-value self-send whose calldata is SHA256(metaAddress). Signing it in
// MetaMask proves wallet ownership and writes the commitment into chain history.
app.post('/keys/build-register-tx', async (req, res) => {
  const { walletAddress, metaAddress } = req.body
  if (!walletAddress || !metaAddress) return res.status(400).json({ error: 'walletAddress and metaAddress required' })
  try {
    const from = ethers.getAddress(walletAddress)
    const data = '0x' + crypto.createHash('sha256').update(metaAddress).digest('hex')
    const [nonce, feeData] = await Promise.all([
      provider.getTransactionCount(from, 'pending'),
      provider.getFeeData(),
    ])
    const tx = {
      from,
      to: from,
      value: '0x0',
      data,
      nonce,
      gasLimit: '0x' + (21000n + BigInt(32 * 16)).toString(16),
      chainId: CHAIN_ID,
      maxFeePerGas: (feeData.maxFeePerGas ?? feeData.gasPrice)?.toString() ?? null,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() ?? null,
    }
    res.json({ tx, chainId: CHAIN_ID })
  } catch (e) {
    fail(res, 400, e)
  }
})

app.post('/keys/finalize-registration', (req, res) => {
  const { walletAddress, metaAddress, txHash } = req.body
  if (!walletAddress || !metaAddress || !txHash) {
    return res.status(400).json({ error: 'walletAddress, metaAddress, and txHash required' })
  }
  const map = fs.readJsonSync(META_MAP_FILE)
  if (map[walletAddress]) {
    return res.json({ ok: true, metaAddress: map[walletAddress].metaAddress, txHash: map[walletAddress].txHash, alreadyExisted: true })
  }
  map[walletAddress] = { metaAddress, txHash, registeredAt: Date.now(), onChain: true }
  fs.writeJsonSync(META_MAP_FILE, map)
  res.json({ ok: true, metaAddress, txHash })
})

// Lookup only. The previous version of this route minted a keypair server-side
// and returned metaPriv in the response body — removed for the reason above.
app.post('/keys/lookup', (req, res) => {
  const { walletAddress } = req.body
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' })
  const map = fs.readJsonSync(META_MAP_FILE)
  const entry = map[walletAddress]
  if (!entry) return res.json({ exists: false })
  res.json({ exists: true, metaAddress: entry.metaAddress, registeredAt: entry.registeredAt })
})

// ── Derived routes ────────────────────────────────────────────────────────────

// Sender-side derivation — only the recipient's PUBLIC metaAddress is needed.
app.post('/address/derive', (req, res) => {
  const { metaAddress } = req.body
  if (!metaAddress) return res.status(400).json({ error: 'metaAddress required' })
  try {
    res.json(deriveAddress(metaAddress))
  } catch (e) {
    fail(res, 400, e)
  }
})

app.get('/address/balance/:address', async (req, res) => {
  try {
    const address = ethers.getAddress(req.params.address)
    const wei = await provider.getBalance(address)
    res.json({ address, balance: ethers.formatEther(wei), wei: wei.toString() })
  } catch {
    res.json({ address: req.params.address, balance: null, exists: false })
  }
})

// Build an unsigned native-FLR transfer to the derived address.
app.post('/address/build-tx', async (req, res) => {
  const { fromAddress, toAddress, amount } = req.body
  if (!fromAddress || !toAddress || !amount) {
    return res.status(400).json({ error: 'fromAddress, toAddress, and amount required' })
  }
  try {
    const from = ethers.getAddress(fromAddress)
    const to   = ethers.getAddress(toAddress)
    const [nonce, feeData] = await Promise.all([
      provider.getTransactionCount(from, 'pending'),
      provider.getFeeData(),
    ])
    const tx = {
      from,
      to,
      value: ethers.parseEther(String(amount)).toString(),
      nonce,
      gasLimit: '21000',
      chainId: CHAIN_ID,
      maxFeePerGas: (feeData.maxFeePerGas ?? feeData.gasPrice)?.toString() ?? null,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() ?? null,
    }
    res.json({ tx, chainId: CHAIN_ID })
  } catch (e) {
    fail(res, 400, e)
  }
})

// Broadcast a raw signed tx produced by the wallet.
app.post('/address/submit', async (req, res) => {
  const signedTx = req.body.signedTx || req.body.rawTx
  if (!signedTx) return res.status(400).json({ error: 'signedTx required' })
  try {
    const sent = await provider.broadcastTransaction(signedTx)
    const receipt = await sent.wait()
    res.json({ success: true, hash: receipt.hash, explorer: `${EXPLORER}/tx/${receipt.hash}` })
  } catch (e) {
    fail(res, 400, e)
  }
})

// Claim: check the nullifier is unused → verify the proof → burn the nullifier
// on-chain. That is the whole job.
//
// This endpoint deliberately accepts NO private key. It is given only
// derivedAddress — a public address — so it can confirm the account is actually
// funded before spending the nullifier. The recipient signs and broadcasts the
// sweep themselves, from the browser, using the key they derived locally. The
// relayer therefore cannot move user funds even if it wanted to, which is what
// makes the non-custodial claim in the README true by construction rather than
// by promise.
app.post('/address/claim', async (req, res) => {
  const {
    recipientAddress,
    derivedAddress,
    proof,
    publicSignals,
  } = req.body

  if (!recipientAddress || !derivedAddress) {
    return res.status(400).json({ error: 'recipientAddress and derivedAddress required' })
  }
  // Reject anything that looks like a private key rather than silently ignoring
  // it — an old client sending one should fail loudly, not leak it into logs.
  if (req.body.derivedAccountKey || req.body.derivedPrivKey || req.body.evmPrivKey) {
    return res.status(400).json({
      error: 'This endpoint never accepts a private key. Sign the sweep in the browser and broadcast it via POST /address/submit.',
    })
  }

  // Accept the pre-computed fields; fall back to deriving them from publicSignals.
  const metaCommitment = req.body.metaCommitment ?? publicSignals?.[0]
  const nullifier      = req.body.nullifier      ?? publicSignals?.[1]
  const context        = req.body.context        ?? publicSignals?.[2] ?? '0'
  const proofHash      = req.body.proofHash
    ?? (proof ? '0x' + crypto.createHash('sha256').update(encodeProofBytes(proof)).digest('hex') : null)

  if (metaCommitment == null || nullifier == null || proofHash == null) {
    return res.status(400).json({ error: 'metaCommitment, nullifier and proofHash required (or a full proof + publicSignals)' })
  }

  try {
    assertDeployed()

    // 1. Refuse a spent nullifier outright. Registering-but-skipping would let
    //    the same proof drive a second sweep, which is exactly what the
    //    nullifier exists to prevent. If a previous attempt registered and then
    //    failed to sweep, the recipient still holds the derived key in their own
    //    browser and can move the funds directly — this endpoint is not the only
    //    way out.
    const nullifier32 = toBytes32(nullifier)
    if (await verifierRead.isNullifierUsed(nullifier32)) {
      return res.status(409).json({
        error: 'Nullifier already used — this proof has already been claimed. It cannot be submitted twice.',
      })
    }

    // 2. Fail fast on an empty derived account — before the nullifier is spent.
    const account = ethers.getAddress(derivedAddress)
    const balance = await provider.getBalance(account)
    if (balance === 0n) {
      return res.status(400).json({ error: `Derived account ${account} has no balance — has the sender paid it yet?` })
    }

    // 3. Verify the Groth16 proof off-chain when one was supplied. BN254
    //    pairings are not yet cheap enough to run inside the contract.
    if (proof && publicSignals) {
      const snarkjs = require('snarkjs')
      const vKey = require('../circuits/build/verification_key.json')
      const valid = await snarkjs.groth16.verify(vKey, publicSignals, proof)
      if (!valid) return res.status(400).json({ error: 'Invalid ZK proof' })
    }

    // 4. Burn the nullifier on-chain. The contract itself reverts on a repeat,
    //    so this is the authoritative gate even if two requests race.
    const verifier = new ethers.Contract(VERIFIER_ADDR, VERIFIER_ABI, relayerWallet())
    const regTx = await verifier.registerProof(
      toBytes32(metaCommitment),
      nullifier32,
      toBytes32(context),
      proofHash.startsWith('0x') ? proofHash : '0x' + proofHash,
    )
    const registerHash = (await regTx.wait()).hash

    // 5. Done. The sweep is the recipient's job — they hold the key and build,
    //    sign and broadcast the transfer themselves. We deliberately do not
    //    hand back a prepared transaction: a client that signs whatever the
    //    server sends could be redirected to an attacker's `to` address, so the
    //    browser derives every field from chain state it reads itself.
    res.json({
      success: true,
      registered: true,
      registerHash,
      explorer: `${EXPLORER}/tx/${registerHash}`,
      derivedAddress: account,
      recipientAddress: ethers.getAddress(recipientAddress),
      balance: ethers.formatEther(balance),
    })
  } catch (e) {
    fail(res, 400, e)
  }
})

// ── ZK proof routes ───────────────────────────────────────────────────────────
//
// There is no POST /zk/prove. The proof is generated in the browser with
// snarkjs WASM — metaPriv never reaches this server.

app.post('/zk/verify', async (req, res) => {
  const { proof, publicSignals } = req.body
  if (!proof || !publicSignals) return res.status(400).json({ error: 'proof and publicSignals are required' })
  try {
    const snarkjs = require('snarkjs')
    const vKey = require('../circuits/build/verification_key.json')
    const valid = await snarkjs.groth16.verify(vKey, publicSignals, proof)
    res.json({ valid })
  } catch (e) {
    fail(res, 400, e)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.PORT || '4000', 10)
const MAX_PORT_RETRIES = 25

function startServer(port, retriesLeft = MAX_PORT_RETRIES) {
  const server = app.listen(port, () => {
    console.log(`Backend listening on ${port}`)
    console.log(`  network:  Flare Coston2 (chainId ${CHAIN_ID})`)
    console.log(`  registry: ${REGISTRY_ADDR}`)
    console.log(`  verifier: ${VERIFIER_ADDR}`)
    try {
      console.log(`  relayer:  ${relayerWallet().address}`)
    } catch {
      console.warn('  relayer:  NOT CONFIGURED — set RELAYER_PRIVATE_KEY for on-chain writes')
    }
    if (REGISTRY_ADDR === ethers.ZeroAddress || VERIFIER_ADDR === ethers.ZeroAddress) {
      console.warn('  WARNING:  contract addresses are placeholders — deploy and update index.js')
    }
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = port + 1
      console.warn(`Port ${port} is already in use, retrying on ${nextPort}...`)
      server.close(() => startServer(nextPort, retriesLeft - 1))
      return
    }
    console.error(error)
    process.exit(1)
  })
}

startServer(PORT)
