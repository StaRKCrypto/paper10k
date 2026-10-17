// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, MockOracle} from "./Exchange.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {console} from "forge-std/console.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

/// @dev random sequence of deposits/withdrawals/opens/closes/liquidations/price moves/queue runs
contract Handler is Base {
    address[3] users;
    uint256[] ids;
    uint256 public nOpen; uint256 public nLiq; uint256 public nClose;

    function init(Paper10kExchange e, MockOracle o, address[3] memory u) external {
        ex = e; orc = o; users = u;
    }
    function dep(uint256 u, uint256 a) external {
        address x_ = users[u % 3]; a = bound(a, 1e6, 500e6);
        vm.startPrank(x_); try ex.deposit(a) {} catch {} vm.stopPrank();
    }
    function wd(uint256 u, uint256 a) external {
        address x_ = users[u % 3]; a = bound(a, 1, 500e6);
        vm.prank(x_); try ex.withdraw(a) {} catch {}
    }
    function open(uint256 u, bool l, uint256 m, uint256 lev) external {
        address x_ = users[u % 3]; m = bound(m, 1e6, 200e6); lev = bound(lev, 1, 10_000);
        vm.prank(x_);
        try ex.open(0, l, m, uint32(lev), l ? type(uint256).max : 0) returns (uint256 id) { ids.push(id); nOpen++; } catch {}
    }
    function mv(int256 bps) external {
        bps = bound(bps, -300, 300);
        uint256 p = orc.px(0);
        orc.set(0, uint256(int256(p) + int256(p) * bps / 10_000));
    }
    function pass(uint256 s) external { vm.warp(block.timestamp + bound(s, 0, 20)); orc.set(0, orc.px(0)); }
    function cls(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        (address o,,,,,,,,) = ex.positions(id);
        vm.prank(o); try ex.close(id) { nClose++; } catch {}
    }
    function liq(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        try ex.liquidate(id) { nLiq++; } catch {}
    }
    function q(uint256 n) external { ex.processQueue(bound(n, 1, 10)); }
}

contract InvariantTest is StdInvariant, Base {
    Handler h;
    function setUp() public override {
        super.setUp();
        h = new Handler();
        h.init(ex, orc, [alice, bob, address(0xC0C)]);
        _fund(address(0xC0C), 10_000e6);
        // handler runs as test-contract callee but acts through vm.prank inside itself
        bytes4[] memory sel = new bytes4[](8);
        sel[0]=Handler.dep.selector; sel[1]=Handler.wd.selector; sel[2]=Handler.open.selector; sel[3]=Handler.mv.selector;
        sel[4]=Handler.pass.selector; sel[5]=Handler.cls.selector; sel[6]=Handler.liq.selector; sel[7]=Handler.q.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        excludeSender(address(0));
    }
    /// cash invariant: contract always holds at least all free balances + margins + pool
    function invariant_solvent() public view { _solvent(); }
    /// queued debt bookkeeping consistent
    function invariant_queueSum() public view {
        uint256 s;
        for (uint256 i = ex.queueHead(); i < ex.queueLength() + ex.queueHead(); i++) { (, uint256 a) = ex.queue(i); s += a; }
        assertEq(s, ex.queuedTotal());
    }
    function afterInvariant() public view { console.log("open/close/liq", h.nOpen(), h.nClose(), h.nLiq()); }
    /// supply of PAPER10KX never exceeds cap
    function invariant_pxCap() public view { assertLe(x.totalSupply(), x.maxSupply()); }
    /// sum of user free balances == totalFree
    function invariant_free() public view {
        assertEq(ex.free(alice) + ex.free(bob) + ex.free(address(0xC0C)) + ex.free(owner), ex.totalFree());
    }
}
