// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, MockOracle} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

contract Handler is Base {
    address[3] users;
    uint256[] public ids;
    mapping(uint256 => uint256) public bustAtOpen;
    mapping(uint256 => uint256) public marginOf;
    mapping(uint256 => bool) public isOpen;
    uint256 public ghostMargin;
    uint256 public nOpen; uint256 public nLiq; uint256 public nClose; uint256 public nCfg; uint256 public nWd;
    uint256 public maxVersionSeen;

    function init(Paper10kExchange e, MockOracle o, address[3] memory u, address own, address t) external { bBps = 200; bCap = 10e6; ex = e; orc = o; users = u; owner = own; usdc = TestUSDC_(t); }
    // (type alias to avoid importing twice)
    function dep(uint256 u, uint256 a) external { address x_ = users[u % 3]; a = bound(a, 1e6, 500e6); vm.prank(x_); try ex.deposit(a) {} catch {} }
    function wd(uint256 u, uint256 a) external { address x_ = users[u % 3]; a = bound(a, 1, 500e6); vm.prank(x_); try ex.withdraw(a) {} catch {} }
    function open(uint256 u, bool l, uint256 m, uint256 lev) external {
        address x_ = users[u % 3]; m = bound(m, 1e6, 200e6); lev = bound(lev, 1, 10_000);
        vm.prank(x_);
        try ex.open(0, l, m, uint32(lev), l ? type(uint256).max : 0) returns (uint256 id) {
            ids.push(id); isOpen[id] = true; marginOf[id] = m; ghostMargin += m; bustAtOpen[id] = ex.bustPriceOf(id); nOpen++;
        } catch {}
    }
    function mv(int256 bps) external { bps = bound(bps, -300, 300); uint256 p = orc.px(0); orc.set(0, uint256(int256(p) + int256(p) * bps / 10_000)); }
    function pass(uint256 s) external { vm.warp(block.timestamp + bound(s, 0, 20)); vm.roll(block.number + 1); orc.set(0, orc.px(0)); }
    function _settled(uint256 id) internal { if (isOpen[id] && ex.positionOwner(id) == address(0)) { isOpen[id] = false; ghostMargin -= marginOf[id]; } }
    function cls(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length]; address o = ex.positionOwner(id);
        vm.prank(o); try ex.close(id) { nClose++; } catch {} _settled(id);
    }
    function liq(uint256 i) external { if (ids.length == 0) return; uint256 id = ids[i % ids.length]; try ex.markLiquidatable(id) {} catch {} vm.roll(block.number + 2); vm.warp(block.timestamp + 2); orc.set(0, orc.px(0));
        uint256 f0 = ex.free(address(this)); uint256 m = marginOf[id];
        try ex.liquidate(id) {
            nLiq++; uint256 d = ex.free(address(this)) - f0; bountyTotal += d;
            uint256 max = m * 200 / 10_000; if (max > 10e6) max = 10e6;
            if (d > max) badBounty = true;
        } catch {} _settled(id); }
    /// owner of the position liquidates it himself: must earn nothing
    function selfLiq(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length]; address o = ex.positionOwner(id); if (o == address(0)) return;
        try ex.markLiquidatable(id) {} catch {} vm.roll(block.number + 2); vm.warp(block.timestamp + 2); orc.set(0, orc.px(0));
        uint256 f0 = ex.free(o);
        vm.prank(o); try ex.liquidate(id) { nLiq++; if (ex.free(o) != f0) badBounty = true; } catch {} _settled(id); }
    bool public badLiq; bool public ownerBreach; bool public badBounty; uint256 public bountyTotal;
    function mark(uint256 i) external { if (ids.length == 0) return; try ex.markLiquidatable(ids[i % ids.length]) {} catch {} }
    function nudge(int256 bps) external { bps = bound(bps, -50, 50); uint256 p = orc.px(0); orc.setLiq(0, uint256(int256(p) + int256(p) * bps / 10_000)); }
    function liqEarly(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        (uint32 mb,) = ex.marks(id); uint256 bn = block.number;
        try ex.liquidate(id) { if (mb == 0 || bn < uint256(mb) + 2) badLiq = true; nLiq++; } catch {} _settled(id);
    }
    function q(uint256 n) external { ex.processQueue(bound(n, 1, 10)); }
    function fundIns(uint256 a) external { a = bound(a, 1e6, 100e6); usdc.mintTo(address(this), a); usdc.approve(address(ex), a); ex.fundInsurance(a); }
    function cfg(uint256 s) external {
        Paper10kExchange.Params memory p = defParams();
        p.maintBps = uint16(bound(s, 100, 5000)); p.winFeeBps = uint16(bound(s >> 8, 0, 1000)); p.maxProfitMult = uint16(bound(s >> 16, 1, 10_000));
        p.rateMultiplier = uint32(bound(s >> 24, 1, 1e6)); p.deadbandWad = uint64(bound(s >> 40, 0, 1e16)); p.insuranceBps = uint16(bound(s >> 56, 0, 5000));
        vm.startPrank(owner); ex.proposeConfig(p, defOps()); vm.warp(block.timestamp + DELAY); try ex.applyConfig() { nCfg++; } catch {} vm.stopPrank();
        vm.roll(block.number + 1); orc.set(0, orc.px(0));
        uint256 v = ex.paramsVersion(); if (v > maxVersionSeen) maxVersionSeen = v;
    }
    function ownerWd(uint256 a, bool ins) external {
        a = bound(a, 1, 2_000e6);
        vm.startPrank(owner); ex.proposeWithdraw(owner, a, ins); vm.warp(block.timestamp + DELAY); uint256 resB = ex.reservedLiability(); try ex.applyWithdraw() { nWd++; if (ex.pool() + ex.insurance() < resB) ownerBreach = true; } catch {} vm.stopPrank();
        vm.roll(block.number + 1); orc.set(0, orc.px(0));
    }
    function liveIds() external view returns (uint256[] memory) { return ids; }
}
import {TestUSDC as TestUSDC_} from "../src/testnet/TestUSDC.sol";

