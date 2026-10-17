// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";

contract GovernanceTest is Base {
    function test_onlyOwnerCanPropose() public {
        vm.prank(alice); vm.expectRevert(); ex.proposeConfig(defParams(), defOps());
        vm.prank(alice); vm.expectRevert(); ex.proposeMarket(1, true, 1, 1);
        vm.prank(alice); vm.expectRevert(); ex.proposeWithdraw(alice, 1, false);
    }

    function test_configDelayEnforcedAndCancellable() public {
        Paper10kExchange.Params memory p = defParams(); p.winFeeBps = 1000;
        vm.startPrank(owner);
        ex.proposeConfig(p, defOps());
        vm.expectRevert(Paper10kExchange.Delay.selector); ex.applyConfig();
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(Paper10kExchange.Delay.selector); ex.applyConfig();
        ex.cancelConfig();
        vm.warp(block.timestamp + 10);
        vm.expectRevert(Paper10kExchange.NothingPending.selector); ex.applyConfig();
        vm.stopPrank();
        assertEq(ex.paramsVersion(), 0);
    }

    function test_invalidParamsRejected() public {
        Paper10kExchange.Params memory p = defParams();
        vm.startPrank(owner);
        p.maxLeverage = 10_001; vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeConfig(p, defOps());
        p = defParams(); p.maintBps = 50; vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeConfig(p, defOps());
        p = defParams(); p.winFeeBps = 1001; vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeConfig(p, defOps());
        p = defParams(); p.rateMultiplier = 0; vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeConfig(p, defOps());
        Paper10kExchange.Ops memory o = defOps(); o.minHold = 0; vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeConfig(defParams(), o);
        vm.stopPrank();
    }

    /// the headline guarantee: a new config cannot change the economics of positions that are already open
    function test_openPositionsKeepTheirParamsVersion() public {
        vm.prank(alice); uint256 idA = ex.open(BTC, true, 100e6, 100, P0);
        uint256 bustA = ex.bustPriceOf(idA);
        (,,, uint256 payoutBefore) = _previewWin(idA);

        Paper10kExchange.Params memory p = defParams();
        p.maintBps = 5000; p.winFeeBps = 1000; p.maxProfitMult = 1; p.rateMultiplier = 1; p.deadbandWad = 1e16; p.maxLeverage = 5; p.mintPerCollateral = 0; p.insuranceBps = 5000;
        vm.startPrank(owner); ex.proposeConfig(p, defOps()); vm.warp(block.timestamp + DELAY); ex.applyConfig(); vm.stopPrank();
        assertEq(ex.paramsVersion(), 1);
        vm.warp(block.timestamp + 1); orc.set(BTC, P0);

        assertEq(ex.bustPriceOf(idA), bustA);                 // liquidation price unchanged
        (,,, uint256 payoutAfter) = _previewWin(idA);
        assertEq(payoutAfter, payoutBefore);                  // payout unchanged
        // new positions use the new params (leverage cap 5)
        vm.prank(bob); vm.expectRevert(Paper10kExchange.Leverage.selector); ex.open(BTC, true, 10e6, 100, P0);
        vm.prank(bob); uint256 idB = ex.open(BTC, true, 10e6, 5, P0);
        // bust of B uses maint 50%: entry*(1-0.5/5)=0.9
        assertEq(ex.bustPriceOf(idB), P0 - P0 * 5000 / (10_000 * 5) * 1 );
        // liquidation of A still mints under OLD mint rate (100/1)
        orc.set(BTC, P0 / 2); _liq(idA, address(this));
        assertEq(x.balanceOf(alice), 100e6 * 1e12 * 100);
    }
    function _previewWin(uint256 id) internal returns (bool, bool, uint256, uint256) {
        uint256 snap = vm.snapshotState(); _next(); orc.set(BTC, P0 + P0 / 100);
        (bool b, bool w, uint256 a,) = ex.previewClose(id);
        vm.revertToState(snap);
        return (b, w, 0, a);
    }

    function test_marketTimelock() public {
        vm.prank(owner); ex.proposeMarket(7, true, 5e6, 5e6);
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Delay.selector); ex.applyMarket(7);
        vm.warp(block.timestamp + DELAY); vm.prank(owner); ex.applyMarket(7);
        (bool listed, bool open_, uint256 cl,,,) = ex.markets(7); assertTrue(listed); assertTrue(open_); assertEq(cl, 5e6);
    }

    function test_withdrawTimelockedAndNeverTouchesUsers() public {
        vm.prank(owner); ex.proposeWithdraw(owner, 100_000e6, false);
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Cap.selector); ex.applyWithdraw(); // more than pool
        assertEq(ex.free(alice), 10_000e6);
        vm.prank(owner); ex.proposeWithdraw(owner, 1_000e6, false);
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Delay.selector); ex.applyWithdraw();
        vm.warp(block.timestamp + DELAY);
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner); ex.applyWithdraw();
        assertEq(usdc.balanceOf(owner), before + 1_000e6);
        _solvent();
    }

    function test_insuranceWithdrawalTimelocked() public {
        vm.startPrank(owner); usdc.approve(address(ex), type(uint256).max); vm.stopPrank();
        usdc.mintTo(address(this), 10_000e6); usdc.approve(address(ex), type(uint256).max); ex.fundInsurance(500e6);
        assertEq(ex.insurance(), 500e6);
        vm.prank(owner); ex.proposeWithdraw(owner, 500e6, true); vm.warp(block.timestamp + DELAY);
        vm.prank(owner); ex.applyWithdraw(); assertEq(ex.insurance(), 0);
    }

    function test_insuranceCoversWinsAfterPoolEmpties() public {
        usdc.mintTo(address(this), 10_000e6); usdc.approve(address(ex), type(uint256).max); ex.fundInsurance(1_000e6);
        vm.startPrank(owner); ex.proposeWithdraw(owner, 10_000e6, false); vm.warp(block.timestamp + DELAY); ex.applyWithdraw(); vm.stopPrank();
        vm.warp(block.timestamp + 1); orc.set(BTC, P0);
        assertEq(ex.pool(), 0);
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 100, P0);
        _next(); orc.set(BTC, P0 + P0 / 100);
        (, , uint256 amt,) = ex.previewClose(id);
        vm.prank(alice); ex.close(id);
        assertEq(ex.queuedTotal(), 0);          // paid fully from insurance
        assertEq(ex.insurance(), 1_000e6 - amt);
        _solvent();
    }

    function test_ownershipTwoStep() public {
        vm.prank(owner); ex.transferOwnership(alice);
        assertEq(ex.owner(), owner);
        vm.prank(alice); ex.acceptOwnership(); assertEq(ex.owner(), alice);
    }
}
