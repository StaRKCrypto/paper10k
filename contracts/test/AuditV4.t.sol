// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";

/// Regression + fuzz tests for audit v4 (AI review): liquidation persistence, multi-source liquidation price, F8 close path, F7 reserved liability.
contract AuditV4Test is Base {
    uint256 constant BUST10K = 9; // 10000x, maint 10% => bust 0.009% => 9e-5 of price
    function _open(address u, bool isLong, uint256 m, uint32 lev) internal returns (uint256 id) {
        vm.prank(u); id = ex.open(BTC, isLong, m, lev, isLong ? type(uint256).max : 0);
    }
    function _below(uint256 bpsOfPrice1e5) internal pure returns (uint256) { return P0 - P0 * bpsOfPrice1e5 / 100_000; }

    // ---- F5(b): single-source nudge cannot mark or liquidate
    function test_nudgedPrimaryCannotMarkOrLiquidate() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next();
        orc.set(BTC, _below(20)); orc.setLiq(BTC, P0);          // primary nudged 0.02% below bust; second source says flat
        ex.markLiquidatable(id);
        assertEq(_markBlock(id), 0);
        vm.roll(block.number + 5); vm.warp(block.timestamp + 5);
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);
        assertEq(x.balanceOf(alice), 0);
        // owner closes at the nudged primary: realises the capped loss (<= margin), NOT a hard bust, no PAPER minted
        vm.prank(alice); ex.close(id);
        assertEq(x.balanceOf(alice), 0);
        assertEq(ex.free(alice), 10_000e6 - 10e6);              // at 10000x the loss exceeds margin -> capped at margin; the point is: no PAPER/hard-bust path
        _solvent();
    }

    // ---- F5(a): persistence
    function test_twoBlockPersistence() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next(); orc.set(BTC, _below(20));
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);   // no mark
        ex.markLiquidatable(id);
        uint32 mb = _markBlock(id); assertEq(mb, uint32(block.number));
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);   // same block
        _adv(1, 1);
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);   // 1 block
        _adv(1, 1);
        ex.liquidate(id);                                                            // 2 blocks
        assertGt(x.balanceOf(alice), 0);
        assertEq(_markBlock(id), 0);                                                 // mark deleted with the position
    }

    function test_markEarliestWinsAndClearsOnRecovery() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next(); orc.set(BTC, _below(20));
        ex.markLiquidatable(id); uint32 b0 = _markBlock(id);
        vm.roll(block.number + 1); vm.warp(block.timestamp + 1);
        ex.markLiquidatable(id); assertEq(_markBlock(id), b0);                       // not refreshed
        vm.expectRevert(Paper10kExchange.NotLiquidatable.selector); // no clearMark for a busted position
        ex.clearMark(999);
        vm.expectRevert(Paper10kExchange.StillBusted.selector); ex.clearMark(id);
        orc.set(BTC, P0);                                                            // price recovers
        ex.markLiquidatable(id); assertEq(_markBlock(id), 0);                        // cleared
        vm.roll(block.number + 3); vm.warp(block.timestamp + 3);
        orc.set(BTC, _below(20));                                                    // dips again
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);   // needs a fresh mark
        // clearMark path
        ex.markLiquidatable(id); orc.set(BTC, P0);
        vm.prank(alice); ex.clearMark(id); assertEq(_markBlock(id), 0);
    }

    function test_markExpires() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next(); orc.set(BTC, _below(20));
        ex.markLiquidatable(id);
        vm.roll(block.number + 10); vm.warp(block.timestamp + ex.MARK_TTL() + 1);
        orc.set(BTC, _below(20));
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);   // stale mark unusable
        ex.markLiquidatable(id);                                                     // re-mark allowed after expiry
        assertEq(_markBlock(id), uint32(block.number));
    }

    function test_recoveredBeforeLiquidateReverts() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next(); orc.set(BTC, _below(20)); ex.markLiquidatable(id);
        vm.roll(block.number + 2); vm.warp(block.timestamp + 2); orc.set(BTC, P0);
        vm.expectRevert(Paper10kExchange.NotLiquidatable.selector); ex.liquidate(id);
    }

    function test_shortSideAndSecondSourceDisagreement() public {
        uint256 id = _open(alice, false, 10e6, 10_000);
        _next(); orc.set(BTC, P0 + P0 * 20 / 100_000);
        orc.setLiq(BTC, P0 + P0 * 5 / 100_000);   // second source above bust? 5e-5 < 9e-5 => NOT busted
        ex.markLiquidatable(id); assertEq(_markBlock(id), 0);
        orc.setLiq(BTC, P0 + P0 * 12 / 100_000);  // both past bust
        ex.markLiquidatable(id); assertGt(_markBlock(id), 0);
    }

    // ---- voluntary close of a position busted by the multi-source price is still a hard bust (no free escape from real liquidation)
    function test_voluntaryCloseWhenMultiSourceBusted() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        _next(); orc.set(BTC, _below(20));
        vm.prank(alice); ex.close(id);
        assertEq(x.balanceOf(alice), 10e6 * 1e12 * 100);
        _solvent();
    }

    // ---- F8: liquidation guard down => no marks/liquidations, but users can always close
    function test_closeWorksWhenOnlyLiquidationGuardTrips() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        uint256 id2 = _open(bob, true, 100e6, 100);
        _next(); orc.setLiqDown(true);
        orc.set(BTC, _below(20));
        vm.expectRevert(Paper10kExchange.PriceBad.selector); ex.markLiquidatable(id);
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);
        vm.prank(alice); ex.close(id);                      // proceeds, realises loss
        orc.set(BTC, P0 + P0 / 100);
        vm.prank(bob); ex.close(id2);                       // winner can exit too
        assertEq(ex.totalMargin(), 0);
        _solvent();
    }


    function test_reservedReleasedOnLiquidationAndEmergency() public {
        uint256 id = _open(alice, true, 10e6, 10_000);
        assertEq(ex.reservedLiability(), 10e6 * 100);
        _next(); orc.set(BTC, _below(20)); _liq(id, keeper);
        assertEq(ex.reservedLiability(), 0);
        orc.set(BTC, P0);
        uint256 id2 = _open(alice, true, 10e6, 10);
        assertEq(ex.reservedLiability(), 10e6 * 100);
        vm.startPrank(owner); ex.pause(); vm.stopPrank();
        vm.prank(alice); ex.emergencyCancel(id2);
        assertEq(ex.reservedLiability(), 0);
    }

    // ---- fuzz: liquidation only ever succeeds if (a) marked >=2 blocks ago, (b) multi-source price is past bust at that time
    function testFuzz_liquidateRequiresMarkAndMultiSource(uint16 primaryBps, uint16 secondBps, uint8 waitBlocks, bool isLong) public {
        primaryBps = uint16(bound(primaryBps, 0, 400)); secondBps = uint16(bound(secondBps, 0, 400)); waitBlocks = uint8(bound(waitBlocks, 0, 4));
        uint256 id = _open(alice, isLong, 10e6, 10_000);
        _next();
        uint256 pp = isLong ? P0 - P0 * primaryBps / 100_000 : P0 + P0 * primaryBps / 100_000;
        uint256 sp = isLong ? P0 - P0 * secondBps / 100_000 : P0 + P0 * secondBps / 100_000;
        orc.set(BTC, pp); orc.setLiq(BTC, sp == P0 ? P0 + 1 : sp);
        // never liquidatable without a mark
        vm.expectRevert(); ex.liquidate(id);
        try ex.markLiquidatable(id) {} catch {}
        vm.roll(block.number + waitBlocks); vm.warp(block.timestamp + waitBlocks);
        bool second = isLong ? sp <= ex.bustPriceOf(id) : sp >= ex.bustPriceOf(id);
        bool marked = _markBlock(id) != 0;
        bool ok;
        try ex.liquidate(id) { ok = true; } catch {}
        if (ok) { assertTrue(marked); assertGe(waitBlocks, 2); assertTrue(second); }
        if (!second) assertFalse(ok);
        if (marked && waitBlocks >= 2 && second) assertTrue(ok);
        _solvent();
    }

}
