# FlarePay — Build Status

Written to be checkable, not flattering. Anything marked ✅ was verified by
running it; anything not verified is marked accordingly.

---

## ✅ Done and verified end to end

### Payments — the full flow works on live Coston2

A complete run of `npm run e2e` in `backend/` executes 14 steps against the real
network, no mocks: pay a one-time address → publish the announcement → read it
back from chain → scan locally → generate a Groth16 proof → verify → burn the
nullifier → sweep to the recipient's wallet → confirm the account is drained →
confirm a replayed proof is refused.

| Contract | Address |
| --- | --- |
| `DerivedRegistry` | [`0xd7931Df30821100BC7C9c161a691bCD70994B6AC`](https://coston2-explorer.flare.network/address/0xd7931Df30821100BC7C9c161a691bCD70994B6AC) |
| `ZKVerifier` | [`0x729991fBE0Fb0f0caF6E5b6Df39e85d416202bFa`](https://coston2-explorer.flare.network/address/0x729991fBE0Fb0f0caF6E5b6Df39e85d416202bFa) |

Of 1.0 C2FLR sent, 0.9811 reached the recipient; the rest is Coston2 gas.

### Privacy properties, enforced rather than promised

- **ZK proving runs in the browser.** No `POST /zk/prove` route exists — removed,
  not bypassed.
- **Scanning runs in the browser.** No `/address/scan` route exists.
- **No backend route accepts a private key of any kind.** `/address/claim`
  actively *rejects* a request carrying one, so an outdated client fails loudly
  rather than leaking a key into logs. The e2e suite asserts this every run.
- **The sweep is signed by the recipient**, in their own tab, reading every
  transaction field from chain state. The relayer only burns the nullifier and
  cannot move user funds.

### Frontend

Five pages (`/`, `/send`, `/receive`, `/prove`, `/history`), MetaMask via wagmi
with EIP-6963 discovery, in-browser Groth16 and ECDH scanning, consistent theme.
Builds clean.

### Circuits

Compiled artifacts committed. Trusted setup regenerated from scratch with
FlarePay-named contributions — no inherited ceremony history.

### Tests — 46 passing

| Suite | Result |
| --- | --- |
| `backend/tests/derived.test.js` | 15 passed |
| `frontend/tests/parity.test.ts` | 5 passed |
| `contracts` (Hardhat) | 12 passing |
| `tee/tests/crypto.test.ts` | 14 passed |

---

## ⚠️ Partially done — TEE / Confidential Compute

### ✅ What is real and verified

**The extension is deployed and registered on Coston2.**

| | |
| --- | --- |
| `FlarePayInstructionSender` | [`0xDFF5e5ABb54F258FBe1330204714CAAEB4262591`](https://coston2-explorer.flare.network/address/0xDFF5e5ABb54F258FBe1330204714CAAEB4262591) |
| Extension ID in `TeeExtensionRegistry` | `0x10244` |

Confirmed by reading the contract back on-chain rather than trusting the deploy
log: `OP_TYPE_FLAREPAY` decodes to `FLAREPAY`, `OP_COMMAND_SCAN` to `SCAN`, and
`OP_COMMAND_SAY_HELLO` reverts — proving the bytecode is this extension and not
the scaffold's Hello World demo.

Also verified: `forge build` clean (solc 0.8.35), `tsc --noEmit` clean against
the scaffold framework, Docker image builds (84.6 MB), container boots and serves
`GET /state` with a live enclave public key, and 14 unit tests covering ECIES
sealing plus the property that a scan key grants detection without spending
power.

**The indexer credential dependency was eliminated.** Flare's C-chain indexer is
open source; it is self-hosted here against Coston2, so no credentials from Flare
are required.

### ❌ What has NOT run

- **No instruction has ever reached the enclave.** The
  `sendScan` → `TeeExtensionRegistry` → data provider → `POST /action` round trip
  has not executed once.
- **No TEE machine is registered** — `post-build.sh` has not completed.
- **`test.sh` has not run.**
- **Hardware attestation is not used.** Configuration targets
  `SIMULATED_TEE=true`, Flare's documented Coston2 development mode: real
  contracts and relay, test code hash instead of an AMD SEV quote.

### The remaining blocker

The proxy refuses to act on stale data and needs a recent **FSP epoch event**
(signing policy / voter registration). Those fire once per reward epoch, not per
block — a 15-minute indexing window captured only 90 events across 31,000 blocks.

Root cause of the slowness: the public Coston2 RPC caps `eth_getLogs` at **30
blocks**, roughly 1,000× more round trips than a normal endpoint needs.

**To finish it:** point the indexer at a Coston2 RPC without that cap, set
`log_range` to match and `history_epochs = 3`, let the backfill complete, then run
`post-build.sh` and `test.sh`. Full detail in [`tee/README.md`](tee/README.md).

Note: `test.sh` will likely need its payloads adapted — its arguments were
written for the Hello World greeting demo and `sendScan` expects a 93-byte sealed
key and a 33-byte `spendPub`.

---

## ❌ Not done

- **Demo video.** Required for submission. Does not exist.
- **DoraHacks submission form.** Not filed.
- **Frontend does not invoke the TEE.** Scanning still runs in-browser. Wiring it
  is deliberately deferred until the proxy returns results — otherwise the UI
  would submit and hang.
- **Full on-chain ZK verification.** Needs a native BN254 precompile on Flare.
- **Production trusted setup.** The current ceremony is a single contribution,
  fine for testnet, not for mainnet.

---

## The honest one-line summary

A working, non-custodial private-payments system on Flare Coston2 with
browser-side ZK proving and scanning, verified end to end on the live network —
plus a Confidential Compute extension that is deployed and registered on-chain
with its logic unit-tested, but whose instruction round trip has not yet been
demonstrated.
