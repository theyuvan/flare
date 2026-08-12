# FlarePay — Private Payments on Flare

> **Flare Summer Signal Hackathon 2026 — Bounty 2: Confidential Compute Apps**
>
> *Privacy-preserving payments using derived addresses and Groth16 zero-knowledge proofs. Every payment lands at a fresh one-time address that only the recipient can recognize — no mixers, no bridges, no custodians.*
>
> *Scanning for those payments is delegated to a **Flare Compute Extension running in a TEE**, which detects your payments without learning that they are yours — and without ever holding a key that could spend them.*

---

## Deployed Contracts — Flare Coston2 Testnet

| Contract | Address | Explorer |
| --- | --- | --- |
| `DerivedRegistry` | `0xd7931Df30821100BC7C9c161a691bCD70994B6AC` | [View](https://coston2-explorer.flare.network/address/0xd7931Df30821100BC7C9c161a691bCD70994B6AC) |
| `ZKVerifier` | `0x729991fBE0Fb0f0caF6E5b6Df39e85d416202bFa` | [View](https://coston2-explorer.flare.network/address/0x729991fBE0Fb0f0caF6E5b6Df39e85d416202bFa) |

### Verified end-to-end on Coston2

A full run of `npm run e2e` in `backend/` — every step against the live network,
no mocks. Each transaction is independently checkable:

| Step | Transaction |
| --- | --- |
| Payment to the one-time derived address | [`0xb701d158…`](https://coston2-explorer.flare.network/tx/0xb701d158478627bea2ead7ba3bf8cc86b2d18b5812181bb7228e6a0e13c7ac1e) |
| Announcement published to `DerivedRegistry` | [`0x87375534…`](https://coston2-explorer.flare.network/tx/0x873755343a674eceaf092096c036ad5114c97c03d807ecdd41c5d5d6f161cc5b) |
| Nullifier burned by the relayer | [`0x208f0fd1…`](https://coston2-explorer.flare.network/tx/0x208f0fd1fb9c198da56721c07944b27c8c71e93825792593dead4ed028217ace) |
| Sweep — signed by the recipient, not the relayer | [`0x74489cbe…`](https://coston2-explorer.flare.network/tx/0x74489cbe879060b2dfb9abeacc75c85dbf4fca7eac413e7fa49325b01b9608f0) |

Of 1.0 C2FLR sent, **0.9811 C2FLR reached the recipient's real wallet** — the
remainder is Coston2 gas. Note the last two rows are separate transactions sent
by *different* parties: the relayer burns the nullifier, then the recipient
signs the sweep themselves. The backend never holds a key that can move funds.

The run also asserts two negatives: offering the claim endpoint a private key is
rejected outright, and re-submitting the same proof returns HTTP 409 before any
funds move.

---

## Confidential Compute — Flare TEE Extension

> **Bounty 2 focus.** Source in [`tee/`](tee/). Run `cd tee && npm test` — 14 passing.

**Deployed and registered on Coston2:**

| | |
| --- | --- |
| `FlarePayInstructionSender` | [`0xDFF5e5ABb54F258FBe1330204714CAAEB4262591`](https://coston2-explorer.flare.network/address/0xDFF5e5ABb54F258FBe1330204714CAAEB4262591) |
| Extension ID in `TeeExtensionRegistry` | `0x10244` |

Confirmed by reading the contract back on-chain rather than trusting the deploy
log — `OP_TYPE_FLAREPAY` decodes to `FLAREPAY` and `OP_COMMAND_SAY_HELLO`
reverts, proving the bytecode is this extension and not the scaffold's demo.

**Not yet demonstrated, stated plainly:** no instruction has been relayed to the
enclave. The `sendScan` → registry → data provider → `POST /action` round trip
has never run, because the proxy requires Flare C-chain indexer credentials that
have not been issued. The extension container builds, boots and serves
`GET /state`, and the scanning logic is unit-tested — but it has not been driven
by a real on-chain instruction. See [`tee/README.md`](tee/README.md) for the full
status breakdown.

### The operation that requires a TEE

Finding your payments means trial-ECDH against **every announcement ever
posted** — work that is linear in chain history.

Two obvious approaches, both wrong:

| Approach | Fast | Private |
| --- | --- | --- |
| Scan in the browser | ✕ a phone grinds at scale | ✅ |
| Scan on a normal server | ✅ | ✕ the operator learns exactly which payments are yours |

The second destroys the precise property FlarePay exists to protect. So the
optimisation everyone reaches for is the one thing we cannot do — and no amount
of additional cryptography closes that gap, because the server must *touch* the
key to use it.

A TEE is the construction that gives both. The scan key is sealed to a keypair
that exists only inside the enclave, matching runs in enclave memory, and only
matching announcement **ids** come back out. The operator sees ciphertext going
in and integers coming out.

This is not a TEE added to satisfy a bounty. It is the one operation in FlarePay
where cryptography alone cannot deliver both privacy and scale.

### Scanning grants detection, never spending

The circuit in `circuits/src/derived_ownership.circom` already takes `scanPriv`
and `spendPriv` as **separate signals** — the app currently passes `metaPriv` for
both. Scanning only ever needs the scan half, so the enclave receives:

| Sent to the enclave | Withheld |
| --- | --- |
| `scanPriv`, ECIES-sealed to the enclave key | `spendPriv` — never leaves the device |
| `spendPub` — public half only | |

The enclave computes `h = SHA256(scanPriv · R)` and tests
`spendPub + h·G == derivedAddress`. Moving the funds requires `spendPriv + h`,
and it does not hold `spendPriv`.

**A total compromise of the extension costs users their privacy for the delegated
window. It can never cost them funds.** `tee/tests/crypto.test.ts` asserts this
as an executable test, not a claim in prose.

Because the maths reduces to the current single-key behaviour when
`scanPriv == spendPriv`, the extension scans announcements **already on Coston2**
with no migration, no circuit change, and no new trusted setup.

### Flow

```
Browser                    Coston2                      TEE enclave
───────                    ───────                      ───────────
                    FlarePayInstructionSender
seal(scanPriv) ──────────► sendScan(...) ──► TeeExtensionRegistry
   ECIES to                                        │
   enclave pubkey                        data providers relay
                                                   ▼
                                            POST /action
                                         ┌──────────────────┐
                                         │ open sealed key  │
                                         │ fetch announcements
                                         │ trial-ECDH match │
                                         └────────┬─────────┘
matching ids  ◄────────── result ◄─────────────────┘
```

The sealed key is public calldata **as ciphertext** — anyone can read the bytes,
only enclave code can open them. Announcements are fetched by the enclave over
RPC rather than passed as calldata: the list is public and large, and only the
key needs confidentiality.

| opType | opCommand | Payload | Returns |
| --- | --- | --- | --- |
| `FLAREPAY` | `GET_ENCLAVE_KEY` | none | `{ enclavePubKey, algorithm }` |
| `FLAREPAY` | `SCAN` | `abi.encode(ScanRequest)` | `{ total, scanned, matches[] }` |

### Attestation status — stated plainly

The scaffold has two independent flags, and conflating them is how projects
overclaim:

| Flag | Meaning |
| --- | --- |
| `LOCAL_MODE=false` | Live network — real contracts, registry, relay |
| `SIMULATED_TEE=true` | **Test code hash instead of hardware attestation** |

Flare's own `.env.example` ships `LOCAL_MODE=false` with `SIMULATED_TEE=true` as
the documented Coston2 development configuration, and the FCC documentation
states the protocol "is in the final stages of development and is not yet a fully
public production system."

> The extension targets Coston2 with `SIMULATED_TEE=true`. The Solidity contract,
> the instruction flow through `TeeExtensionRegistry`, the data-provider relay,
> the TEE node and the proxy are live. **Hardware attestation is stubbed with a
> test code hash** pending Confidential VM provisioning; `SIMULATED_TEE=false` on
> a GCP Confidential VM (AMD SEV) yields a genuine quote.

Consequence for the threat model: in simulated mode the enclave keypair is not
hardware-protected, so a malicious operator could substitute their own key. **Do
not seal a scan key you rely on until running under real attestation**, and bind
the key from `GET_ENCLAVE_KEY` to the attestation quote before trusting it.

Full detail, including the run procedure and prerequisites, in
[`tee/README.md`](tee/README.md).

---

## Table of Contents

0. [Confidential Compute — Flare TEE Extension](#confidential-compute--flare-tee-extension) ← **Bounty 2**
1. [The Problem](#1-the-problem)
2. [The Solution](#2-the-solution)
3. [How FlarePay Works](#3-how-flarepay-works)
4. [Why Zero-Knowledge Is the Core](#4-why-zero-knowledge-is-the-core)
5. [Cryptographic Design](#5-cryptographic-design)
6. [ZK Circuit](#6-zk-circuit)
7. [Smart Contracts](#7-smart-contracts)
8. [Tech Stack](#8-tech-stack)
9. [What We Built](#9-what-we-built)
10. [Architecture](#10-architecture)
11. [Repository Structure](#11-repository-structure)
12. [Local Development](#12-local-development)
13. [Security Model](#13-security-model)
14. [Competitive Landscape](#14-competitive-landscape)
15. [Roadmap](#15-roadmap)

---

## 1. The Problem

Every Flare wallet address is a permanent public surveillance record.

When you share your wallet address to receive a payment, you hand the other person a window into your entire financial history. Every transaction — who paid you, how much, when — is permanently visible on-chain to anyone with an internet connection. There is no opt-out.

| Problem | Reality |
| --- | --- |
| **Every payment is public** | Sender, recipient, amount, and timestamp are visible on-chain forever |
| **Analytics tools exist now** | On-chain explorers reconstruct complete payment histories from a single address in seconds |
| **No native privacy** | Flare has no built-in privacy primitive — you cannot hide a transaction without a dedicated layer |
| **Physical-world risk** | For humanitarian aid recipients, remittance workers, whistleblowers, and activists, a public wallet address is not just a privacy leak — it is a safety threat |
| **Business confidentiality** | Competitors can monitor your treasury movements, salary payments, and supplier relationships in real time |

### Why Existing Solutions Fail

| Approach | Problem |
| --- | --- |
| **Monero / Zcash** | Separate chain — forces users to bridge assets, breaks existing payment rails |
| **Tornado Cash-style mixers** | OFAC sanctioned in most jurisdictions; centralized point of failure; regulatory death sentence |
| **CEX intermediation** | Requires KYC, full custody, and blind trust in a third party — defeats the purpose entirely |
| **Manual address rotation** | Requires coordination with every sender, does not hide the payment graph, destroys UX |
| **Nothing** | The current default on most EVM chains including Flare — full transparency with zero opt-out |

There is no existing privacy primitive on Flare that lets you receive payments without permanently linking those payments to your identity.

---

## 2. The Solution

FlarePay adds a cryptographic privacy envelope around Flare payments. It reframes the problem from "use a different chain" to "use a mathematical guarantee on the same chain."

```
REGISTER  →  Generate a keypair (metaAddress + metaPriv).
             Share metaAddress publicly — like a username.
             metaPriv stays on your device. Never transmitted. Never stored.

SEND      →  Sender picks up your public metaAddress.
             Using EC Diffie-Hellman, derives a fresh one-time derived address.
             Funds land there. Nothing on-chain links the payment to your real wallet.
             Even the sender cannot trace you after the fact.

SCAN      →  Recipient runs metaPriv over all public announcements locally.
             ECDH matching identifies which derived addresses belong to them.
             Private key performs the matching — never sent to any server.

PROVE     →  Generate a Groth16 ZK proof in the browser via snarkjs WASM.
             Proves you own the derived address without revealing your private key,
             your real wallet, or any other address you control.
             A Poseidon nullifier prevents replay attacks on-chain.

CLAIM     →  Funds sweep from derived account to your real wallet.
             Derived account permanently closed. Chain record shows two unlinked events.
```

**No mixers. No bridges. No custodians. Pure cryptography on Flare.**

### Key Guarantees

- **No static address** — every incoming payment lands at a brand-new derived address. There is no single "your wallet" to surveil, threaten, or extort.
- **No linkability** — the on-chain payment carries no metadata back to your real wallet. The sender cannot trace you. Chain observers cannot connect the derived address to your identity.
- **No forced disclosure** — claiming funds requires a ZK proof, not a public reveal. You never have to expose your real wallet to receive or scan for money.
- **Selective disclosure** — you can prove you received a specific payment to a compliance officer or auditor, without revealing your full payment history. Not anonymous — selectively transparent.

---

## 3. How FlarePay Works

### The Five Steps

```
┌──────────────────────────────────────────────────────────────────────┐
│  REGISTER                                                            │
│  Generate secp256k1 keypair → metaAddress (public) + metaPriv       │
│  Sign on-chain tx to anchor your identity to your wallet             │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────┐
│  SEND                                                                │
│  Sender fetches recipient's metaAddress                              │
│  Generates ephemeral scalar r → R = r·G                              │
│  Computes ECDH: S = r · metaAddress                                  │
│  Derives derived address: P = metaAddress + SHA256(S)·G             │
│  Sends funds to P. Posts (P, R) as announcement on-chain            │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────┐
│  SCAN                                                                │
│  Recipient fetches all announcements from chain                      │
│  For each: S′ = metaPriv · R, h = SHA256(S′)                        │
│  If metaAddress + h·G == announcement.derivedAddress → match found  │
│  Derives derived account private key from S′                        │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────┐
│  PROVE                                                               │
│  Generate Groth16 ZK proof in browser via snarkjs WASM              │
│  Public outputs: metaCommitment + nullifier (no private key)        │
│  Nullifier registered on ZKVerifier contract — anti-replay          │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────┐
│  CLAIM                                                               │
│  Derived account signs transfer to recipient's real wallet           │
│  Full balance sweeps in one transaction                              │
│  Derived account closed. Two unlinked on-chain events remain.       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Why Zero-Knowledge Is the Core

The system has two requirements that seem to contradict each other:

**Requirement 1** — The recipient must prove they own the derived address to claim the funds.

**Requirement 2** — That proof cannot reveal the private key, or the entire privacy guarantee collapses.

This is the exact problem ZK proofs were built to solve.

### The Problem Without ZK

Without ZK, the only option is to sign a transaction with `metaPriv`. The moment you sign anything on-chain with `metaPriv`, the link becomes visible — this key controls both the derived address and the meta-address identity. You have just connected them publicly. Privacy destroyed.

### What ZK Solves

Instead of revealing `metaPriv`, you run it through the Circom circuit:

```
Private input:  metaPriv  ←  stays on your device, never transmitted
                    │
                    ▼
metaCommitment = Poseidon(metaPriv, metaPriv)   ← posted on-chain
nullifier      = Poseidon(metaPriv, context)    ← posted on-chain, anti-replay
```

The proof says: *"I know the private key behind this metaAddress and I am the one who derived this derived address — without showing you the key."*

The verifier checks the math. The nullifier is stored. Funds release. The private key was never seen by anyone.

### The Two-Layer Guarantee

| Layer | What it hides | What it proves |
| --- | --- | --- |
| **ECDH derived address** | Who received the payment — no link to real wallet on-chain | Sender computed a valid one-time address from your public key |
| **Groth16 ZK proof** | Private key and all other derived addresses you own | You control the derived address — without revealing how |

Remove either layer and the system breaks. ECDH alone lets you receive privately but you cannot claim without revealing yourself. ZK alone without derived addresses means payments still land at your known wallet. Both together is what makes the full privacy guarantee work end-to-end.

---

## 5. Cryptographic Design

### Key System — Single Keypair

FlarePay uses **one secp256k1 keypair** per user. No separate scan/spend key split needed for this scheme.

| Key | Type | Purpose |
| --- | --- | --- |
| `metaAddress` | secp256k1 compressed pubkey — 33 bytes, hex-encoded | Share publicly — like a username. Senders derive your derived addresses from this. |
| `metaPriv` | secp256k1 private key — 32 bytes, hex-encoded | Keep secret. Used for scanning and claiming. Never stored on any server. |

### Derived Address Derivation — Sender Side

```
r         = random scalar                     (ephemeral, discarded after use)
R         = r · G                             (ephemeral public key — published as hint)
S         = r · metaAddress                   (ECDH shared point — only recipient can compute this)
h         = SHA256(S_compressed) mod n
P_derived = metaAddress + h · G              (one-time derived secp256k1 pubkey)
seed      = SHA256(S_compressed)              (32-byte seed for account keypair)
account   = EVM keypair derived from seed    (EVM account that holds the funds)
```

The sender publishes `(P_derived, R)` on-chain. No information about the recipient leaks — even the sender cannot reverse-engineer the link after the fact.

### Payment Recognition — Recipient Side

```
S′        = metaPriv · R                      (same shared point — ECDH is symmetric)
h′        = SHA256(S′_compressed) mod n
P′        = metaAddress + h′ · G

if P′ == announcement.derivedAddress → this payment is mine
seed      = SHA256(S′_compressed)
account   = EVM keypair from seed            (controls the derived EVM account)
```

### Why This Is Unlinkable

An outside observer sees:
1. A payment to some address they have never seen before (the derived address)
2. An announcement posting `(P_derived, R)` — two compressed curve points

`P_derived` is a random-looking point on secp256k1. Without knowing `metaPriv` or the ephemeral `r`, there is no way to connect `P_derived` to the recipient's `metaAddress`. The ECDH shared secret `S` is computationally infeasible to recover without one of the two private inputs.

---

## 6. ZK Circuit

**File:** `circuits/src/derived_ownership.circom`

```circom
pragma circom 2.1.6;
include "node_modules/circomlib/circuits/poseidon.circom";

template DerivedOwnership() {
    // Private inputs — never leave the prover's device
    signal input scanPriv;         // metaPriv — kept secret
    signal input spendPriv;        // metaPriv — same key, single-keypair design

    // Public inputs — posted on-chain alongside the proof
    signal input metaCommitment;   // Poseidon(scanPriv, spendPriv) — identity anchor
    signal input nullifier;        // Poseidon(scanPriv, context) — anti-replay token
    signal input context;          // verifier-supplied constant (e.g. 0x01)

    // Constraint 1: prover knows the private key behind this meta-address
    component metaHash = Poseidon(2);
    metaHash.inputs[0] <== scanPriv;
    metaHash.inputs[1] <== spendPriv;
    metaHash.out === metaCommitment;

    // Constraint 2: nullifier was honestly computed — prevents replay
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== scanPriv;
    nullHash.inputs[1] <== context;
    nullHash.out === nullifier;
}

component main {public [metaCommitment, nullifier, context]} = DerivedOwnership();
```

### What the Proof Reveals

| Signal | Value | What it proves |
| --- | --- | --- |
| `metaCommitment` | `Poseidon(metaPriv, metaPriv)` | Prover controls this meta-address — without revealing the key |
| `nullifier` | `Poseidon(metaPriv, context)` | This proof can be submitted exactly once — replay prevention |
| `context` | Verifier-supplied constant | Proof is bound to this specific claim instance |

**Private inputs (`metaPriv`) never leave the prover's browser.** snarkjs runs the Groth16 prover entirely in WebAssembly inside the browser tab.

### Proof System Properties

| Property | Value |
| --- | --- |
| Circuit language | Circom 2.1.6 |
| Proof system | Groth16 |
| Elliptic curve | BN254 (bn128) |
| Hash function | Poseidon — ZK-friendly, efficient inside circuits |
| Proving library | snarkjs 0.7.6 |
| Trusted setup | Powers of Tau (ptau size 12) + circuit-specific Phase 2 |
| Proving environment | In-browser WASM via snarkjs |

### Verifying Key Integrity

The verifying key used by `ZKVerifier.sol` must match the key produced by the trusted setup byte-for-byte. To verify:

```bash
# Export from the zkey and compare with what's in ZKVerifier.sol
node -e "
  const fs = require('fs')
  const vk = JSON.parse(fs.readFileSync('circuits/build/verification_key.json'))
  console.log(JSON.stringify(vk.vk_alpha_1.slice(0,2)))
  console.log(JSON.stringify(vk.vk_beta_2[0]))
"
```

---

## 7. Smart Contracts

Two EVM contracts deployed on Flare Coston2.

### `DerivedRegistry.sol` — Announcement Registry

Stores derived payment hints on-chain. Any sender calls `announce()` after making a derived payment. Recipients fetch all announcements to scan for their own.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DerivedRegistry {
    struct Announcement {
        uint256 id;
        bytes   derivedAddress;   // compressed secp256k1 pubkey (33 bytes)
        bytes   ephemeralR;       // sender ephemeral R point (33 bytes)
        address sender;
        uint256 timestamp;
    }

    Announcement[] private _announcements;

    event Announced(uint256 indexed id, bytes derivedAddress, bytes ephemeralR, address sender);

    function announce(bytes calldata derivedAddress, bytes calldata ephemeralR)
        external returns (uint256 id)
    {
        id = _announcements.length;
        _announcements.push(Announcement({
            id:             id,
            derivedAddress: derivedAddress,
            ephemeralR:     ephemeralR,
            sender:         msg.sender,
            timestamp:      block.timestamp
        }));
        emit Announced(id, derivedAddress, ephemeralR, msg.sender);
    }

    function getCount() external view returns (uint256) {
        return _announcements.length;
    }

    function getAnnouncements(uint256 from, uint256 count)
        external view returns (Announcement[] memory result)
    {
        uint256 total = _announcements.length;
        if (from >= total) return result;
        uint256 end = from + count > total ? total : from + count;
        result = new Announcement[](end - from);
        for (uint256 i = from; i < end; i++) {
            result[i - from] = _announcements[i];
        }
    }
}
```

### `ZKVerifier.sol` — Nullifier Registry

Registers ZK proof nullifiers on-chain to prevent replay attacks. Proof verification runs off-chain via snarkjs. Only the nullifier and a proof hash are stored on-chain as a permanent audit trail.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ZKVerifier {
    struct ProofRecord {
        bytes32 metaCommitment;
        bytes32 nullifier;
        bytes32 context;
        bytes32 proofHash;      // SHA256 of raw proof bytes — audit trail
        address submitter;
        uint256 timestamp;
    }

    mapping(bytes32 => ProofRecord) private _proofs;
    mapping(bytes32 => bool)        private _used;

    event ProofRegistered(bytes32 indexed nullifier, address submitter);

    function registerProof(
        bytes32 metaCommitment,
        bytes32 nullifier,
        bytes32 context,
        bytes32 proofHash
    ) external {
        require(!_used[nullifier], "Nullifier already used");
        _used[nullifier] = true;
        _proofs[nullifier] = ProofRecord({
            metaCommitment: metaCommitment,
            nullifier:      nullifier,
            context:        context,
            proofHash:      proofHash,
            submitter:      msg.sender,
            timestamp:      block.timestamp
        });
        emit ProofRegistered(nullifier, msg.sender);
    }

    function isNullifierUsed(bytes32 nullifier) external view returns (bool) {
        return _used[nullifier];
    }

    function getProofRecord(bytes32 nullifier) external view returns (ProofRecord memory) {
        return _proofs[nullifier];
    }
}
```

**Replay-protection guarantee:** once `registerProof` is called with a nullifier, any subsequent call with the same nullifier reverts immediately. Each ZK proof can be submitted exactly once — enforced by the contract itself.

---

## 8. Tech Stack

| Layer | Technology |
| --- | --- |
| **ZK Circuit** | Circom 2.1.6, Groth16, BN254 curve |
| **ZK Proving** | snarkjs 0.7.6 — browser WASM |
| **ZK Hash** | Poseidon (circomlibjs) — ZK-friendly |
| **Derived Crypto** | @noble/curves (secp256k1), @noble/hashes (SHA256) |
| **Smart Contracts** | Solidity ^0.8.20 — EVM on Flare Coston2 |
| **Contract Deploy** | Hardhat + Flare Coston2 RPC |
| **Confidential Compute** | Flare Compute Extension (FCE) — TypeScript, on Coston2 |
| **TEE key exchange** | ECIES over secp256k1 + AES-256-GCM |
| **Backend** | Node.js + Express — relayer + chain bridge |
| **Chain SDK** | ethers.js v6 |
| **Frontend** | Next.js 15, React 19, TypeScript |
| **UI** | Tailwind CSS v4, Shadcn UI, Radix |
| **3D Background** | @react-three/fiber, three-globe |
| **Wallet** | wagmi + MetaMask / any EIP-6963 injected wallet |

---

## 9. What We Built

### Working Features

**Key Management**
- Generate a secp256k1 meta-keypair (`metaAddress` + `metaPriv`) in the browser
- Register `metaAddress` on-chain by signing a wallet transaction (proves wallet ownership without revealing the private key)
- Off-chain registry maps wallet addresses to their meta-addresses

**Send a Private Payment**
- Sender enters the recipient's `metaAddress`
- ECDH derivation computes a fresh one-time derived address
- Payment sent to the derived address — no link to the recipient on-chain
- Announcement `(derivedAddress, ephemeralR)` posted to the registry contract

**Scan for Incoming Payments**
- Recipient enters `metaPriv`
- Backend fetches all announcements from the registry contract
- ECDH matching identifies which announcements belong to the recipient
- Each matched announcement reveals the derived account's private key
- Balance of each derived account fetched from the chain

**ZK Proof Generation**
- Groth16 proof generated using snarkjs with Circom-compiled WASM
- Proof inputs: `metaPriv` (private), `metaCommitment` + `nullifier` + `context` (public)
- Proof verifiable by anyone using the public verification key
- Local verification before submitting to the backend

**Claim Funds**
- ZK proof verified off-chain by the backend
- Nullifier registered on the `ZKVerifier` contract — permanent anti-replay record
- Full balance transferred from derived account to recipient's real wallet
- Derived account permanently closed

**History View**
- Public announcement history — all derived payment hints
- Shows derived addresses and timestamps (no recipient identity revealed)
- Paginated, live-updating feed

**Frontend Pages**

| Page | What it does |
| --- | --- |
| `/` | Landing page — 3D globe, privacy problem, how it works |
| `/send` | Enter metaAddress → derive derived address → send payment |
| `/receive` | Generate keys → register on-chain → scan for payments |
| `/prove` | Enter metaPriv → generate ZK proof → claim funds |
| `/history` | Public announcement feed |

### Circuit Artifacts (Committed — No Rebuild Required)

| File | Description |
| --- | --- |
| `circuits/build/derived_ownership.r1cs` | Compiled R1CS constraints |
| `circuits/build/derived_ownership.wasm` | WASM witness generator |
| `circuits/build/derived_ownership_0001.zkey` | Groth16 proving key |
| `circuits/build/verification_key.json` | Verifier key — embedded in ZKVerifier contract |

---

## 10. Architecture

```
┌──────────────────────── User / Browser ────────────────────────────────────┐
│  Next.js 15 — React 19 — TypeScript — Tailwind CSS v4                     │
│                                                                            │
│  Wallet: wagmi + MetaMask (Flare/EVM), EIP-6963 injected discovery        │
│  ZK Proving: snarkjs WASM — Groth16 fullProve runs in browser             │
│  Derived scan: @noble/curves secp256k1 ECDH — runs in browser             │
│  3D Background: @react-three/fiber + three-globe                           │
│  UI: Shadcn + Radix                                                        │
│                                                                            │
│  Pages:  /  ·  /send  ·  /receive  ·  /prove  ·  /history                │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ HTTP (localhost:4000)
                                ▼
┌──────────────────────── Backend — Express :4000 ───────────────────────────┐
│  NO ROUTE ON THIS SERVER EVER ACCEPTS metaPriv.                            │
│                                                                            │
│  POST /address/derive         — ECDH derivation from a PUBLIC metaAddress  │
│  POST /address/build-tx       — Build unsigned EVM transfer                │
│  POST /address/submit         — Broadcast a signed raw transaction         │
│  POST /address/claim          — Verify proof → burn nullifier (no key)     │
│  GET  /address/balance/:addr  — Native FLR balance                         │
│  POST /keys/generate          — Fresh secp256k1 keypair (browser prefers   │
│                                 lib/keys-browser.ts — never transmitted)   │
│  POST /keys/build-register-tx — Build identity registration transaction    │
│  POST /zk/verify              — Off-chain proof verification               │
│  GET  /announcements          — Paginated list (no private key required)   │
│  POST /announcements          — Post new derived payment hint              │
│                                                                            │
│  Crypto: @noble/curves · @noble/hashes · circomlibjs · snarkjs            │
│  Chain:  ethers.js v6                                                      │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ JSON-RPC
                                ▼
┌──────────────────────── Flare Coston2 Testnet ─────────────────────────────┐
│  DerivedRegistry.sol           — On-chain announcement store               │
│  ZKVerifier.sol                — Nullifier registry + proof records        │
│  FlarePayInstructionSender.sol — TEE entry point (sealed scan requests)    │
│  TeeExtensionRegistry          — Routes instructions to TEE machines       │
│  Native FLR transfers          — Payment + recipient-signed claim sweep    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ instruction events, relayed by data providers
                                ▼
┌──────────────── Flare Confidential Compute — TEE enclave ──────────────────┐
│  FLAREPAY/GET_ENCLAVE_KEY  — publishes the enclave's public encryption key │
│  FLAREPAY/SCAN             — opens the sealed scan key, trial-ECDH match   │
│                                                                            │
│  Holds scanPriv only, in enclave memory. Returns matching ids and nothing  │
│  else. Cannot derive a spending key — spendPriv never leaves the device.   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Repository Structure

```
flarepay/
├── README.md                           ← this file
├── FLARE_GUIDE.md                      ← porting checklist + reviewer fixes
│
├── backend/
│   ├── index.js                        # Express API — all routes
│   ├── generate_proof.js               # snarkjs fullProve + verify
│   ├── crypto/
│   │   ├── keys.js                     # secp256k1 keypair generation
│   │   ├── derived.js                  # ECDH derivation + keypair
│   │   └── scan.js                     # Announcement scanner
│   ├── tests/
│   │   └── derived.test.js             # Unit tests — run: node backend/tests/derived.test.js
│   ├── data/                           # gitignored — created at runtime
│   │   ├── announcement_meta.json
│   │   └── meta_map.json
│   └── package.json
│
├── circuits/
│   ├── src/
│   │   └── derived_ownership.circom    # Groth16 circuit
│   ├── build/                          # Compiled — skip rebuild unless circuit changes
│   │   ├── derived_ownership.r1cs
│   │   ├── derived_ownership_0001.zkey
│   │   ├── verification_key.json
│   │   └── derived_ownership_js/
│   │       └── derived_ownership.wasm
│   ├── scripts/
│   │   ├── compile.sh                  # Full circuit build from clean checkout
│   │   └── generate_proof.js           # CLI proof generator
│   └── package.json
│
├── contracts/
│   ├── contracts/
│   │   ├── DerivedRegistry.sol         # EVM announcement registry
│   │   └── ZKVerifier.sol              # EVM nullifier registry
│   ├── scripts/deploy.js               # Coston2 deploy — writes deployments.coston2.json
│   ├── test/
│   │   ├── contracts.test.js           # Solidity behaviour
│   │   └── backend-abi.test.js         # Guards the backend ABI seam
│   ├── hardhat.config.js               # Coston2 network config
│   └── package.json
│
├── tee/                                ← Flare Compute Extension (Bounty 2)
│   ├── extension/
│   │   ├── config.ts                   # Op identifiers — must match the contract
│   │   ├── crypto.ts                   # ECIES sealing + scan matching maths
│   │   ├── abi.ts                      # ScanRequest decoder
│   │   ├── registry.ts                 # Reads announcements from DerivedRegistry
│   │   └── handlers.ts                 # The two TEE handlers
│   ├── contracts/
│   │   └── FlarePayInstructionSender.sol
│   ├── tests/
│   │   └── crypto.test.ts              # 14 tests — run: cd tee && npm test
│   └── README.md                       # Run procedure + attestation status
│
└── frontend/
    ├── app/
    │   ├── page.tsx                    # Landing page
    │   ├── layout.tsx                  # Wraps everything in WalletProvider
    │   ├── send/page.tsx               # Derive derived address + pay
    │   ├── receive/page.tsx            # Generate keys, anchor, scan
    │   ├── prove/page.tsx              # Browser ZK proof + claim
    │   └── history/page.tsx            # Public announcement feed
    ├── components/
    │   ├── app-nav.tsx                 # Nav + wallet button
    │   ├── app-shell.tsx               # Shared page frame
    │   ├── wallet-connect.tsx          # MetaMask / injected via wagmi
    │   ├── copy-field.tsx              # Copy + reveal for keys
    │   └── ui/                         # Shadcn components
    ├── hooks/
    │   └── wallet-context.tsx          # wagmi + react-query providers
    ├── lib/
    │   ├── chain.ts                    # Coston2 chain def + explorer links
    │   ├── keys-browser.ts             # In-browser meta-keypair generation
    │   ├── prove-browser.ts            # Browser ZK proof — snarkjs WASM
    │   └── scan-browser.ts             # Browser derived scan — @noble/curves
    ├── public/
    │   └── circuits/                   # WASM + zkey for browser proving
    │       ├── derived_ownership.wasm
    │       ├── derived_ownership_0001.zkey
    │       └── verification_key.json
    └── package.json
```

---

## 12. Local Development

### Prerequisites

| Tool | Version | How to install |
| --- | --- | --- |
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| Rust + Cargo | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Circom | 2.1.6 | `cargo install circom` |
| MetaMask | any | Browser extension — add Coston2 testnet |

**Coston2 network settings for MetaMask:**

| Field | Value |
| --- | --- |
| Network name | Flare Testnet Coston2 |
| RPC URL | `https://coston2-api.flare.network/ext/C/rpc` |
| Chain ID | `114` |
| Currency symbol | `C2FLR` |
| Block explorer | `https://coston2-explorer.flare.network` |

Get test tokens: [faucet.flare.network](https://faucet.flare.network) → select Coston2.

---

### Step 1 — Clone and Install

```bash
git clone <your-repo-url>
cd flarepay

cd backend  && npm install && cd ..

# IMPORTANT: npm install inside circuits/ is required before compiling.
# The Circom file includes circomlib via a relative node_modules path.
# Without this step, the circom compiler will fail with a "file not found" error.
cd circuits && npm install && cd ..

cd frontend && npm install && cd ..
```

---

### Step 2 — Deploy Contracts to Coston2

```bash
cd contracts

# Install Hardhat if not already installed
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox

# Configure hardhat.config.js:
# networks: {
#   coston2: {
#     url: "https://coston2-api.flare.network/ext/C/rpc",
#     chainId: 114,
#     accounts: [process.env.DEPLOYER_PRIVATE_KEY],
#   }
# }

npx hardhat run scripts/deploy.js --network coston2
# Note the deployed addresses for DerivedRegistry and ZKVerifier
```

Update `backend/index.js` with the deployed addresses:

```js
const REGISTRY_ADDRESS = '0x...'   // DerivedRegistry
const VERIFIER_ADDRESS = '0x...'   // ZKVerifier
```

---

### Step 3 — Start the Backend

```bash
cd backend

# Create .env with your relayer key
echo "RELAYER_PRIVATE_KEY=0x..." > .env

node index.js
# → FlarePay backend listening on 4000
# → Registry: 0x...
# → Verifier:  0x...
```

---

### Step 4 — Start the Frontend

```bash
cd frontend
npm run dev
# → http://localhost:3000
```

---

### Step 5 — Run Tests

```bash
node backend/tests/derived.test.js
```

Expected output:

```text
Key generation

  ✓  generateMetaAddress returns a valid 32-byte hex private key
  ✓  generateMetaAddress: metaAddress equals metaPub (single-key design)
  ✓  generateMetaAddress: metaAddress is a compressed secp256k1 pubkey (66 chars)
  ✓  generateMetaAddress is random each call

Derived address derivation

  ✓  deriveAddress returns derivedPub, ephemeralR, evmAddress
  ✓  deriveAddress never leaks the derived private key to the sender
  ✓  sender and recipient derive the SAME EVM derived account (ECDH is symmetric)
  ✓  a wrong metaPriv derives a different EVM account
  ✓  different sends produce different derived addresses and ephemeralR values
  ✓  deriveSpendKey returns a valid 64-char hex scalar
  ✓  deriveSpendKey is the discrete log of derivedPub

Announcement scanning

  ✓  scanAnnouncements finds the correct owned announcement
  ✓  scanAnnouncements returns empty for the wrong private key
  ✓  scanAnnouncements silently skips malformed entries
  ✓  scanAnnouncements on an empty list returns an empty array

─────────────────────────────────────────────
  15 passed  /  0 failed
```

Contract tests — Solidity behaviour plus the seam between the deployed ABI and
the backend's hand-written minimal ABI:

```bash
cd contracts && npx hardhat test
# 12 passing
```

TEE extension — ECIES sealing plus the property that scanning grants no
spending power:

```bash
cd tee && npm install && npm test
# 14 passed / 0 failed
```

---

### Step 6 — (Optional) Rebuild the ZK Circuit

> The compiled artifacts in `circuits/build/` are committed and ready to use. Only rebuild if you modify the Circom circuit.

```bash
# One-command build (installs deps, compiles, runs full trusted setup):
bash circuits/scripts/compile.sh

# After rebuilding, copy new artifacts to the frontend public directory:
cp circuits/build/derived_ownership_js/derived_ownership.wasm frontend/public/circuits/
cp circuits/build/derived_ownership_0001.zkey                 frontend/public/circuits/
cp circuits/build/verification_key.json                        frontend/public/circuits/
```

Manual steps if you prefer:

```bash
cd circuits

# Step 1 — compile (npm install must have been run first)
circom src/derived_ownership.circom \
  --r1cs --wasm --sym \
  --output build/ \
  --include node_modules

# Step 2 — Phase 1: Powers of Tau
npx snarkjs powersoftau new bn128 12 build/pot12_0000.ptau
npx snarkjs powersoftau contribute build/pot12_0000.ptau build/pot12_0001.ptau --name="FlarePay"
npx snarkjs powersoftau prepare phase2 build/pot12_0001.ptau build/pot12_final.ptau

# Step 3 — Phase 2: Groth16 circuit setup
npx snarkjs groth16 setup build/derived_ownership.r1cs build/pot12_final.ptau build/derived_ownership_0000.zkey
npx snarkjs zkey contribute build/derived_ownership_0000.zkey build/derived_ownership_0001.zkey --name="FlarePay"
npx snarkjs zkey export verificationkey build/derived_ownership_0001.zkey build/verification_key.json
```

---

### Step 7 — End-to-End Test Flow

**Register and send a payment:**

1. Open `localhost:3000` — connect MetaMask (set to Coston2 testnet)
2. Go to `/receive` → click **Generate & Register** → sign the on-chain registration transaction
3. Copy your `metaAddress` (share this freely — it is public). Save `metaPriv` — it is shown once and never stored by the app.
4. Open `/send` in a different browser/wallet → paste the `metaAddress` → enter amount → **Derive Derived Address** → **Send** → sign in MetaMask
5. The payment lands at a fresh one-time derived address. The announcement is posted on-chain.

**Scan and claim:**

1. Go to `/receive` → enter `metaPriv` → **Scan for My Payments**
2. Your payment appears with its balance
3. Click **Generate ZK Proof & Claim** → wait 10–30 seconds for proof generation
4. Sign the claim-authorization transaction in MetaMask
5. Funds arrive in your connected wallet. The derived account is closed.

---

## 13. Security Model

| Property | Current State |
| --- | --- |
| **metaPriv never stored** | Shown once at generation, held only in React state, cleared on navigation. Never written to localStorage, sessionStorage, or any server database. |
| **ZK proof generation** | Runs **in the browser**. `frontend/lib/prove-browser.ts` calls `snarkjs.groth16.fullProve()` against the WASM and zkey served from `frontend/public/circuits/`. `metaPriv` enters the circuit witness inside the tab and is never transmitted. There is no `POST /zk/prove` route on the backend — the endpoint was removed, not merely bypassed. |
| **Derived scanning** | Runs **in the browser**. `frontend/lib/scan-browser.ts` performs the secp256k1 ECDH matching with `@noble/curves`. The backend only serves the public announcement list via `GET /announcements`, which takes no private key. There is no `POST /address/scan` route on the backend. |
| **No route accepts any private key** | Every backend endpoint was audited. No route accepts a private key of any kind — not `metaPriv`, not a one-time derived key. `POST /address/claim` actively rejects a request carrying one rather than ignoring it, so an outdated client fails loudly instead of leaking a key into logs. The e2e suite asserts this on every run. |
| **Delegated scanning (TEE)** | Optional. The scan key is ECIES-sealed to a keypair that exists only inside the enclave; matching runs in enclave memory and only announcement ids are returned. The enclave receives `scanPriv` and `spendPub` — never `spendPriv` — so it can detect payments but can never move them. Currently runs with `SIMULATED_TEE=true`: real instruction flow, stubbed hardware attestation. See [`tee/README.md`](tee/README.md). |
| **One-time addresses** | Each payment uses a fresh ephemeral scalar `r`. No two payments to the same recipient share a derived address. Chain-level unlinkability is preserved across all payments. |
| **Replay protection** | Poseidon nullifiers prevent the same proof from being reused. The nullifier is permanently stored on the `ZKVerifier` contract after first use — enforced by the chain, not by the backend. |
| **Selective disclosure** | Not anonymous mixing. Recipients can generate a ZK proof to prove they received a specific payment to a compliance officer — without revealing their full payment history or any other addresses. |
| **Non-custodial** | Enforced by the API surface, not by policy. `POST /address/claim` accepts no private key and rejects any request containing one; it only burns the nullifier on-chain. The recipient derives the one-time account key in their browser, and signs and broadcasts the sweep there too, reading every transaction field from the chain directly. The relayer pays gas for the nullifier registration and cannot move user funds. |

---

## 14. Competitive Landscape

| Feature | Monero | Zcash | Tornado Cash | **FlarePay** |
| --- | --- | --- | --- | --- |
| Runs on Flare | ✕ Separate chain | ✕ Separate chain | ✕ Ethereum only | ✅ Native Flare |
| Derived addresses | ✅ Built-in | Partial | ✕ Not native | ✅ ECDH on secp256k1 |
| ZK ownership proofs | ✕ None | Sapling | ✕ None | ✅ Groth16 |
| In-browser proving | ✕ No | ✕ No | ✕ No | ✅ snarkjs WASM |
| No custodian | ✅ | ✅ | ✅ | ✅ |
| Regulatory risk | ✕ Delistings | Grey area | ✕ OFAC sanctioned | ✅ Selective disclosure + compliance |
| Selective disclosure | ✕ All-or-nothing | View keys only | ✕ None | ✅ ZK proof reveals only what you choose |
| Replay protection | ✅ | ✅ | ✅ | ✅ On-chain nullifiers |
| Payments UX | ✕ Slow, complex | ✕ Complex | ✕ High gas | ✅ Fast + low fees |

---

## 15. Roadmap

| Milestone | Status |
| --- | --- |
| secp256k1 ECDH derived address derivation | ✅ Complete |
| Groth16 ZK circuit — metaCommitment + nullifier | ✅ Complete |
| On-chain announcement registry | ✅ Complete |
| On-chain nullifier registry with replay protection | ✅ Complete |
| End-to-end claim flow — derive → prove → sweep | ✅ Complete |
| Unit tests — key generation, derivation, scanning | ✅ Complete |
| Browser-side ZK proof (`prove-browser.ts`) | ✅ Complete — wired into `/prove`, no backend proving route exists |
| Browser-side scanning (`scan-browser.ts`) | ✅ Complete — wired into `/receive` and `/prove` |
| Flare Coston2 contract deployment | ✅ Deployed and verified end-to-end on Coston2 |
| MetaMask wallet integration | ✅ Complete — wagmi + EIP-6963 injected discovery |
| Confidential scanning as a Flare Compute Extension | ✅ Built and unit-tested — `tee/`, 14 tests passing |
| Split scan/spend keys so the TEE gets detection only | ✅ Implemented in the extension; circuit already supported it |
| Extension contract deployed + registered on Coston2 | ✅ `0xDFF5e5AB…`, extension ID `0x10244` |
| Instruction round trip through the TEE | 🔜 Awaiting Flare C-chain indexer credentials |
| Hardware attestation (`SIMULATED_TEE=false`) | 🔜 Needs a GCP Confidential VM (AMD SEV) |
| Full on-chain ZK verification | 🔜 Needs native BN254 precompile on Flare |
| Production trusted setup (multi-party ceremony) | 🔜 Required before mainnet |
| Mobile wallet support | 🔜 WalletConnect v2 |

---

## License

MIT

---

*FlarePay — Privacy-preserving payments without compromise.*
*Submitted for Flare Summer Signal Hackathon 2026 · Running on Flare Coston2 Testnet.*
