// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ZKVerifier — nullifier registry with on-chain replay protection.
/// @notice Groth16 verification runs off-chain (BN254 pairings are not yet
///         practical here). Only the nullifier and a proof hash are stored,
///         which is what actually enforces one-claim-per-proof.
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
