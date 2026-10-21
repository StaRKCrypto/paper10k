// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {_po, _ql} from "./Helpers.sol";
import {Base, MockOracle} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {HyperCoreOracle} from "../src/HyperCoreOracle.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Regression tests for the audit-v3 fixes (AI review; see AUDIT.md).
contract AuditV3Test is Base {
    function _oracle() internal returns (HyperCoreOracle h) {
        h = new HyperCoreOracle(owner, address(0x80e), address(0x807), 1 days);
        vm.prank(owner); h.configure(0, 0, 5);
    }

    // F1: oracle governance is instant only during bootstrap, then timelocked
    function test_oracleConfigTimelockedAfterBootstrap() public {
        HyperCoreOracle h = _oracle();
        vm.startPrank(owner);
        h.finalizeBootstrap();
        vm.expectRevert(bytes("timelocked")); h.configure(0, 1, 4);              // remap BTC -> another asset: blocked
        vm.expectRevert(bytes("timelocked")); h.setGuards(200, 500, IPriceOracle(address(0)), 500, 600);
        h.proposeMarket(0, 1, 4);
        vm.expectRevert(bytes("delay")); h.applyMarket(0);
        vm.warp(vm.getBlockTimestamp() + 1 days - 1);
        vm.expectRevert(bytes("delay")); h.applyMarket(0);
        vm.warp(vm.getBlockTimestamp() + 1);
        h.applyMarket(0);
        (uint32 asset, uint8 sz, bool on) = h.mkt(0);
        assertEq(asset, 1); assertEq(sz, 4); assertTrue(on);
        // guards
        h.proposeGuards(100, 300, IPriceOracle(address(0)), 100, 30);
        vm.expectRevert(bytes("delay")); h.applyGuards();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        h.applyGuards();
        assertEq(h.maxSpreadBps(), 100); assertEq(h.maxDevBps(), 300);
        // cancel works, and proposals validate bounds
        h.proposeMarket(0, 2, 3); h.cancelMarket(0);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.expectRevert(bytes("delay")); h.applyMarket(0);
        vm.expectRevert(bytes("bps")); h.proposeGuards(0, 100, IPriceOracle(address(0)), 100, 30);
        vm.stopPrank();
    }

    function test_oracleOnlyOwnerProposes() public {
        HyperCoreOracle h = _oracle();
        vm.prank(alice); vm.expectRevert(); h.proposeMarket(0, 1, 4);
        vm.prank(alice); vm.expectRevert(); h.proposeGuards(30, 100, IPriceOracle(address(0)), 100, 30);
        vm.prank(alice); vm.expectRevert(); h.finalizeBootstrap();
    }

    function test_oracleDelayFloor() public {
        vm.expectRevert(bytes("delay")); new HyperCoreOracle(owner, address(0x80e), address(0x807), 60);
    }

    // F2: exchange timelock cannot be deployed as a no-op; owner cannot renounce a paused exchange
    function test_exchangeDelayFloorAndNoRenounce() public {
        vm.expectRevert(bytes("delay"));
        new Paper10kExchange(owner, IERC20(address(usdc)), 6, x, orc, 0, defParams(), defOps());
        vm.prank(owner); vm.expectRevert(Paper10kExchange.BadParam.selector); ex.renounceOwnership();
        assertEq(ex.owner(), owner);
    }

    // F3: notional that would not fit uint128 is rejected rather than silently truncated
    function test_hugeNotionalRejected() public {
        Paper10kExchange.Params memory p = defParams(); p.maxMarginPerPosition = type(uint128).max;
        Paper10kExchange.Ops memory o = defOps(); o.maxTotalDeposits = type(uint128).max;
        vm.startPrank(owner); ex.setConfig(p, o); vm.warp(block.timestamp + DELAY);  vm.stopPrank();
        uint256 huge = uint256(type(uint128).max) / 1000; // x10000 leverage overflows uint128
        deal(address(usdc), alice, huge);
        vm.startPrank(alice); usdc.approve(address(ex), huge); ex.deposit(huge);
        orc.set(BTC, P0);
        vm.expectRevert(Paper10kExchange.Margin.selector); ex.open(BTC, true, huge, 10_000, type(uint256).max);
        vm.stopPrank();
        _solvent();
    }

    // queue accounting: partial processing keeps FIFO, queuedTotal == sum, owner cannot withdraw while owed (regression for dust/queue review)
    function test_queuePartialFIFOAndAccounting() public {
        // alice and bob both long at 10000x, price +1% => profit capped at 100x margin, far above pool(10k)
        vm.startPrank(alice); ex.open(BTC, true, 400e6, 10_000, type(uint256).max); vm.stopPrank();
        vm.startPrank(bob);   ex.open(BTC, true, 400e6, 10_000, type(uint256).max); vm.stopPrank();
        _next(); orc.set(BTC, P0 * 1010 / 1000);
        vm.prank(alice); ex.close(1);
        vm.prank(bob);   ex.close(2);
        uint256 qa = ex.queuedOf(alice); uint256 qb = ex.queuedOf(bob);
        assertGt(qa, 0); assertGt(qb, 0);
        assertEq(ex.queuedTotal(), qa + qb);
        assertEq(_ql(ex), 2);
        // bob (second) must not be paid before alice, even if anyone calls processQueue repeatedly
        deal(address(usdc), address(this), 1_000_000e6); usdc.approve(address(ex), type(uint256).max);
        ex.fundInsurance(qa / 2);
        ex.processQueue(10);
        assertEq(ex.queuedOf(bob), qb);          // untouched
        assertLt(ex.queuedOf(alice), qa);        // head partially paid
        assertEq(ex.queuedTotal(), ex.queuedOf(alice) + ex.queuedOf(bob));
        _solvent();
    }

    // closing a market is instant & protective but re-opening is timelocked
    function test_reopenMarketPreFinal() public {
        vm.prank(owner); ex.setMarket(BTC, false, 1e12, 1e12);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.MarketClosed.selector); ex.open(BTC, true, 10e6, 10, type(uint256).max);
        vm.startPrank(owner); ex.setMarket(BTC, true, 1e12, 1e12);

        vm.stopPrank();
    }
}
