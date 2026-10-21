// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";

contract LimitsTest is Base {
    function _L(uint128 mn, uint128 mx, uint128 w, uint32 u, uint16 j, uint32 win) internal pure returns (Paper10kExchange.Limits memory) {
        return Paper10kExchange.Limits(mn, mx, w, u, j, win);
    }
    function _setNow(Paper10kExchange.Limits memory l) internal {
        vm.prank(owner); ex.proposeLimits(l); _adv(1, DELAY); vm.prank(owner); ex.applyLimits();
    }

    function test_preLaunchOnlyThenTimelocked() public {
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Delay.selector); ex.setLimitsPreLaunch(_L(0, 0, 0, 0, 0, 0)); // launched in setUp
        vm.prank(owner); ex.proposeLimits(_L(10_000e6, 0, 0, 0, 0, 0));
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Delay.selector); ex.applyLimits();
        vm.prank(alice); vm.expectRevert(); ex.proposeLimits(_L(0, 0, 0, 0, 0, 0));
        _adv(1, DELAY); vm.prank(owner); ex.applyLimits();
        (uint128 mn,,,,,) = ex.limits(); assertEq(mn, 10_000e6);
    }
    function test_preLaunchInstantOnFreshExchange() public {
        Paper10kExchange e2 = new Paper10kExchange(owner, usdc, 6, x, orc, DELAY, defParams(), defOps());
        vm.prank(owner); e2.setLimitsPreLaunch(_L(10_000e6, 1_000_000e6, 100e6, 10_000, 50, 60));
        (, uint128 mx,,,,) = e2.limits(); assertEq(mx, 1_000_000e6);
    }
    function test_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeLimits(_L(10, 5, 0, 0, 0, 0));
        vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeLimits(_L(0, 0, 0, 0, 50, 0));
        vm.expectRevert(Paper10kExchange.BadParam.selector); ex.proposeLimits(_L(0, 0, 0, 0, 6000, 60));
        vm.stopPrank();
    }
    function test_notionalBounds() public {
        _setNow(_L(10_000e6, 100_000e6, 0, 0, 0, 0));
        orc.set(BTC, P0);
        vm.startPrank(alice);
        vm.expectRevert(Paper10kExchange.Margin.selector); ex.open(BTC, true, 1e6, 5_000, type(uint256).max);   // $5k < min
        vm.expectRevert(Paper10kExchange.Margin.selector); ex.open(BTC, true, 20e6, 10_000, type(uint256).max); // $200k > max
        ex.open(BTC, true, 1e6, 10_000, type(uint256).max); // $10k ok
        vm.stopPrank();
    }
    function test_walletMarginCapAndRelease() public {
        _setNow(_L(0, 0, 30e6, 0, 0, 0));
        orc.set(BTC, P0);
        vm.startPrank(alice);
        uint256 id = ex.open(BTC, true, 20e6, 100, type(uint256).max);
        vm.expectRevert(Paper10kExchange.Cap.selector); ex.open(BTC, true, 11e6, 100, type(uint256).max);
        assertEq(ex.walletMargin(alice), 20e6);
        vm.stopPrank();
        _next(); orc.set(BTC, P0);
        vm.prank(alice); ex.close(id);
        assertEq(ex.walletMargin(alice), 0);
        vm.prank(alice); ex.open(BTC, true, 30e6, 100, type(uint256).max);
        vm.prank(bob); ex.open(BTC, true, 30e6, 100, type(uint256).max); // per wallet, not global
    }
    function test_liquidationReleasesWalletMargin() public {
        _setNow(_L(0, 0, 50e6, 0, 0, 0));
        orc.set(BTC, P0);
        vm.prank(alice); uint256 id = ex.open(BTC, true, 20e6, 10_000, type(uint256).max);
        _next(); orc.set(BTC, P0 * 9990 / 10000);
        _liq(id, keeper);
        assertEq(ex.walletMargin(alice), 0);
    }
    function test_lpUtilisationCap() public {
        // pool+insurance = 10,000 USDC; 50% => per-side reserved liability <= 5,000; liab = margin * 100
        _setNow(_L(0, 0, 0, 5_000, 0, 0));
        orc.set(BTC, P0);
        vm.startPrank(alice);
        ex.open(BTC, true, 50e6, 100, type(uint256).max);        // 5,000 liab: ok
        vm.expectRevert(Paper10kExchange.Cap.selector); ex.open(BTC, true, 1e6, 100, type(uint256).max);
        ex.open(BTC, false, 50e6, 100, 0);                        // other side has its own budget
        vm.stopPrank();
    }
    function test_oracleJumpBreaker() public {
        _setNow(_L(0, 0, 0, 0, 50, 60)); // 0.5% within 60s
        orc.set(BTC, P0);
        vm.prank(alice); ex.open(BTC, true, 1e6, 100, type(uint256).max); // anchors ref
        _adv(1, 5); orc.set(BTC, P0 * 1006 / 1000);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Breaker.selector); ex.open(BTC, true, 1e6, 100, type(uint256).max);
        orc.set(BTC, P0 * 1004 / 1000);
        vm.prank(alice); ex.open(BTC, true, 1e6, 100, type(uint256).max); // within band
        _adv(1, 61); orc.set(BTC, P0 * 1006 / 1000);
        vm.prank(alice); ex.open(BTC, true, 1e6, 100, type(uint256).max); // window passed: re-anchors, opens resume
        assertEq(ex.refPx(BTC), P0 * 1006 / 1000);
    }
    function test_breakerNeverBlocksCloseOrLiquidation() public {
        _setNow(_L(0, 0, 0, 0, 50, 60));
        orc.set(BTC, P0);
        vm.prank(alice); uint256 a = ex.open(BTC, true, 1e6, 10_000, type(uint256).max);
        vm.prank(bob); uint256 b = ex.open(BTC, false, 1e6, 100, 0);
        _next(); orc.set(BTC, P0 * 98 / 100); // -2%: breaker band exceeded
        vm.prank(bob); ex.close(b);
        _liq(a, keeper);
    }
}
