// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";

/// Pool-scaled sizing (example parameters; the real numbers come from the backtest via Deploy.s.sol env/JSON):
///   maxProfitMult = 1, maxPayoutPoolBps = 100 (1%), so maxMargin = (pool+ins)/100, capped by maxMarginPerPosition.
contract SizingTest is Base {
    Paper10kX x2;
    function _ex(uint256 poolAmt, uint16 walletMult, uint64 decay) internal returns (Paper10kExchange e2) {
        Paper10kExchange.Params memory p = defParams(); p.minMargin = 1e4; p.maxMarginPerPosition = 1_000e6; p.maxProfitMult = 1;
        usdc.mintTo(owner, poolAmt); usdc.mintTo(bob, 2_000e6);
        x2 = new Paper10kX(owner, 1e30);
        e2 = new Paper10kExchange(owner, usdc, 6, x2, orc, DELAY, p, defOps());
        vm.startPrank(owner);
        x2.setMinter(address(e2), true);
        e2.setLimits(Paper10kExchange.Limits(0, 0, 0, 10_000, 0, 0, 100, walletMult, decay));
        e2.setMarket(BTC, true, type(uint128).max, type(uint128).max); vm.warp(block.timestamp + DELAY);  e2.unpause();
        usdc.approve(address(e2), type(uint256).max); if (poolAmt > 0) e2.seedPool(poolAmt);
        vm.stopPrank();
        vm.startPrank(bob); usdc.approve(address(e2), type(uint256).max); e2.deposit(2_000e6); vm.stopPrank();
        orc.set(BTC, P0);
    }
    function test_table() public {
        uint256[6] memory pools = [uint256(10e6), 100e6, 1_000e6, 10_000e6, 100_000e6, 1_000_000e6];
        uint256[6] memory want = [uint256(0.1e6), 1e6, 10e6, 100e6, 1_000e6, 1_000e6]; // capped at 1,000 USDC
        for (uint256 i; i < 6; i++) {
            Paper10kExchange e2 = _ex(pools[i], 0, 0);
            assertEq(e2.maxMarginNow(), want[i]);
        }
    }
    function test_bootstrap10_trades_open() public {
        Paper10kExchange e2 = _ex(10e6, 10, 0);
        vm.startPrank(bob);
        e2.open(BTC, true, 0.1e6, 10_000, type(uint256).max); // $0.10 x 10000 = $1,000 notional, max payout $0.10 = 1% of $10
        vm.expectRevert(Paper10kExchange.PoolTooSmall.selector); e2.open(BTC, true, 0.1e6 + 1, 10_000, type(uint256).max);
        vm.stopPrank();
    }
    function test_walletCapScales() public {
        Paper10kExchange e2 = _ex(100e6, 10, 0); // maxMargin 1 USDC, wallet cap 10 USDC
        vm.startPrank(bob);
        for (uint256 i; i < 10; i++) e2.open(BTC, i % 2 == 0, 1e6, 10_000, i % 2 == 0 ? type(uint256).max : 0);
        vm.expectRevert(Paper10kExchange.Cap.selector); e2.open(BTC, true, 1e6, 10_000, type(uint256).max);
        vm.stopPrank();
    }
    function test_mintDecaySchedule() public {
        Paper10kExchange e2 = _ex(500e6, 0, 1_000e6); // decay starts at $1,000
        assertEq(e2.mintRateNow(100), 100);
        usdc.mintTo(owner, 3_500e6);
        vm.prank(owner); e2.seedPool(500e6);  assertEq(e2.mintRateNow(100), 50);  // $1,000
        vm.prank(owner); e2.seedPool(1_000e6); assertEq(e2.mintRateNow(100), 25); // $2,000
        vm.prank(owner); e2.seedPool(2_000e6); assertEq(e2.mintRateNow(100), 12); // $4,000
    }
    function testFuzz_maxMarginFormula(uint256 poolAmt) public {
        poolAmt = bound(poolAmt, 1e6, 10_000_000e6);
        Paper10kExchange e2 = _ex(poolAmt, 0, 0);
        uint256 m = e2.maxMarginNow(); uint256 expect = poolAmt / 100; if (expect > 1_000e6) expect = 1_000e6;
        assertEq(m, expect);
        if (m >= 1e4) { vm.prank(bob); e2.open(BTC, true, m, 1, type(uint256).max); } // max size always opens
        assertLe(m * 1 * 10_000, (e2.pool() + e2.insurance()) * 100); // worst-case payout <= 1% of pool
    }
    function testFuzz_mintRateMonotone(uint256 a, uint256 b) public {
        Paper10kExchange e2 = _ex(0, 0, 1_000e6);
        a = bound(a, 0, 1e15); b = bound(b, a, 1e15);
        vm.startPrank(owner); usdc.mintTo(owner, b + 1); e2.seedPool(a + 1); uint256 ra = e2.mintRateNow(100);
        if (b > a) e2.seedPool(b - a); uint256 rb = e2.mintRateNow(100); vm.stopPrank();
        assertLe(rb, ra);
    }
}
