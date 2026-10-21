// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Paper10kStaking} from "../src/Paper10kStaking.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Tok is ERC20 { constructor() ERC20("T", "T") {} function mint(address a, uint256 v) external { _mint(a, v); } }

abstract contract StakeSetup is Test {
    Tok stk; TestUSDC usd; Paper10kStaking s; address ex = address(0xE11);
    address a = address(0xA); address b = address(0xB);
    function _deploy(uint64 cd) internal {
        stk = new Tok(); usd = new TestUSDC(); s = new Paper10kStaking(IERC20(address(stk)), IERC20(address(usd)), ex, cd);
        for (uint256 i; i < 2; i++) { address u = i == 0 ? a : b; stk.mint(u, 1e30); vm.prank(u); stk.approve(address(s), type(uint256).max); }
    }
    function _notify(uint256 amt) internal { usd.mintTo(address(s), amt); vm.prank(ex); s.notifyReward(amt); }
}

contract StakingUnitTest is StakeSetup {
    function setUp() public { _deploy(0); }
    function test_proRataAndClaim() public {
        vm.prank(a); s.stake(100e18); vm.prank(b); s.stake(300e18);
        _notify(400e6);
        assertEq(s.earned(a), 100e6); assertEq(s.earned(b), 300e6);
        vm.prank(a); assertEq(s.claim(), 100e6); assertEq(usd.balanceOf(a), 100e6);
        vm.prank(a); assertEq(s.claim(), 0);
    }
    function test_lateStakerGetsNothingFromPastRewards() public {
        vm.prank(a); s.stake(1e18); _notify(10e6);
        vm.prank(b); s.stake(1e18);
        assertEq(s.earned(b), 0); assertEq(s.earned(a), 10e6);
    }
    function test_onlyExchangeNotifies_andNoStakersReverts() public {
        vm.expectRevert(Paper10kStaking.NotExchange.selector); s.notifyReward(1);
        vm.prank(ex); vm.expectRevert(Paper10kStaking.NoStakers.selector); s.notifyReward(1);
    }
    function test_donationIgnored() public {
        vm.prank(a); s.stake(1e18);
        usd.mintTo(address(s), 1_000e6); // direct donation: not notified => not distributable
        assertEq(s.earned(a), 0);
        _notify(1e6); assertEq(s.earned(a), 1e6);
    }
    function test_instantUnstakeKeepsEarned() public {
        vm.prank(a); s.stake(5e18); _notify(7e6);
        vm.prank(a); s.unstake(5e18);
        assertEq(stk.balanceOf(a), 1e30); assertEq(s.totalStaked(), 0); assertEq(s.earned(a), 7e6);
        vm.prank(a); vm.expectRevert(Paper10kStaking.Insufficient.selector); s.unstake(1);
        vm.prank(a); vm.expectRevert(Paper10kStaking.Zero.selector); s.stake(0);
    }
    function test_roundingDustCarried() public {
        vm.prank(a); s.stake(3); // 3 wei staked, rewards not divisible
        for (uint256 i; i < 3; i++) _notify(1);
        assertLe(s.earned(a), 3); assertGe(s.earned(a), 2);
    }
}

contract StakingCooldownTest is StakeSetup {
    function setUp() public { _deploy(1 days); }
    function test_cooldown() public {
        vm.prank(a); s.stake(10e18);
        vm.prank(a); s.unstake(4e18);
        assertEq(s.staked(a), 6e18);
        _notify(6e6); assertEq(s.earned(a), 6e6); // pending tokens stop earning
        vm.prank(a); vm.expectRevert(Paper10kStaking.Locked.selector); s.withdrawUnstaked();
        vm.warp(block.timestamp + 1 days);
        vm.prank(a); s.withdrawUnstaked();
        assertEq(stk.balanceOf(a), 1e30 - 6e18);
        vm.prank(a); vm.expectRevert(Paper10kStaking.Zero.selector); s.withdrawUnstaked();
    }
}

