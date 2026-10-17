// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, MockOracle} from "./Base.t.sol";
import {SignedPriceOracle} from "../src/testnet/SignedPriceOracle.sol";
import {HyperCoreOracle} from "../src/HyperCoreOracle.sol";
import {PythReference, IPythLike} from "../src/PythReference.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {Paper10kX} from "../src/Paper10kX.sol";

contract MockBbo { uint64 public bid; uint64 public ask; bool public fail;
    function set(uint64 b, uint64 a) external { bid = b; ask = a; }
    function setFail(bool f) external { fail = f; }
    fallback(bytes calldata) external returns (bytes memory) { require(!fail, "boom"); return abi.encode(bid, ask); } }
contract MockOraclePx { uint64 public p; function set(uint64 v) external { p = v; }
    fallback(bytes calldata) external returns (bytes memory) { return abi.encode(p); } }
contract MockPyth is IPythLike {
    Price pr; function set(int64 p, uint64 c, int32 e, uint256 t) external { pr = Price(p, c, e, t); }
    function getPriceUnsafe(bytes32) external view returns (Price memory) { return pr; }
}
contract MockRef is IPriceOracle { uint256 p; uint64 t; function set(uint256 a, uint64 b) external { p = a; t = b; } function getPrice(uint32) external view returns (uint256, uint64) { return (p, t); } }

contract HyperCoreOracleTest is Base {
    MockBbo bbo; MockOraclePx opx; HyperCoreOracle h;
    function setUp() public override {
        super.setUp();
        bbo = new MockBbo(); opx = new MockOraclePx();
        h = new HyperCoreOracle(owner, address(bbo), address(opx));
        vm.prank(owner); h.configure(0, 0, 5);   // BTC szDecimals=5 -> 1 decimal
        bbo.set(1_000_000, 1_000_010); opx.set(1_000_005);
    }
    function test_midAndScaling() public view {
        (uint256 p, uint64 ts) = h.getPrice(0);
        assertEq(p, 1_000_005 * 1e17); assertEq(ts, block.timestamp); // $100,000.5
    }
    function test_failsClosed() public {
        bbo.set(1_000_000, 1_100_000); (uint256 p,) = h.getPrice(0); assertEq(p, 0);   // wide spread
        bbo.set(1_000_000, 1_000_010); opx.set(1_050_000); (p,) = h.getPrice(0); assertEq(p, 0); // deviates 5% from oraclePx
        opx.set(0); (p,) = h.getPrice(0); assertEq(p, 0);
        opx.set(1_000_005); bbo.set(0, 0); (p,) = h.getPrice(0); assertEq(p, 0);
        bbo.set(1_000_020, 1_000_010); (p,) = h.getPrice(0); assertEq(p, 0);            // crossed
        bbo.set(1_000_000, 1_000_010); bbo.setFail(true); (p,) = h.getPrice(0); assertEq(p, 0); // precompile reverts
        bbo.setFail(false); (p,) = h.getPrice(7); assertEq(p, 0);                       // unconfigured
        (p,) = h.getPrice(0); assertGt(p, 0);
    }
    function test_refOracleDeviationAndStaleness() public {
        MockRef r = new MockRef();
        vm.prank(owner); h.setGuards(30, 100, IPriceOracle(address(r)), 100, 30);
        r.set(100_000e18, uint64(block.timestamp));
        (uint256 p,) = h.getPrice(0); assertGt(p, 0);
        r.set(102_000e18, uint64(block.timestamp)); (p,) = h.getPrice(0); assertEq(p, 0);   // 2% off the reference
        r.set(100_000e18, uint64(block.timestamp - 31)); (p,) = h.getPrice(0); assertEq(p, 0); // stale reference
        r.set(0, 0); (p,) = h.getPrice(0); assertEq(p, 0);
    }
    function test_onlyOwnerConfig() public {
        vm.expectRevert(); h.configure(1, 1, 4);
        vm.expectRevert(); h.setGuards(30, 100, IPriceOracle(address(0)), 100, 30);
        vm.prank(owner); vm.expectRevert(); h.setGuards(0, 100, IPriceOracle(address(0)), 100, 30);
    }
    function test_pythAdapter() public {
        MockPyth py = new MockPyth(); PythReference pr = new PythReference(owner, address(py));
        vm.prank(owner); pr.setFeed(0, bytes32(uint256(1)));
        py.set(8_200_000_000_000, 1_000_000_000, -8, block.timestamp);          // $82,000 ± $10
        (uint256 p, uint64 t) = pr.getPrice(0); assertEq(p, 82_000e18); assertEq(t, block.timestamp);
        py.set(8_200_000_000_000, 80_000_000_000, -8, block.timestamp);         // conf ~1% > 0.5%
        (p,) = pr.getPrice(0); assertEq(p, 0);
        py.set(-1, 0, -8, block.timestamp); (p,) = pr.getPrice(0); assertEq(p, 0);
        py.set(1, 0, 3, block.timestamp); (p,) = pr.getPrice(0); assertEq(p, 0);
        (p,) = pr.getPrice(5); assertEq(p, 0);
    }
    /// exchange refuses to trade when the oracle fails closed
    function test_exchangeHaltsWhenOracleGuardTrips() public {
        vm.prank(owner); ex.proposeOracle(h); vm.warp(block.timestamp + DELAY); vm.prank(owner); ex.applyOracle();
        // market 0 maps to BTC; price = 100000.5e18
        vm.prank(alice); ex.open(BTC, true, 10e6, 10, type(uint256).max);
        bbo.set(1_000_000, 1_100_000);
        vm.prank(alice); vm.expectRevert(); ex.open(BTC, true, 10e6, 10, type(uint256).max);
    }
}

