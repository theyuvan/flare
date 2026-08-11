// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DerivedRegistry — on-chain announcement store for derived payments.
/// @notice Senders post (derivedAddress, ephemeralR) after paying a one-time
///         derived account. Recipients scan the full list locally with their
///         private key; nothing here identifies a recipient.
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
