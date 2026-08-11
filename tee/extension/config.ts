/**
 * Operation identifiers for the FlarePay confidential scanning extension.
 *
 * These strings MUST match the bytes32 constants in
 * contracts/FlarePayInstructionSender.sol byte-for-byte. Solidity stores them
 * as bytes32("..."); the framework hashes the same strings. A mismatch surfaces
 * at runtime as "unsupported op type", not at compile time — so treat this file
 * and the contract as one unit.
 */

export const VERSION = "0.1.0";

export const OP_TYPE_FLAREPAY = "FLAREPAY";

/** Returns the enclave's public encryption key. Takes no payload. */
export const OP_COMMAND_GET_ENCLAVE_KEY = "GET_ENCLAVE_KEY";

/** Scans announcements for payments belonging to an encrypted scan key. */
export const OP_COMMAND_SCAN = "SCAN";

/**
 * Coston2 deployment of DerivedRegistry — the announcement source the enclave
 * reads. Overridable so the same image can run against a local chain.
 */
export const REGISTRY_ADDRESS =
  process.env.FLAREPAY_REGISTRY_ADDRESS ?? "0xd7931Df30821100BC7C9c161a691bCD70994B6AC";

export const CHAIN_RPC_URL =
  process.env.FLAREPAY_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

/** Upper bound on announcements scanned in one instruction, to bound runtime. */
export const MAX_SCAN_BATCH = 500;