contract StakingFuzzTest is StakeSetup {
    function setUp() public { _deploy(0); }
    function testFuzz_neverOverpays(uint96 sa, uint96 sb, uint64 r1, uint64 r2, bool aOut) public {
        sa = uint96(bound(sa, 1, 1e27)); sb = uint96(bound(sb, 1, 1e27));
        vm.prank(a); s.stake(sa); _notify(r1);
        vm.prank(b); s.stake(sb);
        if (aOut) { vm.prank(a); s.unstake(sa); }
        _notify(r2);
        uint256 ea = s.earned(a); uint256 eb = s.earned(b);
        assertLe(ea + eb, uint256(r1) + r2);
        // exact pro-rata up to rounding (<= 2 wei per notification per user)
        uint256 expA = uint256(r1) + (aOut ? 0 : uint256(r2) * sa / (uint256(sa) + sb));
        assertApproxEqAbs(ea, expA, 3);
        vm.prank(a); s.claim(); vm.prank(b); s.claim();
        assertGe(usd.balanceOf(address(s)), 0);
        assertEq(s.totalClaimed(), ea + eb);
    }
}

contract StakeHandler is Test {
    Paper10kStaking s; Tok stk; TestUSDC usd; address ex; address[3] us;
    constructor(Paper10kStaking s_, Tok t, TestUSDC u, address e) {
        s = s_; stk = t; usd = u; ex = e;
        for (uint256 i; i < 3; i++) { us[i] = address(uint160(0x1000 + i)); t.mint(us[i], 1e27); vm.prank(us[i]); t.approve(address(s_), type(uint256).max); }
    }
    function stake(uint256 i, uint256 v) external { address u = us[i % 3]; v = bound(v, 1, 1e24); vm.prank(u); s.stake(v); }
    function unstake(uint256 i, uint256 v) external { address u = us[i % 3]; uint256 st = s.staked(u); if (st == 0) return; v = bound(v, 1, st); vm.prank(u); s.unstake(v); }
    function claim(uint256 i) external { vm.prank(us[i % 3]); s.claim(); }
    function notify(uint256 v) external { if (s.totalStaked() == 0) return; v = bound(v, 0, 1e12); usd.mintTo(address(s), v); vm.prank(ex); s.notifyReward(v); }
    function sumEarned() external view returns (uint256 t) { for (uint256 i; i < 3; i++) t += s.earned(us[i]); }
    function sumStaked() external view returns (uint256 t) { for (uint256 i; i < 3; i++) t += s.staked(us[i]); }
}

contract StakingInvariantTest is StakeSetup {
    StakeHandler h;
    function setUp() public { _deploy(0); h = new StakeHandler(s, stk, usd, ex); targetContract(address(h)); }
    /// sum of claimable <= reward balance held (and <= notified - claimed)
    function invariant_claimableBacked() public view {
        assertLe(h.sumEarned(), usd.balanceOf(address(s)));
        assertLe(h.sumEarned() + s.totalClaimed(), s.totalNotified());
    }
    function invariant_stakeAccounting() public view {
        assertEq(h.sumStaked(), s.totalStaked());
        assertEq(stk.balanceOf(address(s)), s.totalStaked()); // cooldown 0: nothing pending
    }
}

/// exchange <-> staking wiring: forfeited margin share accrues, sweep pays stakers, zero stakers => back to the pool
contract StakingExchangeTest is Base {
    Paper10kStaking st;
    function setUp() public override {
        super.setUp();
        st = new Paper10kStaking(IERC20(address(x)), IERC20(address(usdc)), address(ex), 0);
        vm.prank(owner); ex.setStaking(address(st), 1000, 0, 0); // 10% of losses (test value)
    }
    function _lose() internal {
        vm.prank(alice); uint256 id = ex.open(BTC, true, 10e6, 10_000, type(uint256).max);
        _next(); orc.set(BTC, P0 * 999 / 1000); _liq(id, keeper); orc.set(BTC, P0);
    }
    function test_zeroStakersReturnsToPool() public {
        _lose();
        uint256 acc = ex.stakerAccrued(); assertGt(acc, 0);
        uint256 p0 = ex.pool(); ex.sweepStakers();
        assertEq(ex.stakerAccrued(), 0); assertEq(ex.pool(), p0 + acc);
        _solvent();
    }
    function test_sweepPaysStakers() public {
        _lose(); // alice got PAPER10KX from the liquidation
        uint256 bal = x.balanceOf(alice); assertGt(bal, 0);
        vm.startPrank(alice); x.approve(address(st), bal); st.stake(bal); vm.stopPrank();
        uint256 acc = ex.stakerAccrued();
        ex.sweepStakers();
        assertEq(usdc.balanceOf(address(st)), acc); assertApproxEqAbs(st.earned(alice), acc, 1);
        vm.prank(alice); st.claim();
        _solvent();
    }
}
