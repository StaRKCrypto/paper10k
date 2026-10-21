// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {ILiquidationOracle} from "../src/ILiquidationOracle.sol";
import {ChainlinkPythOracle, IPythCore} from "../src/ChainlinkPythOracle.sol";

/// Models a pull oracle: a STORED price (what getPrice returns, possibly seconds old) and the full signed price HISTORY that a
/// filler can submit. fillPrice() mirrors Pyth parsePriceFeedUpdatesUnique: the FIRST published update in [minTs, maxTs].
/// `data[0]` = abi.encode(index into history) chosen by the caller; the uniqueness rule rejects any but the first.
contract PullOracleMock is IPriceOracle, ILiquidationOracle {
    struct U { uint64 t; uint256 px; }
    U[] public hist; uint256 public storedIdx;
    function publish(uint64 t, uint256 px) external { hist.push(U(t, px)); }
    function store(uint256 i) external { storedIdx = i; } // someone posted update i on-chain
    function getPrice(uint32) public view returns (uint256, uint64) { U memory u = hist[storedIdx]; return (u.px, u.t); }
    function getLiquidationPrice(uint32 m, bool) external view returns (uint256, uint64) { return getPrice(m); }
    function fillPrice(uint32, bytes[] calldata data, uint64 minTs, uint64 maxTs) external payable returns (uint256) {
        uint256 i = abi.decode(data[0], (uint256));
        U memory u = hist[i];
        uint64 prev = i == 0 ? 0 : hist[i - 1].t;
        require(minTs <= u.t && u.t <= maxTs && prev < minTs, "PriceFeedNotFoundWithinRange");
        return u.px;
    }
}

contract TwoStepTest is Base {
    PullOracleMock pm;

    function setUp() public override {
        super.setUp();
        pm = new PullOracleMock();
        vm.prank(owner); ex.setOracle(pm);
    }
    function _d(uint256 i) internal pure returns (bytes[] memory d) { d = new bytes[](1); d[0] = abi.encode(i); }

    /// SEC-3 exploit. Real price jumps +0.05% at t0+1 (e.g. Binance), the on-chain stored Pyth price is still the t0 one (within
    /// maxPriceAge). Attacker opens long at the stale stored price, posts the fresh update, closes. At 10000x that is a sure win.
    function _scenario() internal returns (uint64 t0) {
        t0 = uint64(vm.getBlockTimestamp());
        pm.publish(t0, P0);                       // 0: stored
        pm.publish(t0 + 1, P0 + P0 * 5 / 10_000); // 1: the move (+0.05%), not yet posted on-chain
        pm.publish(t0 + 2, P0 + P0 * 5 / 10_000); // 2
        pm.store(0);
    }

    function test_exploit_staleOpenFreshClose_profitableOnLegacyPath() public {
        uint64 t0 = _scenario();
        uint256 before = ex.free(alice);
        vm.prank(alice); uint256 id = ex.open(BTC, true, 1e6, 10_000, type(uint256).max); // fills at the stale P0
        vm.warp(t0 + 3); vm.roll(vm.getBlockNumber() + 1); pm.store(2);                         // attacker posts the fresh price
        vm.prank(alice); ex.close(id);
        assertGt(ex.free(alice), before, "legacy instant path: riskless profit (the bug)");
    }

    function test_exploit_blockedAfterFinalize_twoStepFillsAtFirstPriceAfterRequest() public {
        uint64 t0 = _scenario();
        vm.prank(owner); ex.finalize();
        // the instant paths are gone
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Final.selector); ex.open(BTC, true, 1e6, 10_000, type(uint256).max);
        uint256 before = ex.free(alice);
        vm.prank(alice); uint256 rid = ex.requestOpen(BTC, true, 1e6, 10_000, type(uint128).max);
        assertEq(ex.free(alice), before - 1e6); // margin locked at request: no free option to withdraw instead
        // filler cannot use the stale stored price (published before the request) nor skip to a later one
        vm.expectRevert(bytes("PriceFeedNotFoundWithinRange")); ex.fill(rid, _d(0));
        vm.expectRevert(bytes("PriceFeedNotFoundWithinRange")); ex.fill(rid, _d(2));
        vm.warp(t0 + 3); vm.roll(vm.getBlockNumber() + 1);
        ex.fill(rid, _d(1));                    // unique first price published at/after request + 1s: already contains the move
        uint256 id = ex.nextPositionId() - 1;
        (,,,,,,, uint128 entry,,) = ex.positions(id);
        assertEq(entry, P0 + P0 * 5 / 10_000);
        // close: also two-step; price unchanged => no profit (deadband), never a riskless win
        pm.publish(t0 + 10, P0 + P0 * 5 / 10_000);
        vm.warp(t0 + 8); vm.roll(vm.getBlockNumber() + 1);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Final.selector); ex.close(id);
        vm.prank(alice); ex.requestClose(id); uint256 rc = ex.closeReq(id);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Delay.selector); ex.requestClose(id); // one pending close only
        vm.warp(t0 + 11); vm.roll(vm.getBlockNumber() + 1);
        ex.fill(rc, _d(3));
        assertLe(ex.free(alice), before, "no riskless profit after the fix");
        _solvent();
    }

    function test_failedOpenFillRefundsAndCancelAfterTimeout() public {
        uint64 t0 = _scenario();
        vm.prank(owner); ex.finalize();
        uint256 before = ex.free(alice);
        // slippage bound below the fill price => fill succeeds as a tx but the open is refunded
        vm.prank(alice); uint256 rid = ex.requestOpen(BTC, true, 1e6, 10_000, P0);
        vm.warp(t0 + 3); vm.roll(vm.getBlockNumber() + 1);
        ex.fill(rid, _d(1));
        assertEq(ex.free(alice), before); assertEq(ex.totalMargin(), 0);
        // an unfillable request can only be cancelled after REQ_TIMEOUT, by anyone, refunding the trader
        vm.prank(alice); uint256 r2 = ex.requestOpen(BTC, true, 1e6, 10_000, type(uint128).max);
        vm.expectRevert(Paper10kExchange.TooSoon.selector); ex.cancelRequest(r2);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        vm.prank(bob); ex.cancelRequest(r2);
        assertEq(ex.free(alice), before);
        _solvent();
    }

    /// security item 3: after finalize nothing can pause closes, liquidations, withdrawals (no pause/emergency path at all)
    function test_afterFinalize_noPauseAndExitsAlwaysWork() public {
        vm.startPrank(owner);
        ex.setGuardian(keeper);
        ex.finalize();
        vm.expectRevert(Paper10kExchange.Final.selector); ex.pause();
        vm.expectRevert(Paper10kExchange.Final.selector); ex.unpause();
        vm.stopPrank();
        vm.prank(keeper); vm.expectRevert(Paper10kExchange.Final.selector); ex.pause();
        vm.prank(keeper); ex.haltOpens(); // only effect: new opens halted for 72h
        assertFalse(ex.paused());
        vm.prank(alice); ex.withdraw(1e6);
    }
}

