pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

/*
 * DerivedOwnership
 *
 * Proves:
 *   1. The prover knows (scanPriv, spendPriv) whose Poseidon hash equals
 *      metaCommitment — i.e. they control the meta-address.
 *   2. The nullifier was honestly computed as Poseidon(scanPriv, context),
 *      preventing the same identity from submitting duplicate proofs.
 *
 * Private inputs  → never leave the user's device
 * Public inputs   → go on-chain with the proof
 */
template DerivedOwnership() {
    // ── Private (witness) ──────────────────────────────────────────────────
    signal input scanPriv;      // scan private key  (ks)  — kept secret
    signal input spendPriv;     // spend private key (ksp) — kept secret

    // ── Public ─────────────────────────────────────────────────────────────
    signal input metaCommitment;  // Poseidon(scanPriv, spendPriv) — identity anchor
    signal input nullifier;       // Poseidon(scanPriv, context)   — anti-replay token
    signal input context;         // e.g. Poseidon(chainId, roundId) — supplied by verifier

    // ── Constraint 1: meta-address commitment ──────────────────────────────
    // Proves the prover knows BOTH private keys that make up the meta-address.
    component metaHash = Poseidon(2);
    metaHash.inputs[0] <== scanPriv;
    metaHash.inputs[1] <== spendPriv;
    metaHash.out === metaCommitment;

    // ── Constraint 2: nullifier correctness ────────────────────────────────
    // Proves the nullifier was computed from THIS prover's scan key + the
    // public context.  On-chain, the contract stores nullifiers to prevent
    // the same identity from claiming twice.
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== scanPriv;
    nullHash.inputs[1] <== context;
    nullHash.out === nullifier;
}

component main {public [metaCommitment, nullifier, context]} = DerivedOwnership();
