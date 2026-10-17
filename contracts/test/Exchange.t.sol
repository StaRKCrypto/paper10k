// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {SignedPriceOracle} from "../src/SignedPriceOracle.sol";
import {HyperCoreBboOracle} from "../src/HyperCoreBboOracle.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOracle is IPriceOracle {
    mapping(uint32 => uint256) public px;
    function set(uint32 m, uint256 p) external { px[m] = p; }
    function getPrice(uint32 m) external view returns (uint256, uint64) { return (px[m], uint64(block.timestamp)); }
}

contract Base is Test {
    Paper10kExchange ex; Paper10kX x; TestUSDC usdc; MockOracle orc;
    address owner = address(0xA11CE); address alice = address(0xA1); address bob = address(0xB0B); address keeper = address(0xCEE);
    uint32 constant BTC = 0;
    uint256 constant P0 = 100_000e18;

    function setUp() public virtual {
        vm.warp(1_000_000);
        usdc = new TestUSDC(); orc = new MockOracle(); orc.set(BTC, P0);
        x = new Paper10kX(owner, 1e30);
        ex = new Paper10kExchange(owner, IERC20(address(usdc)), 6, x, orc, 2 days, 1e6, 1_000e6, 1_000_000e6);
        vm.startPrank(owner);
        x.setMinter(address(ex), true);
        ex.setMarket(BTC, true, 10_000_000e6, 10_000_000e6);
        ex.unpause();
        vm.stopPrank();
        _fund(alice, 10_000e6); _fund(bob, 10_000e6);
        usdc.faucet(); usdc.transfer(owner, 10_000e6);
        vm.startPrank(owner); usdc.approve(address(ex), type(uint256).max); ex.seedPool(10_000e6); vm.stopPrank();
    }
    function _fund(address u, uint256 amt) internal {
        vm.startPrank(u); usdc.faucet(); usdc.approve(address(ex), type(uint256).max); ex.deposit(amt); vm.stopPrank();
    }
    function _solvent() internal view {
        assertGe(usdc.balanceOf(address(ex)), ex.totalFree() + ex.totalMargin() + ex.pool());
    }
}