contract SignedOracleTest is Base {
    SignedPriceOracle so; uint256 sk; address sgn;
    function setUp() public override { super.setUp(); (sgn, sk) = makeAddrAndKey("signer"); so = new SignedPriceOracle(owner, sgn); }
    function _sig(uint32 m, uint256 p, uint64 ts, uint256 key) internal view returns (bytes memory) {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", so.domainSeparator(), keccak256(abi.encode(so.PRICE_TYPEHASH(), m, p, ts))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d); return abi.encodePacked(r, s, v);
    }
    function test_accepts_and_rejects() public {
        uint64 ts = uint64(block.timestamp);
        so.updatePrice(0, 100e18, ts, _sig(0, 100e18, ts, sk));
        (uint256 p,) = so.getPrice(0); assertEq(p, 100e18);
        bytes memory s1 = _sig(0, 100e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.NotNewer.selector); so.updatePrice(0, 100e18, ts, s1);
        (, uint256 k2) = makeAddrAndKey("evil"); vm.warp(block.timestamp + 1); ts++;
        bytes memory bad = _sig(0, 101e18, ts, k2);
        vm.expectRevert(SignedPriceOracle.BadSig.selector); so.updatePrice(0, 101e18, ts, bad);
        bytes memory j = _sig(0, 110e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.Jump.selector); so.updatePrice(0, 110e18, ts, j);
        bytes memory f = _sig(0, 101e18, ts + 100, sk);
        vm.expectRevert(SignedPriceOracle.Future.selector); so.updatePrice(0, 101e18, ts + 100, f);
        bytes memory t = _sig(0, 101e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.BadSig.selector); so.updatePrice(0, 102e18, ts, t);
        vm.warp(block.timestamp + 120);
        bytes memory st = _sig(0, 101e18, ts, sk);
        vm.expectRevert(SignedPriceOracle.Stale.selector); so.updatePrice(0, 101e18, ts, st);
    }
}

contract TokenTest is Base {
    function test_onlyMinterAndNonTransferable() public {
        vm.expectRevert(Paper10kX.NotMinter.selector); x.mint(alice, 1);
        vm.prank(alice); uint256 id = ex.open(0, true, 10e6, 10_000, P0);
        orc.set(0, P0 / 2); ex.liquidate(id);
        assertGt(x.balanceOf(alice), 0);
        vm.prank(alice); vm.expectRevert(Paper10kX.TransfersDisabled.selector); x.transfer(bob, 1);
        vm.prank(alice); x.burn(1);
        vm.prank(owner); vm.expectRevert(Paper10kX.MinterIsLocked.selector); x.setMinter(owner, false);
    }
    function test_capNeverReverts() public {
        Paper10kX t = new Paper10kX(owner, 100);
        vm.prank(owner); t.setMinter(address(this), false);
        assertEq(t.mint(alice, 80), 80); assertEq(t.mint(alice, 80), 20); assertEq(t.mint(alice, 80), 0);
    }
    function testFuzz_mintOnlyFromLiquidationAmountExact(uint96 margin, uint16 lev) public {
        margin = uint96(bound(margin, 1e6, 1_000e6)); lev = uint16(bound(lev, 1, 10_000));
        vm.prank(alice); uint256 id = ex.open(0, true, margin, lev, P0);
        orc.set(0, 1); // crash
        vm.warp(block.timestamp + 1); orc.set(0, 1);
        ex.liquidate(id);
        assertEq(x.balanceOf(alice), uint256(margin) * 1e12 * 100);
    }
}
