// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title FlarePayInstructionSender
/// @notice On-chain entry point for FlarePay's confidential scanning extension.
///
/// Scanning for derived-address payments means trial-ECDH against every
/// announcement ever posted.
/// Doing that on a normal server would reveal to the operator exactly which
/// payments belong to whom — the one thing FlarePay exists to prevent. This
/// contract routes the work into a TEE instead.
///
/// The `sealedScanKey` below is public calldata, and that is fine by design:
/// it is ECIES ciphertext sealed to a keypair that only exists inside the
/// enclave. Anyone can read the bytes; only attested code can open them.
///
/// Note what is NOT sent: the spending key. The enclave is given `spendPub`,
/// the public half only, so it can recognise payments but can never move them.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract FlarePayInstructionSender {
    /// @notice Operation type for all FlarePay confidential actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_FLAREPAY = bytes32("FLAREPAY");

    /// @notice Command returning the enclave's public encryption key.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_GET_ENCLAVE_KEY = bytes32("GET_ENCLAVE_KEY");

    /// @notice Command running a confidential announcement scan.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SCAN = bytes32("SCAN");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Payload for the SCAN instruction.
    /// @dev Field order must match SCAN_PARAMS in extension/abi.ts exactly.
    struct ScanRequest {
        /// ECIES ciphertext of the 32-byte scan key, sealed to the enclave:
        /// ephPub(33) || iv(12) || tag(16) || ciphertext(32) = 93 bytes.
        bytes sealedScanKey;
        /// Compressed secp256k1 spending public key (33 bytes) — public half only.
        bytes spendPub;
        /// First announcement id to scan.
        uint256 fromId;
        /// How many announcements to scan, bounded by the extension.
        uint256 count;
    }

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Asks the enclave for the public key clients seal scan keys to.
    /// @dev Takes no payload. Call this first; seal against the returned key.
    function sendGetEnclaveKey() external payable {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_FLAREPAY,
            opCommand: OP_COMMAND_GET_ENCLAVE_KEY,
            message: bytes(""),
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    /// @notice Runs a confidential scan inside the TEE.
    /// @param _sealedScanKey ECIES-sealed 32-byte scan key (93 bytes).
    /// @param _spendPub Compressed spending public key (33 bytes).
    /// @param _fromId First announcement id to scan.
    /// @param _count How many announcements to scan.
    function sendScan(
        bytes calldata _sealedScanKey,
        bytes calldata _spendPub,
        uint256 _fromId,
        uint256 _count
    ) external payable {
        // Cheap shape checks so a malformed request fails here for a few
        // thousand gas rather than after a full round trip through the TEE.
        require(_sealedScanKey.length == 93, "sealedScanKey must be 93 bytes");
        require(_spendPub.length == 33, "spendPub must be 33 bytes");
        require(_count > 0, "count must be greater than zero");

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_FLAREPAY,
            opCommand: OP_COMMAND_SCAN,
            message: abi.encode(
                ScanRequest({
                    sealedScanKey: _sealedScanKey,
                    spendPub: _spendPub,
                    fromId: _fromId,
                    count: _count
                })
            ),
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
