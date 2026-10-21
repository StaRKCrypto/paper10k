// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRektSource { function rektCount(address user) external view returns (uint256); }

/// @title RektBadges — soulbound achievement NFTs for PAPER10K liquidations. No cash value, not transferable, no admin.
/// @notice Trustless: eligibility is read from `exchange.rektCount(user)`, which only the exchange's liquidation path increments.
///         Anyone (the user, a keeper, a frontend) may call `claim(user, tier)`; the badge always goes to `user`.
///         Tiers: 0 = first rekt (1), 1 = 10 rekts, 2 = 100 rekts, 3 = 1,000 rekts. tokenId = (uint160(user) << 8) | tier.
contract RektBadges is ERC721 {
    using Strings for uint256;
    IRektSource public immutable exchange;
    uint8 public constant TIERS = 4;

    error Soulbound(); error BadTier(); error NotEligible();

    constructor(IRektSource ex) ERC721("PAPER10K Rekt", "REKT") { exchange = ex; }

    function threshold(uint8 tier) public pure returns (uint256) {
        if (tier >= TIERS) revert BadTier();
        return 10 ** tier;
    }
    function tokenIdOf(address user, uint8 tier) public pure returns (uint256) { return (uint256(uint160(user)) << 8) | tier; }
    function eligible(address user, uint8 tier) public view returns (bool) { return exchange.rektCount(user) >= threshold(tier); }

    function claim(address user, uint8 tier) external returns (uint256 id) {
        if (!eligible(user, tier)) revert NotEligible();
        id = tokenIdOf(user, tier);
        _mint(user, id); // reverts if already claimed
    }

    /// @dev soulbound: only mint (from == 0) is allowed; no transfers, no burns
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
    function approve(address, uint256) public pure override { revert Soulbound(); }
    function setApprovalForAll(address, bool) public pure override { revert Soulbound(); }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        uint8 tier = uint8(id & 0xff);
        string[4] memory names = ["First Rekt", "Rekt x10", "Rekt x100", "Rekt x1000"];
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#0b0b0f"/>',
            '<text x="200" y="170" fill="#ff3355" font-family="monospace" font-size="44" text-anchor="middle">REKT</text>',
            '<text x="200" y="230" fill="#ffffff" font-family="monospace" font-size="26" text-anchor="middle">', names[tier], '</text>',
            '<text x="200" y="300" fill="#888" font-family="monospace" font-size="14" text-anchor="middle">PAPER10K - soulbound - no value</text></svg>');
        string memory json = string.concat('{"name":"PAPER10K ', names[tier], '","description":"Soulbound liquidation achievement. No cash value.",',
            '"attributes":[{"trait_type":"threshold","value":', threshold(tier).toString(), '}],"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
