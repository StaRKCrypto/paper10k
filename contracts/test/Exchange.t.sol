// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, MockOracle} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {SignedPriceOracle} from "../src/testnet/SignedPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ExchangeTest is Base {
    function test_deployedPaused() public {
        Paper10kExchange e = new Paper10kExchange(owner, IERC20(address(new TestUSDC())), 6, x, orc, 1 days, defParams(), defOps());
        assertTrue(e.paused());
    }

    function test_depositWithdraw() public {
        vm.prank(alice); ex.withdraw(4_000e6);
        assertEq(ex.free(alice), 6_000e6); assertEq(usdc.balanceOf(alice), 4_000e6);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.InsufficientFree.selector); ex.withdraw(7_000e6);
        _solvent();
    }

    function test_liquidation_at_10000x_mints_px_and_feeds_insurance() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10_000, P0);
        orc.set(BTC, P0 - P0 * 8 / 100_000);
        vm.expectRevert(Paper10kExchange.MarkNotReady.selector); ex.liquidate(id);
        ex.markLiquidatable(id); assertEq(_markBlock(id), 0); // not busted -> no mark
        orc.set(BTC, P0 - P0 * 10 / 100_000);
        uint256 poolBefore = ex.pool();
        _liq(id, keeper);
        assertEq(ex.insurance(), 1e6);                 // 10% of 10
        assertEq(ex.pool(), poolBefore + 9e6);
        assertEq(x.balanceOf(alice), 10e6 * 1e12 * 100);
        assertEq(ex.totalMargin(), 0);
        _solvent();
    }

    function test_close_loss_and_win_haircut() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 100, P0);
        _next(); orc.set(BTC, P0 + P0 / 100);
        (, bool win, uint256 amt,) = ex.previewClose(id);
        assertTrue(win); assertLt(amt, 100e6); assertGt(amt, 70e6);
        uint256 poolBefore = ex.pool();
        vm.prank(alice); ex.close(id);
        assertEq(ex.free(alice), 10_000e6 + amt); assertEq(ex.pool(), poolBefore - amt);
        _solvent();
        vm.prank(bob); uint256 id2 = ex.open(BTC, true, 100e6, 100, type(uint256).max);
        _next(); orc.set(BTC, (P0 + P0 / 100) * 9950 / 10000);
        vm.prank(bob); ex.close(id2);
        assertGt(ex.free(bob), 10_000e6 - 100e6); assertLt(ex.free(bob), 10_000e6);
        assertEq(x.balanceOf(bob), 0);
        assertGt(ex.insurance(), 0);
        _solvent();
    }

    function test_voluntaryCloseBeyondBustIsLiquidation() public {
        vm.prank(alice); uint256 id = ex.open(BTC, false, 10e6, 1000, 0);
        _next(); orc.set(BTC, P0 + P0 / 500);
        vm.prank(alice); ex.close(id);
        assertGt(x.balanceOf(alice), 0); assertEq(ex.free(alice), 10_000e6 - 10e6);
    }

    function test_minHoldSameBlockAndSlippage() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10, P0);
        vm.warp(block.timestamp + 100); // time passed but SAME BLOCK number
        orc.set(BTC, P0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.TooSoon.selector); ex.close(id);
        vm.roll(block.number + 1); vm.warp(block.timestamp - 99); // only 1s later, < minHold
        vm.prank(alice); vm.expectRevert(Paper10kExchange.TooSoon.selector); ex.close(id);
        orc.set(BTC, P0 + 1);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Slippage.selector); ex.open(BTC, true, 10e6, 10, P0);
    }

    function test_deadbandKillsTinyWins() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 100, P0);
        _next(); orc.set(BTC, P0 + P0 / 1_000_000); // +0.0001% < deadband 0.0002%
        (, bool win, uint256 amt,) = ex.previewClose(id); assertTrue(win); assertEq(amt, 0);
    }

    function test_profitCapAndQueue_insuranceBacksPayout() public {
        // make the pool tiny; seed insurance so wins are paid from it after the pool
        vm.warp(block.timestamp + DELAY); _setPool(100e6);
        vm.warp(block.timestamp + 1); orc.set(BTC, P0);
        assertEq(ex.pool(), 100e6);
        vm.prank(alice); uint256 id = ex.open(BTC, true, 1_000e6, 100, P0);
        _next(); orc.set(BTC, P0 + P0 * 5 / 100);
        vm.prank(alice); ex.close(id);
        assertEq(ex.pool(), 0); assertEq(ex.insurance(), 0);
        uint256 q = ex.queuedOf(alice); assertGt(q, 0); assertEq(ex.queuedTotal(), q);
        vm.prank(bob); uint256 id2 = ex.open(BTC, true, 500e6, 100, type(uint256).max);
        _next(); orc.set(BTC, orc.px(BTC) * 99 / 100);
        _liq(id2, bob);
        ex.processQueue(10);
        assertLt(ex.queuedOf(alice), q);
        _solvent();
    }

    function test_pauseWithdrawAndEmergency() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 10, P0);
        vm.prank(owner); ex.pause();
        vm.prank(alice); ex.withdraw(1_000e6);
        vm.prank(alice); vm.expectRevert(); ex.deposit(1e6);
        vm.prank(bob); vm.expectRevert(Paper10kExchange.NotOwnerOfPosition.selector); ex.emergencyCancel(id);
        vm.prank(alice); ex.emergencyCancel(id);
        assertEq(ex.free(alice), 10_000e6 - 1_000e6); assertEq(ex.totalMargin(), 0);
        _solvent();
    }

    function test_guardianCanPauseButNotUnpause() public {
        vm.prank(owner); ex.setGuardian(keeper);
        vm.prank(owner); ex.setMarket(BTC, false, 1e12, 1e12);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.MarketClosed.selector); ex.open(BTC, true, 10e6, 10, P0);
        vm.prank(keeper); ex.pause();
        vm.prank(keeper); vm.expectRevert(); ex.unpause();
        vm.prank(bob); vm.expectRevert(); ex.pause();
    }

    function test_capsAndDepositCap() public {
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Margin.selector); ex.open(BTC, true, 2_000e6, 10, P0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Leverage.selector); ex.open(BTC, true, 10e6, 10_001, P0);
        address c = address(0xC); vm.startPrank(c); usdc.faucet(); usdc.approve(address(ex), type(uint256).max); vm.stopPrank();
        Paper10kExchange.Ops memory o = defOps(); o.maxTotalDeposits = 20_050e6;
        vm.startPrank(owner); ex.setConfig(defParams(), o); vm.warp(block.timestamp + DELAY);  vm.stopPrank();
        vm.prank(c); vm.expectRevert(Paper10kExchange.Cap.selector); ex.deposit(100e6);
    }

    function test_setOracleInstantPreFinal() public {
        MockOracle o2 = new MockOracle();
        vm.prank(owner); ex.setOracle(o2);
        
        vm.warp(block.timestamp + DELAY);

        assertEq(address(ex.oracle()), address(o2));
    }

    function test_stalePriceReverts() public {
        (address s, uint256 sk) = makeAddrAndKey("signer");
        SignedPriceOracle so = new SignedPriceOracle(owner, s);
        vm.prank(owner); ex.setOracle(so); vm.warp(block.timestamp + DELAY);

        uint64 ts = uint64(block.timestamp);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", so.domainSeparator(), keccak256(abi.encode(so.PRICE_TYPEHASH(), BTC, P0, ts))));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(sk, d);
        so.updatePrice(BTC, P0, ts, abi.encodePacked(r, s_, v));
        vm.prank(alice); ex.open(BTC, true, 10e6, 10, P0);
        vm.warp(block.timestamp + 31);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.PriceBad.selector); ex.open(BTC, true, 10e6, 10, P0);
    }

    function test_noPriceFailsClosed() public {
        orc.set(BTC, 0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.PriceBad.selector); ex.open(BTC, true, 10e6, 10, type(uint256).max);
    }

    function test_emergencyCancelOnlyWhilePaused() public {
        vm.startPrank(owner); ex.pause(); ex.unpause(); vm.stopPrank();
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10, P0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.NotEmergency.selector); ex.emergencyCancel(id);
    }
}
