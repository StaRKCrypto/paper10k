// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "./IPriceOracle.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HyperCoreBboOracle — reads Hyperliquid best bid/offer mid via the HyperCore BBO read precompile.
/// @dev EXPERIMENTAL / UNTESTED ON-CHAIN: only works on HyperEVM (chain 998 testnet / 999 mainnet). The
///      precompile address (0x...080e) and return layout are taken from Hyperliquid docs and papertrade's docs
///      and MUST be verified against a live HyperEVM RPC before use (see MAINNET_LAUNCH.md). Unit tests here use a mock.
///      Precompile read: staticcall(abi.encode(uint32 asset)) -> abi.encode(uint64 bid, uint64 ask),
///      price scaled 10^(6 - szDecimals) for perps. We normalise to 1e18.
contract HyperCoreBboOracle is IPriceOracle, Ownable2Step {
    address public immutable precompile;
    mapping(uint32 => uint32) public assetIndex; // our market id -> HL perp asset index
    mapping(uint32 => uint8) public szDecimals;
    mapping(uint32 => bool) public configured;
    uint256 public maxSpreadBps = 50; // reject if (ask-bid)/mid > 0.5%: crossed/illiquid book

    event MarketConfigured(uint32 market, uint32 asset, uint8 szDec);

    constructor(address owner_, address precompile_) Ownable(owner_) {
        precompile = precompile_;
    }

    function configure(uint32 market, uint32 asset, uint8 szDec) external onlyOwner {
        require(szDec <= 6, "szDec");
        assetIndex[market] = asset;
        szDecimals[market] = szDec;
        configured[market] = true;
        emit MarketConfigured(market, asset, szDec);
    }

    function setMaxSpreadBps(uint256 b) external onlyOwner {
        require(b >= 1 && b <= 500, "spread");
        maxSpreadBps = b;
    }

    function getPrice(uint32 market) external view returns (uint256 price, uint64 updatedAt) {
        if (!configured[market]) return (0, 0);
        (bool ok, bytes memory ret) = precompile.staticcall(abi.encode(assetIndex[market]));
        if (!ok || ret.length < 64) return (0, 0);
        (uint64 bid, uint64 ask) = abi.decode(ret, (uint64, uint64));
        if (bid == 0 || ask == 0 || ask < bid) return (0, 0);
        uint256 mid2 = uint256(bid) + uint256(ask);
        if ((uint256(ask) - bid) * 20_000 > mid2 * maxSpreadBps) return (0, 0);
        uint256 scale = 10 ** (18 - (6 - szDecimals[market]));
        price = mid2 * scale / 2;
        updatedAt = uint64(block.timestamp); // precompile state is current-block
    }
}
