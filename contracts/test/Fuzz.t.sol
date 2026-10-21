// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";

contract FuzzTest is Base {
    /// any price path, any leverage: payout <= margin + capx*margin; solvency after every settlement; loss <= margin
    function testFuzz_settlementBounds(uint32 lev, bool isLong, uint256 move, bool up, uint96 margin) public {
        lev = uint32(bound(lev, 1, 10_000)); margin = uint96(bound(margin, 1e6, 1_000e6));
        move = bound(move, 0, 5e17);
        vm.prank(alice); uint256 id = ex.open(BTC, isLong, margin, lev, isLong ? type(uint256).max : 0);
        uint256 np = up ? P0 + P0 * move / 1e18 : P0 - P0 * move / 1e18;
        _next(); orc.set(BTC, np);
        uint256 freeBefore = ex.free(alice); uint256 qBefore = ex.queuedOf(alice);
        vm.prank(alice); ex.close(id);
        uint256 got = ex.free(alice) + ex.queuedOf(alice) - qBefore - freeBefore;
        assertLe(got, uint256(margin) + uint256(margin) * 100);
        _solvent();
    }

    /// wins are monotone non-decreasing in the favourable move (haircut never makes a bigger win smaller)
    function testFuzz_winMonotone(uint256 m1, uint256 m2) public {
        m1 = bound(m1, 1e12, 4e16); m2 = bound(m2, m1, 5e16);
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 50, P0);
        _next();
        orc.set(BTC, P0 + P0 * m1 / 1e18); (bool b1, , uint256 a1,) = ex.previewClose(id);
        orc.set(BTC, P0 + P0 * m2 / 1e18); (bool b2, , uint256 a2,) = ex.previewClose(id);
        if (!b1 && !b2) assertGe(a2, a1);
    }

    /// the bust price is on the correct side of entry and its distance equals (1-maint)/lev
    function testFuzz_bustDistance(uint16 lev, bool isLong) public {
        lev = uint16(bound(lev, 1, 10_000));
        vm.prank(alice); uint256 id = ex.open(BTC, isLong, 1e6, lev, isLong ? type(uint256).max : 0);
        uint256 b = ex.bustPriceOf(id);
        if (isLong) assertLt(b, P0); else assertGt(b, P0);
        uint256 dist = b > P0 ? b - P0 : P0 - b;
        assertApproxEqAbs(dist, P0 * 9000 / (10_000 * uint256(lev)), 1);
    }

    /// random (valid) config changes never alter open positions' bust price or preview payout
    function testFuzz_configChangeDoesNotTouchOpenPositions(uint16 maint, uint16 fee, uint16 cap, uint32 rate, uint64 dead, uint16 maxLev) public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 200, P0);
        uint256 bustB = ex.bustPriceOf(id);
        _next(); orc.set(BTC, P0 + P0 / 200);
        (, , uint256 amtB,) = ex.previewClose(id);
        Paper10kExchange.Params memory p = defParams();
        p.maintBps = uint16(bound(maint, 100, 5000)); p.winFeeBps = uint16(bound(fee, 0, 1000)); p.maxProfitMult = uint16(bound(cap, 1, 10_000));
        p.rateMultiplier = uint32(bound(rate, 1, 1e6)); p.deadbandWad = uint64(bound(dead, 0, 1e16)); p.maxLeverage = uint16(bound(maxLev, 1, 10_000));
        vm.startPrank(owner); ex.setConfig(p, defOps()); vm.warp(block.timestamp + DELAY);  vm.stopPrank();
        vm.warp(block.timestamp + 1); orc.set(BTC, P0 + P0 / 200);
        assertEq(ex.bustPriceOf(id), bustB);
        (, , uint256 amtA,) = ex.previewClose(id);
        assertEq(amtA, amtB);
    }

    /// deposits/withdrawals alone never change anyone else's balance and keep exact accounting
    function testFuzz_depositWithdrawAccounting(uint96 a, uint96 w) public {
        a = uint96(bound(a, 1, 5_000e6)); 
        usdc.mintTo(alice, 10_000e6); uint256 before = ex.free(alice);
        vm.startPrank(alice); ex.deposit(a); uint256 wd = bound(w, 1, before + a); ex.withdraw(wd); vm.stopPrank();
        assertEq(ex.free(alice), before + a - wd);
        assertEq(usdc.balanceOf(address(ex)), ex.totalFree() + ex.totalMargin() + ex.pool() + ex.insurance());
    }

}
