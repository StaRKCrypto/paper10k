// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {TriggerOrders, IP10KExchange} from "../src/periphery/TriggerOrders.sol";
import {RektBadges, IRektSource} from "../src/periphery/RektBadges.sol";

contract PeripheryTest is Base {
    TriggerOrders trig; RektBadges rekt;
    function setUp() public override {
        super.setUp();
        trig = new TriggerOrders(IP10KExchange(address(ex)));
        rekt = new RektBadges(IRektSource(address(ex)));
        vm.prank(alice); ex.setOperator(address(trig), true);
    }
    function _open(address u, bool isLong, uint32 lev) internal returns (uint256 id) {
        orc.set(BTC, P0); vm.prank(u); id = ex.open(BTC, isLong, 10e6, lev, isLong ? type(uint256).max : 0);
    }

    // ---------------- operator close
    function test_operatorCanOnlyClose_andProceedsGoToOwner() public {
        uint256 id = _open(alice, true, 100);
        _next(); orc.set(BTC, P0);
        uint256 f0 = ex.free(alice);
        vm.prank(bob); vm.expectRevert(Paper10kExchange.NotOwnerOfPosition.selector); ex.close(id);
        vm.prank(address(trig)); ex.close(id); // approved operator
        assertGt(ex.free(alice), f0); assertEq(ex.free(address(trig)), 0);
    }
    function test_revokeOperator() public {
        uint256 id = _open(alice, true, 100);
        vm.prank(alice); ex.setOperator(address(trig), false);
        _next(); orc.set(BTC, P0);
        vm.prank(address(trig)); vm.expectRevert(Paper10kExchange.NotOwnerOfPosition.selector); ex.close(id);
    }
    function test_operatorBustCloseNoBounty() public {
        uint256 id = _open(alice, true, 10_000);
        _next(); orc.set(BTC, P0 * 9990 / 10000);
        vm.prank(address(trig)); ex.close(id);
        assertEq(ex.free(address(trig)), 0); assertEq(ex.rektCount(alice), 1);
    }

    // ---------------- TP / SL
    function test_takeProfitLong() public {
        uint256 id = _open(alice, true, 100);
        vm.prank(alice); trig.place(id, uint128(P0 * 1001 / 1000), uint128(P0 * 999 / 1000));
        _next(); orc.set(BTC, P0 * 10005 / 10000);
        vm.expectRevert(TriggerOrders.NotTriggered.selector); trig.execute(id);
        orc.set(BTC, P0 * 1002 / 1000);
        (uint8 hit,) = trig.check(id); assertEq(hit, 1);
        uint256 f0 = ex.free(alice);
        vm.prank(keeper); trig.execute(id);
        (address o,,,,,,,,,) = ex.positions(id); assertEq(o, address(0));
        assertGt(ex.free(alice), f0 + 10e6);
    }
    function test_stopLossShort() public {
        uint256 id = _open(alice, false, 100);
        vm.prank(alice); trig.place(id, 0, uint128(P0 * 1002 / 1000));
        _next(); orc.set(BTC, P0 * 1003 / 1000);
        (uint8 hit,) = trig.check(id); assertEq(hit, 2);
        vm.prank(keeper); trig.execute(id);
        (address o,,,,,,,,,) = ex.positions(id); assertEq(o, address(0));
    }
    function test_placeValidation() public {
        uint256 id = _open(alice, true, 100);
        vm.startPrank(alice);
        vm.expectRevert(TriggerOrders.BadTrigger.selector); trig.place(id, uint128(P0 - 1), 0);
        vm.expectRevert(TriggerOrders.BadTrigger.selector); trig.place(id, 0, uint128(P0 + 1));
        vm.expectRevert(TriggerOrders.BadTrigger.selector); trig.place(id, 0, 0);
        vm.stopPrank();
        vm.prank(bob); vm.expectRevert(TriggerOrders.NotOwner.selector); trig.place(id, uint128(P0 * 2), 0);
        uint256 idb = _open(bob, true, 100);
        vm.prank(bob); vm.expectRevert(TriggerOrders.NotApproved.selector); trig.place(idb, uint128(P0 * 2), 0);
    }
    function test_cancelAndStaleCleanup() public {
        uint256 id = _open(alice, true, 100);
        vm.prank(alice); trig.place(id, uint128(P0 * 2), 0);
        vm.prank(bob); vm.expectRevert(TriggerOrders.NotOwner.selector); trig.cancel(id);
        _next(); orc.set(BTC, P0);
        vm.prank(alice); ex.close(id); // closed manually
        trig.execute(id); // cleans the orphan order, no revert
        (,, address o) = trig.orders(id); assertEq(o, address(0));
    }
    function test_tooSoonRespected() public {
        uint256 id = _open(alice, true, 100);
        vm.prank(alice); trig.place(id, uint128(P0 * 1001 / 1000), 0);
        orc.set(BTC, P0 * 1002 / 1000);
        vm.expectRevert(Paper10kExchange.TooSoon.selector); trig.execute(id); // same block as open
    }

    /// fuzz: execute never closes when the trigger is not crossed, always closes when it is
    function testFuzz_triggerLong(uint256 tpBps, uint256 moveBps) public {
        tpBps = bound(tpBps, 1, 500); moveBps = bound(moveBps, 0, 1000);
        uint256 id = _open(alice, true, 10);
        uint256 tp = P0 * (10_000 + tpBps) / 10_000;
        vm.prank(alice); trig.place(id, uint128(tp), 0);
        _next(); uint256 px = P0 * (10_000 + moveBps) / 10_000; orc.set(BTC, px);
        if (px >= tp) { trig.execute(id); (address o,,,,,,,,,) = ex.positions(id); assertEq(o, address(0)); }
        else { vm.expectRevert(TriggerOrders.NotTriggered.selector); trig.execute(id); }
    }
    /// fuzz: a non-approved random caller can never close someone else's position
    function testFuzz_randomCallerCannotClose(address who) public {
        vm.assume(who != alice && who != address(trig));
        uint256 id = _open(alice, true, 100);
        _next(); orc.set(BTC, P0);
        vm.prank(who); vm.expectRevert(Paper10kExchange.NotOwnerOfPosition.selector); ex.close(id);
    }

    // ---------------- Rekt badges
    function _rekt(address u) internal {
        uint256 id = _open(u, true, 10_000);
        _next(); orc.set(BTC, P0 * 9990 / 10000);
        _liq(id, keeper);
    }
    function test_rektBadgeClaimSoulbound() public {
        vm.expectRevert(RektBadges.NotEligible.selector); rekt.claim(alice, 0);
        _rekt(alice);
        assertEq(ex.rektCount(alice), 1);
        uint256 tid = rekt.claim(alice, 0); // anyone can claim for alice
        assertEq(rekt.ownerOf(tid), alice);
        vm.expectRevert(); rekt.claim(alice, 0); // once
        vm.expectRevert(RektBadges.NotEligible.selector); rekt.claim(alice, 1);
        vm.prank(alice); vm.expectRevert(RektBadges.Soulbound.selector); rekt.transferFrom(alice, bob, tid);
        vm.prank(alice); vm.expectRevert(RektBadges.Soulbound.selector); rekt.approve(bob, tid);
        assertGt(bytes(rekt.tokenURI(tid)).length, 100);
    }
    function test_rektCountOnlyOnLiquidation() public {
        uint256 id = _open(alice, true, 100);
        _next(); orc.set(BTC, P0 * 999 / 1000);
        vm.prank(alice); ex.close(id); // normal losing close
        assertEq(ex.rektCount(alice), 0);
    }
    function testFuzz_badgeTierEligibility(uint8 n, uint8 tier) public {
        n = uint8(bound(n, 0, 12)); tier = uint8(bound(tier, 0, 3));
        for (uint256 i; i < n; i++) _rekt(bob);
        if (n >= 10 ** tier) { rekt.claim(bob, tier); assertEq(rekt.ownerOf(rekt.tokenIdOf(bob, tier)), bob); }
        else { vm.expectRevert(RektBadges.NotEligible.selector); rekt.claim(bob, tier); }
    }
}
