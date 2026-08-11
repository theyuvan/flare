'use strict'
// Minimal ABIs — only the functions this backend calls. Kept in their own
// module so contracts/test can assert they still match the compiled artifacts.

const REGISTRY_ABI = [
  'function announce(bytes derivedAddress, bytes ephemeralR) external returns (uint256 id)',
  'function getCount() external view returns (uint256)',
  'function getAnnouncements(uint256 from, uint256 count) external view returns (tuple(uint256 id, bytes derivedAddress, bytes ephemeralR, address sender, uint256 timestamp)[])',
]

const VERIFIER_ABI = [
  'function registerProof(bytes32 metaCommitment, bytes32 nullifier, bytes32 context, bytes32 proofHash) external',
  'function isNullifierUsed(bytes32 nullifier) external view returns (bool)',
]

module.exports = { REGISTRY_ABI, VERIFIER_ABI }
