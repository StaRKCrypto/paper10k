// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "./IPriceOracle.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IPythLike {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @title PythReference — READ-ONLY adapter over an already-posted Pyth price (never accepts updates, so users cannot choose among signed prices).
/// @dev Intended only as the optional second reference of HyperCoreOracle. Someone (a keeper) must keep Pyth updated; if not, the
///      reference goes stale and trading halts (fail closed). UNVERIFIED on-chain: the Pyth HyperEVM address must be confirmed from
///      docs.pyth.network (docs list it truncated as 0x298B…BbC02) and the ABI (`getPriceUnsafe`) tested on a fork before use.
///      Confidence interval wider than maxConfBps of price => no price.
contract PythReference is IPriceOracle, Ownable2Step {
    IPythLike public immutable pyth;
    mapping(uint32 => bytes32) public feedId;
    uint256 public maxConfBps = 50;

    constructor(address owner_, address pyth_) Ownable(owner_) { require(pyth_ != address(0), "pyth"); pyth = IPythLike(pyth_); }

    function setFeed(uint32 market, bytes32 id) external onlyOwner { feedId[market] = id; }
    function setMaxConfBps(uint256 b) external onlyOwner { require(b >= 1 && b <= 500, "bps"); maxConfBps = b; }

    function getPrice(uint32 market) external view returns (uint256, uint64) {
        bytes32 id = feedId[market];
        if (id == bytes32(0)) return (0, 0);
        try pyth.getPriceUnsafe(id) returns (IPythLike.Price memory p) {
            if (p.price <= 0 || p.expo > 0 || p.expo < -18) return (0, 0);
            uint256 px = uint256(uint64(p.price));
            if (uint256(p.conf) * 10_000 > px * maxConfBps) return (0, 0);
            uint256 scale = 10 ** uint256(int256(18) + int256(p.expo));
            if (p.publishTime > type(uint64).max) return (0, 0);
            return (px * scale, uint64(p.publishTime));
        } catch { return (0, 0); }
    }
}
