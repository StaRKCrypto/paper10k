// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "./IPriceOracle.sol";
import {ILiquidationOracle} from "./ILiquidationOracle.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAggV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}
interface IPythCore {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @title ChainlinkPythOracle — drop-in replacement for HyperCoreOracle on generic EVM L2s (Base, Robinhood Chain).
/// @notice Same interfaces as HyperCoreOracle (IPriceOracle + ILiquidationOracle); Paper10kExchange's two-block
///         mark -> liquidate persistence rule is untouched (it lives in the exchange).
///   s1 = Pyth Core (pull; a keeper/frontend posts updatePriceFeeds in the same block or just before) — fast source.
///   s2 = Chainlink Data Feed (push; heartbeat/deviation) — independent, slower sanity source.
///   getPrice: s1, only if fresh, conf-bounded and within maxDevBps of a fresh s2. Fails closed (0,0).
///   getLiquidationPrice: BOTH sources must be fresh; returns the one least favourable to liquidation
///   (long => max, short => min), i.e. both must agree the position is bust.
///   Optional Chainlink L2 sequencer-uptime gate (Base has one; Robinhood Chain: none published at time of writing => address(0)).
/// @dev UNAUDITED. Config is instant only before finalizeBootstrap(); afterwards immutable (redeploy + exchange proposeOracle to change).
contract ChainlinkPythOracle is IPriceOracle, ILiquidationOracle, Ownable2Step {
    struct Mkt { IAggV3 cl; uint32 clMaxAge; bytes32 pythId; uint32 pythMaxAge; uint16 maxDevBps; uint16 maxConfBps; bool on; }
    IPythCore public immutable pyth;
    IAggV3 public immutable sequencerFeed; // 0 => no gate
    uint32 public immutable seqGrace;
    bool public bootstrapped;
    mapping(uint32 => Mkt) public mkt;

    event MarketConfigured(uint32 indexed market, address cl, bytes32 pythId);
    event BootstrapFinalized();

    constructor(address owner_, address pyth_, address seqFeed_, uint32 seqGrace_) Ownable(owner_) {
        require(pyth_ != address(0), "pyth");
        pyth = IPythCore(pyth_); sequencerFeed = IAggV3(seqFeed_); seqGrace = seqGrace_;
    }

    function configure(uint32 market, address cl, uint32 clMaxAge, bytes32 pythId, uint32 pythMaxAge, uint16 maxDevBps, uint16 maxConfBps)
        external onlyOwner
    {
        require(!bootstrapped, "final");
        require(cl != address(0) && pythId != bytes32(0), "src");
        require(clMaxAge > 0 && clMaxAge <= 2 days && pythMaxAge > 0 && pythMaxAge <= 120, "age");
        require(maxDevBps >= 1 && maxDevBps <= 1000 && maxConfBps >= 1 && maxConfBps <= 500, "bps");
        mkt[market] = Mkt(IAggV3(cl), clMaxAge, pythId, pythMaxAge, maxDevBps, maxConfBps, true);
        emit MarketConfigured(market, cl, pythId);
    }
    function finalizeBootstrap() external onlyOwner { bootstrapped = true; emit BootstrapFinalized(); }

    function _seqOk() internal view returns (bool) {
        if (address(sequencerFeed) == address(0)) return true;
        try sequencerFeed.latestRoundData() returns (uint80, int256 st, uint256 startedAt, uint256, uint80) {
            return st == 0 && startedAt != 0 && block.timestamp > startedAt + seqGrace;
        } catch { return false; }
    }
    function _cl(Mkt memory m) internal view returns (uint256 px, uint64 ts) {
        try m.cl.latestRoundData() returns (uint80, int256 a, uint256, uint256 upd, uint80) {
            if (a <= 0 || upd == 0 || upd > block.timestamp || block.timestamp - upd > m.clMaxAge) return (0, 0);
            uint8 d = m.cl.decimals();
            if (d > 18) return (0, 0);
            return (uint256(a) * 10 ** (18 - d), uint64(upd));
        } catch { return (0, 0); }
    }
    function _py(Mkt memory m) internal view returns (uint256 px, uint64 ts) {
        try pyth.getPriceUnsafe(m.pythId) returns (IPythCore.Price memory p) {
            if (p.price <= 0 || p.expo > 0 || p.expo < -18) return (0, 0);
            if (p.publishTime > block.timestamp || block.timestamp - p.publishTime > m.pythMaxAge) return (0, 0);
            uint256 raw = uint256(uint64(p.price));
            if (uint256(p.conf) * 10_000 > raw * m.maxConfBps) return (0, 0);
            return (raw * 10 ** uint256(int256(18) + int256(p.expo)), uint64(p.publishTime));
        } catch { return (0, 0); }
    }
    function _both(uint32 market) internal view returns (bool ok, uint256 s1, uint256 s2, uint64 t1) {
        Mkt memory m = mkt[market];
        if (!m.on || !_seqOk()) return (false, 0, 0, 0);
        (s1, t1) = _py(m); (s2,) = _cl(m);
        if (s1 == 0 || s2 == 0) return (false, 0, 0, 0);
        uint256 dd = s1 > s2 ? s1 - s2 : s2 - s1;
        ok = dd * 10_000 <= s2 * m.maxDevBps;
    }

    function getPrice(uint32 market) external view returns (uint256 price, uint64 updatedAt) {
        (bool ok, uint256 s1,, uint64 t1) = _both(market);
        if (!ok) return (0, 0);
        return (s1, t1);
    }

    function getLiquidationPrice(uint32 market, bool forLong) external view returns (uint256 price, uint64 updatedAt) {
        (bool ok, uint256 s1, uint256 s2, uint64 t1) = _both(market);
        if (!ok) return (0, 0);
        price = forLong ? (s1 > s2 ? s1 : s2) : (s1 < s2 ? s1 : s2);
        updatedAt = t1;
    }
}
