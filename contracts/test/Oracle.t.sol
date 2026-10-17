// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Exchange.t.sol";
import {SignedPriceOracle} from "../src/SignedPriceOracle.sol";
import {HyperCoreBboOracle} from "../src/HyperCoreBboOracle.sol";
import {Paper10kX} from "../src/Paper10kX.sol";

contract MockPrecompile {
    uint64 public bid; uint64 public ask;
    function set(uint64 b, uint64 a) external { bid = b; ask = a; }
    fallback(bytes calldata) external returns (bytes memory) { return abi.encode(bid, ask); }
}

contract OracleTest is Base {
    SignedPriceOracle so; uint256 sk; address sgn;
    function setUp() public override {
        super.setUp();
        (sgn, sk) = makeAddrAndKey("signer");
        so = new SignedPriceOracle(owner, sgn);
    }
    function _sig(uint32 m, uint256 p, uint64 ts, uint256 key) internal view returns (bytes memory) {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", so.domainSeparator(), keccak256(abi.encode(so.PRICE_TYPEHASH(), m, p, ts))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }
    function test_accepts_and_rejects() public {
        uint64 ts = uint64(block.timestamp);
        so.updatePrice(0, 100e18, ts, _sig(0, 100e18, ts, sk));
        (uint256 p,) = so.getPrice(0); assertEq(p, 100e18);
        // replay / older / same ts
        bytes memory s1 = _sig(0, 100e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.NotNewer.selector); so.updatePrice(0, 100e18, ts, s1);
        // bad signer
        (, uint256 k2) = makeAddrAndKey("evil");
        vm.warp(block.timestamp + 1); ts++;
        bytes memory bad = _sig(0, 101e18, ts, k2);
        vm.expectRevert(SignedPriceOracle.BadSig.selector); so.updatePrice(0, 101e18, ts, bad);
        // jump > 5%
        bytes memory j = _sig(0, 110e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.Jump.selector); so.updatePrice(0, 110e18, ts, j);
        // future
        bytes memory f = _sig(0, 101e18, ts + 100, sk);
        vm.expectRevert(SignedPriceOracle.Future.selector); so.updatePrice(0, 101e18, ts + 100, f);
        // tampered price with valid sig for other price
        bytes memory t = _sig(0, 101e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.BadSig.selector); so.updatePrice(0, 102e18, ts, t);
        // stale
        vm.warp(block.timestamp + 120);
        bytes memory st = _sig(0, 101e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.Stale.selector); so.updatePrice(0, 101e18, ts, st);
    }
    function test_onlyOwnerAdmin() public {
        vm.expectRevert(); so.setSigner(alice);
        vm.expectRevert(); so.forcePrice(0, 1e18);
        vm.prank(owner); so.forcePrice(0, 1e18);
    }
    function test_hyperCoreAdapter() public {
        MockPrecompile pc = new MockPrecompile();
        HyperCoreBboOracle h = new HyperCoreBboOracle(owner, address(pc));
        vm.prank(owner); h.configure(0, 0, 5); // BTC szDecimals=5 -> px decimals 1
        pc.set(1_000_000, 1_000_010); // 100000.0 / 100001.0 (1 decimal)
        (uint256 p, uint64 ts) = h.getPrice(0);
        assertEq(p, 1_000_005e17 / 1); // mid 1000005 *1e17
        assertEq(ts, block.timestamp);
        pc.set(1_000_000, 1_100_000); // 10% spread -> rejected
        (p,) = h.getPrice(0); assertEq(p, 0);
        pc.set(0, 0); (p,) = h.getPrice(0); assertEq(p, 0);
        (p,) = h.getPrice(7); assertEq(p, 0); // unconfigured
    }
}

contract TokenTest is Base {
    function test_onlyMinterAndNonTransferable() public {
        vm.expectRevert(Paper10kX.NotMinter.selector); x.mint(alice, 1);
        vm.prank(alice); uint256 id = ex.open(0, true, 10e6, 10_000, P0);
        orc.set(0, P0 / 2); ex.liquidate(id);
        uint256 b = x.balanceOf(alice); assertGt(b, 0);
        vm.prank(alice); vm.expectRevert(Paper10kX.TransfersDisabled.selector); x.transfer(bob, 1);
        vm.prank(alice); x.burn(1); // holder may burn
        vm.prank(owner); vm.expectRevert(Paper10kX.MinterIsLocked.selector); x.setMinter(owner, false);
    }
    function test_capNeverReverts() public {
        Paper10kX t = new Paper10kX(owner, 100);
        vm.prank(owner); t.setMinter(address(this), false);
        assertEq(t.mint(alice, 80), 80); assertEq(t.mint(alice, 80), 20); assertEq(t.mint(alice, 80), 0);
    }
}

contract FuzzTest is Base {
    /// any price path: a position never costs the user more than its margin, never pays more than 100x margin
    function testFuzz_settlementBounds(uint32 lev, bool isLong, uint256 move, bool up, uint96 margin) public {
        lev = uint32(bound(lev, 1, 10_000)); margin = uint96(bound(margin, 1e6, 1_000e6));
        move = bound(move, 0, 5e17); // up to 50%
        vm.prank(alice); uint256 id = ex.open(0, isLong, margin, lev, isLong ? type(uint256).max : 0);
        uint256 np = up ? P0 + P0 * move / 1e18 : P0 - P0 * move / 1e18;
        orc.set(0, np);
        vm.warp(block.timestamp + 5); orc.set(0, np);
        uint256 freeBefore = ex.free(alice); uint256 qBefore = ex.queuedOf(alice);
        vm.prank(alice); ex.close(id);
        uint256 got = ex.free(alice) + ex.queuedOf(alice) - qBefore - freeBefore; // returned margin + profit (paid or queued)
        assertLe(got, uint256(margin) + uint256(margin) * 100);
        _solvent();
        // loss side: user's total after never below 0 and pool never decreases on a loss
    }
    function testFuzz_depositWithdrawRoundtrip(uint96 a) public {
        a = uint96(bound(a, 1, 5_000e6));
        uint256 f = ex.free(alice);
        vm.startPrank(alice); ex.withdraw(a > f ? f : a); vm.stopPrank();
        _solvent();
    }
}