contract ExchangeTest is Base {
    function test_deployedPaused() public {
        TestUSDC u = new TestUSDC();
        Paper10kExchange e = new Paper10kExchange(owner, IERC20(address(u)), 6, x, orc, 1 days, 1e6, 1e9, 1e12);
        assertTrue(e.paused());
    }

    function test_depositWithdraw() public {
        vm.prank(alice); ex.withdraw(4_000e6);
        assertEq(ex.free(alice), 6_000e6); assertEq(usdc.balanceOf(alice), 4_000e6);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.InsufficientFree.selector); ex.withdraw(7_000e6);
        _solvent();
    }

    function test_liquidation_at_10000x_mints_px() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10_000, P0);
        // bust = entry*(1-0.9/10000) = -0.009%
        orc.set(BTC, P0 - P0 * 8 / 100_000); // -0.008% : still alive
        vm.expectRevert(Paper10kExchange.NotLiquidatable.selector); ex.liquidate(id);
        orc.set(BTC, P0 - P0 * 10 / 100_000); // -0.010%
        uint256 poolBefore = ex.pool();
        vm.prank(keeper); ex.liquidate(id);
        assertEq(ex.pool(), poolBefore + 10e6);
        assertEq(x.balanceOf(alice), 10e6 * 1e12 * 100); // 1000 PAPER10KX
        assertEq(ex.totalMargin(), 0);
        _solvent();
    }

    function test_close_loss_and_win_haircut() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 100, P0); // 1% = liquidation-ish at 0.9%
        vm.warp(block.timestamp + 5);
        orc.set(BTC, P0 + P0 / 100); // +1%: raw profit 100 usdc
        (, bool win, uint256 amt,) = ex.previewClose(id);
        assertTrue(win);
        assertLt(amt, 100e6); assertGt(amt, 70e6); // haircut + 2% fee
        uint256 poolBefore = ex.pool();
        vm.prank(alice); ex.close(id);
        assertEq(ex.free(alice), 10_000e6 + amt);
        assertEq(ex.pool(), poolBefore - amt);
        _solvent();

        vm.prank(bob); uint256 id2 = ex.open(BTC, true, 100e6, 100, type(uint256).max);
        vm.warp(block.timestamp + 5);
        orc.set(BTC, (P0 + P0 / 100) * 9950 / 10000); // -0.5% : loss = 50
        vm.prank(bob); ex.close(id2);
        assertEq(ex.free(bob), 10_000e6 - 100e6 + (100e6 - 50e6 * 1)); // margin 100 - loss ~50
        assertEq(x.balanceOf(bob), 0); // only liquidation mints
        _solvent();
    }

    function test_voluntaryCloseBeyondBustIsLiquidation() public {
        vm.prank(alice); uint256 id = ex.open(BTC, false, 10e6, 1000, 0);
        vm.warp(block.timestamp + 5);
        orc.set(BTC, P0 + P0 / 500); // +0.2% against short; bust 0.09%
        vm.prank(alice); ex.close(id);
        assertGt(x.balanceOf(alice), 0);
        assertEq(ex.free(alice), 10_000e6 - 10e6);
    }

    function test_minHoldAndSlippage() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10, P0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.TooSoon.selector); ex.close(id);
        orc.set(BTC, P0 + 1);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Slippage.selector); ex.open(BTC, true, 10e6, 10, P0);
    }

    function test_profitCapAndQueue() public {
        // drain pool capacity: owner pool 10k. bob opens huge-ish profit at 10000x? cap 100x margin
        vm.prank(owner); ex.withdrawPool(owner, 10_000e6 - 100e6); // pool = 100
        vm.prank(alice); uint256 id = ex.open(BTC, true, 1_000e6, 100, P0);
        vm.warp(block.timestamp + 5);
        orc.set(BTC, P0 + P0 * 5 / 100); // +5% => raw 5000, >pool
        vm.prank(alice); ex.close(id);
        assertEq(ex.pool(), 0);
        uint256 q = ex.queuedOf(alice); assertGt(q, 0); assertEq(ex.queuedTotal(), q);
        // bob loses -> pool refills -> queue pays
        vm.prank(bob); uint256 id2 = ex.open(BTC, true, 500e6, 100, type(uint256).max);
        vm.warp(block.timestamp + 5); orc.set(BTC, orc.px(BTC) * 99 / 100);
        vm.prank(bob); ex.liquidate(id2);
        // owner cannot withdraw queued-reserved funds
        assertGt(ex.queuedTotal(), ex.pool());
        uint256 pl = ex.pool();
        vm.prank(owner); vm.expectRevert(Paper10kExchange.Cap.selector); ex.withdrawPool(owner, pl);
        ex.processQueue(10);
        assertLt(ex.queuedOf(alice), q);
        _solvent();
    }

    function test_pauseWithdrawAndEmergency() public {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 100e6, 10, P0);
        vm.prank(owner); ex.pause();
        vm.prank(alice); ex.withdraw(1_000e6); // withdraw works while paused
        vm.prank(alice); vm.expectRevert(); ex.deposit(1e6);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.NotEmergency.selector); ex.emergencyCancel(id);
        vm.prank(owner); ex.setEmergencyMode(true);
        vm.prank(bob); vm.expectRevert(Paper10kExchange.NotOwnerOfPosition.selector); ex.emergencyCancel(id);
        vm.prank(alice); ex.emergencyCancel(id);
        assertEq(ex.free(alice), 10_000e6 - 1_000e6);
        assertEq(ex.totalMargin(), 0);
        _solvent();
    }

    function test_guardianCanPauseNotUnpause() public {
        vm.prank(owner); ex.setGuardian(keeper);
        vm.prank(keeper); ex.pause();
        vm.prank(keeper); vm.expectRevert(); ex.unpause();
        vm.prank(bob); vm.expectRevert(); ex.pause();
    }

    function test_caps() public {
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Margin.selector); ex.open(BTC, true, 2_000e6, 10, P0);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Leverage.selector); ex.open(BTC, true, 10e6, 10_001, P0);
        vm.prank(owner); ex.setMarket(BTC, true, 1_000e6, 1_000e6);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.Cap.selector); ex.open(BTC, true, 100e6, 100, P0);
        vm.prank(owner); vm.expectRevert(); ex.setRisk(10_001, 1e6, 1e9, 1e12, 1000, 100);
        vm.prank(alice); vm.expectRevert(); ex.setRisk(10, 1e6, 1e9, 1e12, 1000, 100);
    }

    function test_depositCap() public {
        address c = address(0xC); vm.startPrank(c); usdc.faucet(); usdc.approve(address(ex), type(uint256).max);
        vm.stopPrank();
        vm.prank(owner); ex.setRisk(10_000, 1e6, 1_000e6, 20_050e6, 1000, 100);
        vm.prank(c); vm.expectRevert(Paper10kExchange.Cap.selector); ex.deposit(100e6);
    }

    function test_oracleTimelock() public {
        MockOracle o2 = new MockOracle();
        vm.prank(owner); ex.proposeOracle(o2);
        vm.prank(owner); vm.expectRevert(Paper10kExchange.OracleDelay.selector); ex.applyOracle();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner); ex.applyOracle();
        assertEq(address(ex.oracle()), address(o2));
    }

    function test_stalePriceReverts() public {
        vm.warp(block.timestamp + 1000);
        // MockOracle always returns "now"; use signed oracle for staleness
        (address s, uint256 sk) = makeAddrAndKey("signer");
        SignedPriceOracle so = new SignedPriceOracle(owner, s);
        vm.prank(owner); ex.proposeOracle(so); vm.warp(block.timestamp + 2 days);
        vm.prank(owner); ex.applyOracle();
        uint64 ts = uint64(block.timestamp);
        so.updatePrice(BTC, P0, ts, _sig(so, sk, BTC, P0, ts));
        vm.prank(alice); ex.open(BTC, true, 10e6, 10, P0);
        vm.warp(block.timestamp + 31);
        vm.prank(alice); vm.expectRevert(Paper10kExchange.PriceBad.selector); ex.open(BTC, true, 10e6, 10, P0);
    }

    function _sig(SignedPriceOracle so, uint256 sk, uint32 m, uint256 p, uint64 ts) internal view returns (bytes memory) {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", so.domainSeparator(), keccak256(abi.encode(so.PRICE_TYPEHASH(), m, p, ts))));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(sk, d);
        return abi.encodePacked(r, s_, v);
    }
}