contract InvariantTest is StdInvariant, Base {
    Handler h;
    function setUp() public override {
        bBps = 200; bCap = 10e6;
        super.setUp();
        h = new Handler();
        h.init(ex, orc, [alice, bob, address(0xC0C)], owner, address(usdc));
        _fund(address(0xC0C), 10_000e6);
        vm.prank(owner); // handler acts via pranks of users; give each user approvals (done in _fund)
        bytes4[] memory sel = new bytes4[](14);
        sel[0]=Handler.dep.selector; sel[1]=Handler.wd.selector; sel[2]=Handler.open.selector; sel[3]=Handler.mv.selector; sel[4]=Handler.pass.selector;
        sel[5]=Handler.cls.selector; sel[6]=Handler.liq.selector; sel[7]=Handler.q.selector; sel[8]=Handler.cfg.selector; sel[9]=Handler.ownerWd.selector; sel[10]=Handler.mark.selector; sel[11]=Handler.nudge.selector; sel[12]=Handler.liqEarly.selector; sel[13]=Handler.selfLiq.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        bytes4[] memory s2 = new bytes4[](1); s2[0] = Handler.fundIns.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s2}));
        targetContract(address(h));
        excludeSender(address(0)); excludeSender(address(ex)); excludeSender(address(x)); excludeSender(address(usdc));
        excludeSender(address(orc)); excludeSender(address(h)); excludeSender(address(this));
    }
    /// EXACT cash conservation (no donations occur): contract cash == free + margin + pool + insurance
    function invariant_cashConservedExactly() public view {
        assertEq(usdc.balanceOf(address(ex)), ex.totalFree() + ex.totalMargin() + ex.pool() + ex.insurance());
    }
    /// sum of margins of positions we know are open equals totalMargin
    function invariant_marginGhost() public view { assertEq(ex.totalMargin(), h.ghostMargin()); }
    function invariant_queueSum() public view {
        uint256 s; for (uint256 i = ex.queueHead(); i < ex.queueLength() + ex.queueHead(); i++) { (, uint256 a) = ex.queue(i); s += a; }
        assertEq(s, ex.queuedTotal());
    }
    function invariant_pxCap() public view { assertLe(x.totalSupply(), x.maxSupply()); }
    function invariant_freeSum() public view {
        assertEq(ex.free(alice) + ex.free(bob) + ex.free(address(0xC0C)) + ex.free(owner) + ex.free(address(h)), ex.totalFree());
    }
    /// open interest bookkeeping: market OI equals sum of notionals of open positions
    function invariant_oi() public view {
        (,,,, uint256 oiL, uint256 oiS) = ex.markets(0);
        uint256 l; uint256 s; uint256[] memory ids = h.liveIds();
        for (uint256 i = 0; i < ids.length; i++) { (address o,,,,bool isLong,, uint128 notional,,,) = ex.positions(ids[i]); if (o != address(0)) { if (isLong) l += notional; else s += notional; } }
        assertEq(oiL, l); assertEq(oiS, s);
    }
    /// THE governance guarantee: no config change ever moves an already-open position's bust price
    function invariant_bustFrozenAtOpen() public view {
        uint256[] memory ids = h.liveIds();
        for (uint256 i = 0; i < ids.length; i++) { if (ex.positionOwner(ids[i]) != address(0)) assertEq(ex.bustPriceOf(ids[i]), h.bustAtOpen(ids[i])); }
    }
    /// params version only ever grows; positions reference existing versions
    function invariant_versionMonotone() public view { assertGe(ex.paramsVersion(), h.maxVersionSeen()); }
    /// owner cannot drain: users' free balances + margins are always fully backed by cash
    function invariant_usersFullyBacked() public view { assertGe(usdc.balanceOf(address(ex)), ex.totalFree() + ex.totalMargin()); }
    /// v4: liquidation never happens without a >=2-block-old mark
    function invariant_noLiquidationWithoutPersistence() public view { assertFalse(h.badLiq()); }
    /// v4: marks only exist for open positions
    function invariant_marksOnlyForOpenPositions() public view {
        uint256[] memory ids = h.liveIds();
        for (uint256 i = 0; i < ids.length; i++) { if (ex.positionOwner(ids[i]) == address(0)) { (uint32 b,) = ex.marks(ids[i]); assertEq(b, 0); } }
    }
    /// v4: reserved liability equals the recomputed worst case (max side per market) from the open positions
    function invariant_reservedLiabilityMatches() public view {
        uint256[] memory ids = h.liveIds(); uint256 l; uint256 sh;
        for (uint256 i = 0; i < ids.length; i++) {
            (address o,,, uint32 pv, bool isLong, uint128 margin,,,,) = ex.positions(ids[i]);
            if (o == address(0)) continue;
            (,,,, uint16 mult,,,,,,) = ex.paramsHistory(pv);
            if (isLong) l += uint256(margin) * mult; else sh += uint256(margin) * mult;
        }
        assertEq(ex.reservedLiability(), l > sh ? l : sh);
    }
    /// v4 F7: when owner withdrawals succeeded, house cash still covered the reserve at that time -> checked by Reserved(); here: cash never below reserve unless it was already below before (no owner-caused breach)
    function invariant_ownerNeverCausedReserveBreach() public view { assertFalse(h.ownerBreach()); }
    /// v5: bounty never exceeds min(2% margin, cap) and self-liquidation never earns one
    function invariant_bountyBoundedAndNeverSelfPaid() public view { assertFalse(h.badBounty()); }
}
