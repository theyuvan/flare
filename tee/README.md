# FlarePay Confidential Scanning — a Flare Compute Extension

A [Flare Compute Extension](https://dev.flare.network/fcc/overview) that performs
derived-address payment scanning inside a TEE, so a recipient can delegate the work
without revealing which payments are theirs.

---

## Status — what is deployed, and what has not run

**Deployed and registered on Flare Coston2:**

| | |
| --- | --- |
| `FlarePayInstructionSender` | [`0xDFF5e5ABb54F258FBe1330204714CAAEB4262591`](https://coston2-explorer.flare.network/address/0xDFF5e5ABb54F258FBe1330204714CAAEB4262591) |
| Extension ID in `TeeExtensionRegistry` | `0x10244` |

Verified by reading the contract back on-chain, not by trusting the deploy log:
`OP_TYPE_FLAREPAY` → `FLAREPAY`, `OP_COMMAND_SCAN` → `SCAN`,
`OP_COMMAND_GET_ENCLAVE_KEY` → `GET_ENCLAVE_KEY`, and `OP_COMMAND_SAY_HELLO`
reverts — proving the bytecode is this contract and not the scaffold's demo.

**Verified locally:**

| Check | Result |
| --- | --- |
| `npm test` (this directory) | 14 passed / 0 failed |
| `forge build` against the scaffold | clean, solc 0.8.35 |
| `tsc --noEmit` against the scaffold framework | clean |
| `docker build` | `flarepay-ext:latest`, 84.6 MB |
| Container boots and serves `GET /state` | returns a live enclave public key and zeroed counters |

**What has NOT run — stated plainly:**

- **No instruction has ever been relayed to the enclave.** The
  `sendScan` → `TeeExtensionRegistry` → data provider → `POST /action` round
  trip has not been executed end to end.
- **No `SCAN` has executed via the on-chain path.** The scanning logic is
  covered by unit tests and the handler responds in-container, but it has not
  been driven by a real instruction.
- **No TEE machine is registered** for this extension (`post-build` not run).
- **The proxy has never started** — it requires Flare C-chain indexer database
  credentials (see below).
- **Hardware attestation has not been used.** Even the simulated path has not
  completed a round trip.

So the accurate claim is: *the extension is deployed and registered on Coston2,
and the container builds and runs; the instruction round trip is not yet
demonstrated.* Anything stronger than that would be false.

---

## Why this needs a TEE

Finding your payments means trial-ECDH against **every announcement ever
posted**. In the browser that is private but linear — at scale, a phone grinds.

Handing your key to an ordinary server makes it fast and tells the operator
exactly which payments you own. That is precisely the linkability FlarePay
exists to destroy, so the obvious optimisation is the one thing we cannot do.

A TEE is the only construction that gives both: the scan key is sealed to a
keypair that exists solely inside the enclave, matching happens in enclave
memory, and **only the matching announcement ids come back out**. The operator
sees ciphertext going in and integers coming out.

This is not a TEE bolted onto a design that did not need one. It is the specific
operation in FlarePay that cryptography alone cannot make both private and fast.

---

## The security property that matters

**Scanning grants detection, never spending.**

FlarePay's Circom circuit already takes `scanPriv` and `spendPriv` as separate
signals — today the app passes `metaPriv` for both. Scanning only ever needs the
scan half, so the enclave receives:

| Sent to enclave | Withheld |
| --- | --- |
| `scanPriv`, ECIES-sealed | `spendPriv` — never leaves the device |
| `spendPub` — public half only | |

The enclave can compute `h = SHA256(scanPriv · R)` and test
`spendPub + h·G == derivedAddress`. Deriving the key that actually controls the
funds requires `spendPriv + h`, and it does not have `spendPriv`.

**A total compromise of this extension costs users their privacy for the
delegated window. It can never cost them funds.** `tests/crypto.test.ts` asserts
this directly rather than leaving it as a claim.

Because the maths reduces to the current single-key behaviour when
`scanPriv == spendPriv`, the extension scans announcements **already on chain**
without any migration.

---

## Architecture

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

The scan key is public calldata **as ciphertext** — anyone can read the bytes,
only attested code can open them.

Announcements are fetched by the enclave over RPC rather than passed in
calldata: the list is public and large, and paying for it per scan would be
absurd. Only the key needs confidentiality.

---

## Operations

| opType | opCommand | Payload | Returns |
| --- | --- | --- | --- |
| `FLAREPAY` | `GET_ENCLAVE_KEY` | none | `{ enclavePubKey, algorithm }` |
| `FLAREPAY` | `SCAN` | `abi.encode(ScanRequest)` | `{ total, scanned, matches[] }` |

`ScanRequest` is `(bytes sealedScanKey, bytes spendPub, uint256 fromId, uint256 count)`.
The sealed blob is exactly 93 bytes: `ephPub(33) ‖ iv(12) ‖ tag(16) ‖ ct(32)`.

> The op strings in [`extension/config.ts`](extension/config.ts) must match the
> `bytes32` constants in
> [`contracts/FlarePayInstructionSender.sol`](contracts/FlarePayInstructionSender.sol)
> byte-for-byte. A mismatch surfaces at runtime as `unsupported op type`, never
> at compile time — treat the two files as one unit.

---

## Files

| File | Role |
| --- | --- |
| `extension/config.ts` | Op identifiers, registry address, batch limit |
| `extension/crypto.ts` | ECIES sealing + the scan matching maths |
| `extension/abi.ts` | `ScanRequest` decoder |
| `extension/registry.ts` | Reads announcements from `DerivedRegistry` |
| `extension/handlers.ts` | The two handlers — main customization point |
| `contracts/FlarePayInstructionSender.sol` | On-chain entry point |
| `tests/crypto.test.ts` | 14 tests, incl. the no-spending-power property |

---

## Running it

Tests need nothing but this directory:

```bash
cd tee && npm install && npm test
# 14 passed / 0 failed
```

Running the extension for real uses Flare's scaffold, which supplies the TEE
node, proxy and deployment scripts:

```bash
git clone https://github.com/flare-foundation/fce-extension-scaffold.git
cd fce-extension-scaffold

# 1. handlers
cp ../flare/tee/extension/*.ts typescript/src/app/

# 2. contract — REPLACE the scaffold's file, do not copy alongside it.
#    The deploy pipeline is hardcoded to contracts/InstructionSender.sol.
cp ../flare/tee/contracts/FlarePayInstructionSender.sol contracts/InstructionSender.sol

# 3. dependencies the scaffold does not ship — without these `tsc` fails with
#    "Cannot find module '@noble/curves/secp256k1.js'"
cd typescript && npm install @noble/curves@^2.2.0 @noble/hashes@^2.2.0 && cd ..

# 4. repoint the Go binding generator at our contract type
sed -i 's/HelloWorldInstructionSender/FlarePayInstructionSender/g'   scripts/generate-bindings.sh   tools/pkg/contracts/helloworld/helloworld.go   tools/pkg/utils/instructions.go

# 5. the Go helpers call the Hello World entry points; point them at ours
sed -i 's/sender\.SendSayHello(opts, message)/sender.SendGetEnclaveKey(opts)/' tools/pkg/utils/instructions.go
sed -i 's/parsed\.Pack("sendSayHello", message)/parsed.Pack("sendGetEnclaveKey")/' tools/pkg/utils/instructions.go
sed -i 's/sender\.SendSayGoodbye(opts, name, reason)/sender.SendScan(opts, []byte(name), []byte(reason), big.NewInt(0), big.NewInt(50))/' tools/pkg/utils/instructions.go

# 6. the scaffold's example tests target the handlers we replaced
rm -f typescript/src/__tests__/handlers.test.ts

cp .env.example .env      # LANGUAGE=typescript, plus a funded DEPLOYMENT_PRIVATE_KEY
./scripts/pre-build.sh    # deploy + register — works without indexer credentials
```

### Three traps, all silent

Steps 2, 4 and 5 exist because each of these **succeeds while deploying the
wrong contract**. Learned the hard way — it took three deploys to Coston2
before the right bytecode landed.

| Trap | Symptom |
| --- | --- |
| Copying the contract alongside `InstructionSender.sol` | Deploys Hello World. Prints a real address. Looks perfect. |
| Changing only `CONTRACT_NAME` in `generate-bindings.sh` | Still Hello World — `tools/pkg/contracts/helloworld/helloworld.go` has `--type=HelloWorldInstructionSender` baked into its `go:generate` directive |
| Repointing the bindings but not the helpers | Fails loudly: `sender.SendSayHello undefined` |

**Always verify what actually landed** rather than trusting the deploy log:

```bash
cast call <address> "OP_TYPE_FLAREPAY()(bytes32)" --rpc-url https://coston2-api.flare.network/ext/C/rpc
# must decode to FLAREPAY; and OP_COMMAND_SAY_HELLO() must revert
```

**Prerequisites:** Docker, Foundry (`forge`), `jq`, Go 1.25+, and a public HTTPS
tunnel (ngrok or cloudflared).

**One external dependency:** the proxy needs **Flare C-chain indexer database
credentials**, requested from
[Flare support](https://flare.network/resources/technical-support) or
[@FlareDevs](https://x.com/FlareDevs). There is no allowlisting for Coston2
otherwise, but without indexer access the proxy cannot follow the chain.

---

## Attestation status — read this before trusting anything

The scaffold has two independent flags, and conflating them is how projects
overclaim:

| Flag | Meaning |
| --- | --- |
| `LOCAL_MODE=false` | Live network. Real contracts, real registry, real relay. |
| `SIMULATED_TEE=true` | **Test code hash instead of hardware attestation.** |

Flare's own `.env.example` ships `LOCAL_MODE=false` with `SIMULATED_TEE=true` as
the documented **Coston2 development configuration**, and the FCC docs state the
protocol "is in the final stages of development and is not yet a fully public
production system."

So, stated plainly:

> The extension runs on Coston2 with `SIMULATED_TEE=true`. The Solidity
> contract, the instruction flow through `TeeExtensionRegistry`, the data-provider
> relay, the TEE node and the proxy are all live. **Hardware attestation is
> stubbed with a test code hash** pending Confidential VM provisioning; set
> `SIMULATED_TEE=false` on a GCP Confidential VM (AMD SEV) for a genuine quote.

**What this means for the threat model:** in simulated mode the enclave keypair
is not hardware-protected, so a malicious operator could substitute their own key
and read scan keys. **Do not seal a scan key you actually rely on until running
under real attestation**, and bind the key returned by `GET_ENCLAVE_KEY` to the
attestation quote before trusting it.

The enclave keypair is generated in memory at first use and never persisted.
Restarting rotates it — deliberately, so keys sealed to an old instance cannot be
opened by a new one.

---

## What the enclave deliberately does not keep

`GET /state` exposes aggregate counters only — no keys, no matches, no requester
identity. State is public; anything recorded there would rebuild the linkability
this removes. Per-user scan history is not stored anywhere, in memory or on disk.