contract MockPythU {
    IPythCore.Price public p; uint64 public prev;
    function set(int64 px, uint64 conf, uint256 t, uint64 prev_) external { p = IPythCore.Price(px, conf, -8, t); prev = prev_; }
    function getPriceUnsafe(bytes32) external view returns (IPythCore.Price memory) { return p; }
    function parsePriceFeedUpdatesUnique(bytes[] calldata, bytes32[] calldata ids, uint64 minT, uint64 maxT)
        external payable returns (IPythCore.PriceFeed[] memory f)
    {
        require(minT <= p.publishTime && p.publishTime <= maxT && prev < minT, "range");
        f = new IPythCore.PriceFeed[](1); f[0] = IPythCore.PriceFeed(ids[0], p, p);
    }
}
contract MockCL {
    int256 public a; uint256 public t;
    function set(int256 a_, uint256 t_) external { a = a_; t = t_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, a, t, t, 1); }
    function decimals() external pure returns (uint8) { return 8; }
}

/// fillPrice on the real adapter: Pyth unique price, Chainlink sanity bound, optional 3rd feed (e.g. RedStone push)
contract FillOracleTest is Base {
    function test_fillPrice_uniquePythBoundedByChainlinkAndThird() public {
        MockPythU py = new MockPythU(); MockCL cl = new MockCL(); MockCL rs = new MockCL();
        ChainlinkPythOracle o = new ChainlinkPythOracle(owner, address(py), address(0), 0);
        vm.prank(owner); o.configure(0, address(cl), 1 hours, bytes32(uint256(1)), 60, 100, 100);
        uint256 t = vm.getBlockTimestamp();
        py.set(100_000e8, 10e8, t, uint64(t - 5)); cl.set(100_100e8, t);
        bytes[] memory d = new bytes[](1);
        assertEq(o.fillPrice(0, d, uint64(t - 1), uint64(t + 10)), 100_000e18);
        vm.expectRevert(bytes("range")); o.fillPrice(0, d, uint64(t + 1), uint64(t + 10)); // not the first update in range
        cl.set(102_000e8, t); vm.expectRevert(bytes("dev")); o.fillPrice(0, d, uint64(t - 1), uint64(t + 10)); // >1% from Chainlink
        cl.set(100_000e8, t);
        vm.prank(owner); o.setThird(0, address(rs), 1 hours);
        rs.set(98_000e8, t); vm.expectRevert(bytes("dev3")); o.fillPrice(0, d, uint64(t - 1), uint64(t + 10));
        rs.set(100_050e8, t); assertEq(o.fillPrice(0, d, uint64(t - 1), uint64(t + 10)), 100_000e18);
        // liquidation needs all three to agree: the least favourable of (pyth, cl, third) for a long is the max
        (uint256 lp,) = o.getLiquidationPrice(0, true); assertEq(lp, 100_050e18);
        rs.set(100_050e8, t - 2 hours); (lp,) = o.getLiquidationPrice(0, true); assertEq(lp, 0); // stale 3rd => fail closed
        vm.prank(owner); o.finalizeBootstrap();
        vm.prank(owner); vm.expectRevert(bytes("final")); o.setThird(0, address(0), 1);
    }
}
