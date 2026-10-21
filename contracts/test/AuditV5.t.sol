// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";

/// Audit v5 (AI review): liquidation bounty — capped, from liquidated margin only, never to the owner, never profitable to farm.
contract AuditV5Test is Base {
    function setUp() public override { bBps = 200; bCap = 10e6; super.setUp(); }

    function _open(address u, uint256 m) internal returns (uint256 id) { vm.prank(u); id = ex.open(BTC, true, m, 10_000, type(uint256).max); }
    function _bust() internal { _next(); orc.set(BTC, P0 - P0 * 20 / 100_000); }

    function test_bountyPaidFromLiquidatedMargin() public {
        uint256 id = _open(alice, 100e6); _bust();
        uint256 pI = ex.pool() + ex.insurance(); uint256 f = ex.free(keeper);
        _liq(id, keeper);
        assertEq(ex.free(keeper) - f, 2e6);                              // 2% of 100
        assertEq(ex.pool() + ex.insurance() - pI, 98e6);                 // rest of margin to pool/insurance
        assertEq(x.balanceOf(alice), 100e6 * 1e12 * 100);                // PAPER10KX still on the full margin
        _solvent();
    }

    function test_bountyCapped() public {
        uint256 id = _open(alice, 1_000e6); _bust();
        uint256 f = ex.free(keeper); _liq(id, keeper);
        assertEq(ex.free(keeper) - f, 10e6);                             // 2% would be 20, cap is 10
        _solvent();
    }

    function test_noBountyForSelfLiquidation() public {
        uint256 id = _open(alice, 100e6); _bust();
        ex.markLiquidatable(id); vm.roll(block.number + 2); vm.warp(block.timestamp + 2);
        uint256 f = ex.free(alice);
        vm.prank(alice); ex.liquidate(id);
        assertEq(ex.free(alice), f);
        // voluntary close that turns into a hard bust: caller == owner => no bounty either
        orc.set(BTC, P0); uint256 id2 = _open(bob, 100e6); _bust();
        uint256 fb = ex.free(bob); vm.prank(bob); ex.close(id2);
        assertEq(ex.free(bob), fb);
        _solvent();
    }

    /// farming: an attacker who owns the position and liquidates through a second address ALWAYS ends with less than he started with
    function testFuzz_sybilSelfLiquidationNeverProfits(uint96 margin, address sybil, uint16 bps, uint96 cap) public {
        vm.assume(sybil != address(0) && sybil != alice && sybil != address(ex) && sybil != owner && sybil != address(usdc) && sybil != address(x));
        margin = uint96(bound(margin, 1e6, 1_000e6)); bps = uint16(bound(bps, 0, 1000)); cap = uint96(bound(cap, 0, 1_000e6));
        Paper10kExchange.Ops memory o = defOps(); o.bountyBps = bps; o.bountyCap = cap;
        vm.startPrank(owner); ex.setConfig(defParams(), o); vm.warp(block.timestamp + DELAY);  vm.stopPrank();
        _next(); orc.set(BTC, P0);
        uint256 before = ex.free(alice) + ex.free(sybil); uint256 sy0 = ex.free(sybil);
        uint256 id = _open(alice, margin); _bust();
        ex.markLiquidatable(id); vm.roll(block.number + 2); vm.warp(block.timestamp + 2);
        vm.prank(sybil); ex.liquidate(id);
        uint256 afterBal = ex.free(alice) + ex.free(sybil);
        assertLt(afterBal, before);                                      // strictly poorer
        uint256 bounty = ex.free(sybil) - sy0;
        assertEq(before - afterBal, margin - bounty);                    // loss = margin minus the bounty recovered
        assertLe(bounty, uint256(margin) * 1000 / 10_000);               // bounty <= 10% margin
        _solvent();
    }

    /// exact split for any margin/params/caller
    function testFuzz_bountyExactSplit(uint96 margin, uint16 bps, uint96 cap, address caller) public {
        vm.assume(caller != address(0) && caller != address(ex) && caller != owner && caller != address(usdc) && caller != address(x));
        margin = uint96(bound(margin, 1e6, 1_000e6)); bps = uint16(bound(bps, 0, 1000)); cap = uint96(bound(cap, 0, 1_000e6));
        Paper10kExchange.Ops memory o = defOps(); o.bountyBps = bps; o.bountyCap = cap;
        vm.startPrank(owner); ex.setConfig(defParams(), o); vm.warp(block.timestamp + DELAY);  vm.stopPrank();
        _next(); orc.set(BTC, P0);
        uint256 id = _open(alice, margin); _bust();
        uint256 hp = ex.pool() + ex.insurance(); uint256 f = ex.free(caller);
        ex.markLiquidatable(id); vm.roll(block.number + 2); vm.warp(block.timestamp + 2);
        vm.prank(caller); ex.liquidate(id);
        uint256 want = uint256(margin) * bps / 10_000; if (want > cap) want = cap;
        uint256 bounty = ex.free(caller) - f;
        if (caller == alice) assertEq(bounty, 0); else assertEq(bounty, want);
        assertEq(ex.pool() + ex.insurance() - hp + bounty, margin);      // nothing created or lost
        _solvent();
    }

    function test_bountyParamsValidated() public {
        Paper10kExchange.Ops memory o = defOps(); o.bountyBps = 1001;
        vm.prank(owner); vm.expectRevert(Paper10kExchange.BadParam.selector); ex.setConfig(defParams(), o);
    }

    /// bounty is never taken from insurance and does not depend on pool/insurance balances (works with an empty house)
    function test_bountyIndependentOfInsurance() public {
        uint256 id = _open(alice, 100e6); _bust();
        uint256 ins = ex.insurance();
        _liq(id, keeper);
        assertGe(ex.insurance(), ins);                                   // insurance only ever grows on a liquidation
    }
}
