// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "./IPriceOracle.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HyperCoreOracle — pull-free oracle for HyperEVM (chain 998 testnet / 999 mainnet)
/// @notice Primary price = midpoint of the Hyperliquid best bid/offer, read from the HyperCore BBO read precompile.
///         The precompile reflects HyperCore state as of the current EVM block, so nothing is posted by any party and there
///         is no mempool-visible price update to front-run.
///         Guards (all fail CLOSED: getPrice returns (0,0) and the exchange refuses to trade):
///          1. precompile call must succeed and return a sane book (bid>0, ask>=bid)
///          2. book spread <= maxSpreadBps (crossed/illiquid/manipulated thin book)
///          3. BBO mid must be within maxDevBps of HyperCore's own oracle price (precompile 0x…0807, computed from external venues)
///          4. OPTIONAL second reference (e.g. a Pyth/Chainlink adapter implementing IPriceOracle): must be fresh (<= refMaxAge)
///             and within maxRefDevBps of the mid.
/// @dev VERIFIED against live HyperEVM RPCs on 2026-10-17 (mainnet 999 + testnet 998): 0x…080e returns abi.encode(uint64 bid,uint64 ask)
///      for a uint input, 0x…0807 returns uint64; prices are scaled 10^(6 - szDecimals) (BTC szDecimals=5, ETH=4).
///      Precompiles revert on invalid assets; we staticcall and treat failure as "no price".
contract HyperCoreOracle is IPriceOracle, Ownable2Step {
    address public immutable bboPrecompile;
    address public immutable oraclePxPrecompile;

    struct Mkt { uint32 asset; uint8 szDec; bool on; }
    mapping(uint32 => Mkt) public mkt;
    uint256 public maxSpreadBps = 30;   // 0.30% book spread
    uint256 public maxDevBps = 100;     // 1.00% mid vs HL oraclePx
    IPriceOracle public refOracle;      // optional extra reference (0 = none)
    uint256 public maxRefDevBps = 100;
    uint64 public refMaxAge = 30;

    // ---- v3: governance of the oracle itself is timelocked (audit v3 finding F1). `configure`/`setGuards` used to be instant, which let an
    // oracle owner remap a market to a different HyperCore asset (or loosen guards) with no notice, bypassing the exchange timelock.
    // Bootstrap window: until `finalizeBootstrap()` the owner may configure instantly (exchange is deployed paused, so nobody is exposed).
    // After it (one-way) every change goes through propose* -> wait `delay` -> apply*.
    uint64 public immutable delay;
    bool public bootstrapped;
    struct PendingMkt { uint32 asset; uint8 szDec; uint64 at; bool set; }
    mapping(uint32 => PendingMkt) public pendingMkt;
    struct PendingGuards { uint256 spreadBps; uint256 devBps; IPriceOracle ref; uint256 refDevBps; uint64 refAge; uint64 at; bool set; }
    PendingGuards public pendingGuards;
    event BootstrapFinalized();
    event MarketProposed(uint32 market, uint32 asset, uint8 szDec, uint64 effectiveAt);
    event GuardsProposed(uint64 effectiveAt);

    event MarketConfigured(uint32 market, uint32 asset, uint8 szDec);
    event GuardsSet(uint256 spreadBps, uint256 devBps, address ref, uint256 refDevBps, uint64 refAge);

    constructor(address owner_, address bbo_, address oraclePx_, uint64 delay_) Ownable(owner_) {
        require(bbo_ != address(0) && oraclePx_ != address(0), "precompile");
        require(delay_ >= 5 minutes, "delay");
        delay = delay_;
        bboPrecompile = bbo_;
        oraclePxPrecompile = oraclePx_;
    }

    function finalizeBootstrap() external onlyOwner { bootstrapped = true; emit BootstrapFinalized(); }

    /// @dev instant, bootstrap only
    function configure(uint32 market, uint32 asset, uint8 szDec) external onlyOwner {
        require(!bootstrapped, "timelocked");
        _configure(market, asset, szDec);
    }
    function _configure(uint32 market, uint32 asset, uint8 szDec) internal {
        require(szDec <= 6, "szDec");
        mkt[market] = Mkt(asset, szDec, true);
        emit MarketConfigured(market, asset, szDec);
    }
    function proposeMarket(uint32 market, uint32 asset, uint8 szDec) external onlyOwner {
        require(szDec <= 6, "szDec");
        uint64 at = uint64(block.timestamp) + delay;
        pendingMkt[market] = PendingMkt(asset, szDec, at, true);
        emit MarketProposed(market, asset, szDec, at);
    }
    function applyMarket(uint32 market) external onlyOwner {
        PendingMkt memory p = pendingMkt[market];
        require(p.set && block.timestamp >= p.at, "delay");
        delete pendingMkt[market];
        _configure(market, p.asset, p.szDec);
    }
    function cancelMarket(uint32 market) external onlyOwner { delete pendingMkt[market]; }

    function _checkGuards(uint256 spreadBps, uint256 devBps, uint256 refDevBps, uint64 refAge) internal pure {
        require(spreadBps >= 1 && spreadBps <= 200 && devBps >= 10 && devBps <= 500, "bps");
        require(refDevBps >= 10 && refDevBps <= 500 && refAge >= 5 && refAge <= 600, "ref");
    }
    function _setGuards(uint256 spreadBps, uint256 devBps, IPriceOracle ref, uint256 refDevBps, uint64 refAge) internal {
        _checkGuards(spreadBps, devBps, refDevBps, refAge);
        maxSpreadBps = spreadBps; maxDevBps = devBps; refOracle = ref; maxRefDevBps = refDevBps; refMaxAge = refAge;
        emit GuardsSet(spreadBps, devBps, address(ref), refDevBps, refAge);
    }
    /// @dev instant, bootstrap only
    function setGuards(uint256 spreadBps, uint256 devBps, IPriceOracle ref, uint256 refDevBps, uint64 refAge) external onlyOwner {
        require(!bootstrapped, "timelocked");
        _setGuards(spreadBps, devBps, ref, refDevBps, refAge);
    }
    function proposeGuards(uint256 spreadBps, uint256 devBps, IPriceOracle ref, uint256 refDevBps, uint64 refAge) external onlyOwner {
        _checkGuards(spreadBps, devBps, refDevBps, refAge);
        uint64 at = uint64(block.timestamp) + delay;
        pendingGuards = PendingGuards(spreadBps, devBps, ref, refDevBps, refAge, at, true);
        emit GuardsProposed(at);
    }
    function applyGuards() external onlyOwner {
        PendingGuards memory g = pendingGuards;
        require(g.set && block.timestamp >= g.at, "delay");
        delete pendingGuards;
        _setGuards(g.spreadBps, g.devBps, g.ref, g.refDevBps, g.refAge);
    }
    function cancelGuards() external onlyOwner { delete pendingGuards; }

    function _read(address pc, uint32 asset) internal view returns (bool ok, bytes memory ret) {
        (ok, ret) = pc.staticcall(abi.encode(uint256(asset)));
    }

    /// @dev returns 2*mid in precompile units, or 0 if any guard fails
    function _guardedMid2(Mkt memory m) internal view returns (uint256) {
        (bool ok, bytes memory ret) = _read(bboPrecompile, m.asset);
        if (!ok || ret.length < 64) return 0;
        (uint64 bid, uint64 ask) = abi.decode(ret, (uint64, uint64));
        if (bid == 0 || ask < bid) return 0;
        uint256 mid2 = uint256(bid) + uint256(ask);
        if ((uint256(ask) - bid) * 20_000 > mid2 * maxSpreadBps) return 0;
        (bool ok2, bytes memory r2) = _read(oraclePxPrecompile, m.asset);
        if (!ok2 || r2.length < 32) return 0;
        uint256 o2 = uint256(abi.decode(r2, (uint64))) * 2;
        if (o2 == 0) return 0;
        uint256 d = mid2 > o2 ? mid2 - o2 : o2 - mid2;
        if (d * 10_000 > o2 * maxDevBps) return 0;
        return mid2;
    }

    function _refOk(uint32 market, uint256 price) internal view returns (bool) {
        IPriceOracle ro = refOracle;
        if (address(ro) == address(0)) return true;
        (uint256 rp, uint64 rts) = ro.getPrice(market);
        if (rp == 0 || rts + refMaxAge < block.timestamp || rts > block.timestamp + 10) return false;
        uint256 dd = price > rp ? price - rp : rp - price;
        return dd * 10_000 <= rp * maxRefDevBps;
    }

    function getPrice(uint32 market) external view returns (uint256 price, uint64 updatedAt) {
        Mkt memory m = mkt[market];
        if (!m.on) return (0, 0);
        uint256 mid2 = _guardedMid2(m);
        if (mid2 == 0) return (0, 0);
        price = mid2 * (10 ** (12 + m.szDec)) / 2;
        if (!_refOk(market, price)) return (0, 0);
        updatedAt = uint64(block.timestamp);
    }
}
