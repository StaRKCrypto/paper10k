// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {_po, _ql} from "../Helpers.sol";
import {Paper10kExchange} from "../../src/Paper10kExchange.sol";
import {Paper10kX} from "../../src/Paper10kX.sol";
import {TestUSDC} from "../../src/testnet/TestUSDC.sol";
import {IPriceOracle} from "../../src/IPriceOracle.sol";
import {ILiquidationOracle} from "../../src/ILiquidationOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHevm { function warp(uint256) external; function roll(uint256) external; }

contract EOracle is IPriceOracle, ILiquidationOracle {
    mapping(uint32 => uint256) public px; mapping(uint32 => uint256) public liq;
    function set(uint32 m, uint256 p) external { px[m] = p; liq[m] = p; }
    function setLiq(uint32 m, uint256 p) external { liq[m] = p; }
    function getPrice(uint32 m) external view returns (uint256, uint64) { return (px[m], uint64(block.timestamp)); }
    function getLiquidationPrice(uint32 m, bool) external view returns (uint256, uint64) { return (liq[m], uint64(block.timestamp)); }
    /// two-step fill price: mock ignores data, but enforces the requested publish window against block time
    function fillPrice(uint32 m, bytes[] calldata, uint64 minTs, uint64 maxTs) external payable returns (uint256) {
        require(block.timestamp >= minTs && block.timestamp <= maxTs + 30, "win"); return px[m];
    }
}

contract Actor {
    Paper10kExchange ex;
    constructor(Paper10kExchange e, TestUSDC u) { ex = e; u.mintTo(address(this), 1_000_000e6); u.approve(address(e), type(uint256).max); }
    function call(bytes calldata d) external returns (bool ok, bytes memory r) { (ok, r) = address(ex).call(d); }
}

/// @notice Echidna / Medusa property harness for PAPER10K.
/// Run: echidna test/invariants/P10KEchidna.sol --contract P10KEchidna --config test/invariants/echidna.yaml
///      medusa fuzz --config test/invariants/medusa.json
/// Properties (all `echidna_*`, return true when the property holds):
///  1 solvency: cash >= free + margin + pool + insurance; users always fully backed
///  2 owed:     after processQueue, either nothing is owed (queuedTotal==0) or the house (pool+insurance) is fully drained
///  3 limits:   no successful open ever exceeds min/maxNotional, maxWalletMargin, LP-utilisation cap, OI cap, maxLeverage
///  4 liq:      a successful liquidate() had a mark >= 2 blocks old, within TTL, and the liquidation price was past bust
///  5 owner:    no owner withdrawal path exists (removed for the immutable launch)
contract P10KEchidna {
    IHevm constant hevm = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    Paper10kExchange public ex; Paper10kX public x; TestUSDC public usdc; EOracle public orc;
    Actor[3] actors; uint256[] ids;
    uint256 constant P0 = 100_000e18; uint64 constant DELAY = 5 minutes;
    uint256[] rids; mapping(uint256 => bool) done; uint256 pendingOpenMargin;
    bool badReq; bool badOwed; bool badLimits; bool badLiq; bool badReserve;

    constructor() {
        hevm.warp(1_000_000); hevm.roll(100);
        usdc = new TestUSDC(); orc = new EOracle(); orc.set(0, P0);
        x = new Paper10kX(address(this), 1e30);
        Paper10kExchange.Params memory p = Paper10kExchange.Params({maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000,
            maxProfitMult: 100, rateMultiplier: 1000, mintPerCollateral: 100, deadbandWad: 2e12, baseRateWad: 0, minMargin: 1e6, maxMarginPerPosition: 1_000e6});
        Paper10kExchange.Ops memory o = Paper10kExchange.Ops({maxTotalDeposits: 10_000_000e6, maxPriceAge: 30, minHold: 3, bountyBps: 200, bountyCap: 10e6});
        ex = new Paper10kExchange(address(this), IERC20(address(usdc)), 6, x, orc, DELAY, p, o);
        x.setMinter(address(ex), true);
        ex.setLimits(Paper10kExchange.Limits({minNotional: 10e6, maxNotional: 1_000_000e6, maxWalletMargin: 2_000e6,
            maxLiabPoolBps: 5000, maxJumpBps: 300, jumpWindow: 60, maxPayoutPoolBps: 0, walletMaxMult: 0, mintDecayPool: 0}));
        ex.setMarket(0, true, 5_000_000e6, 5_000_000e6);
        hevm.warp(block.timestamp + DELAY);  ex.unpause();
        usdc.mintTo(address(this), 10_000_000e6); usdc.approve(address(ex), type(uint256).max); ex.seedPool(200_000e6);
        for (uint256 i; i < 3; i++) { actors[i] = new Actor(ex, usdc); actors[i].call(abi.encodeCall(ex.deposit, (100_000e6))); }
    }

    function _a(uint256 i) internal view returns (Actor) { return actors[i % 3]; }
    function _tick(uint256 s) internal { hevm.warp(block.timestamp + (s % 20)); hevm.roll(block.number + 1); orc.set(0, orc.px(0)); }

    // ------------------------------------------------------------------ actions
    function deposit(uint256 i, uint256 a) external { _a(i).call(abi.encodeCall(ex.deposit, (1 + a % 50_000e6))); }
    function withdraw(uint256 i, uint256 a) external { _a(i).call(abi.encodeCall(ex.withdraw, (1 + a % 50_000e6))); }
    function move(int256 bps) external { int256 b = bps % 300; uint256 pr = orc.px(0); orc.set(0, uint256(int256(pr) + int256(pr) * b / 10_000)); }
    function nudgeLiq(int256 bps) external { int256 b = bps % 50; uint256 pr = orc.px(0); orc.setLiq(0, uint256(int256(pr) + int256(pr) * b / 10_000)); }
    function pass(uint256 s) external { _tick(s); }
    function fundInsurance(uint256 a) external { ex.fundInsurance(1 + a % 10_000e6); }

    function open(uint256 i, bool isLong, uint256 m, uint256 lev) external {
        Actor ac = _a(i); m = 1e6 + m % 1_500e6; lev = 1 + lev % 12_000;
        (uint128 minN, uint128 maxN, uint128 maxW, uint32 lpBps,,,,,) = ex.limits();
        uint256 houseBefore = ex.pool() + ex.insurance();
        (bool ok, bytes memory r) = ac.call(abi.encodeCall(ex.open, (0, isLong, m, uint32(lev), isLong ? type(uint256).max : 0)));
        if (!ok) return;
        uint256 id = abi.decode(r, (uint256)); ids.push(id);
        uint256 n = m * lev;
        (,,, uint256 capL, uint256 capS, uint256 oiL, uint256 oiS) = _mkt();
        uint256 liab = isLong ? ex.liabLong(0) : ex.liabShort(0);
        if (lev > 10_000 || n < minN || n > maxN || ex.walletMargin(address(ac)) > maxW
            || liab * 10_000 > houseBefore * lpBps || oiL > capL || oiS > capS) badLimits = true;
    }
    function _mkt() internal view returns (bool, bool, uint256, uint256, uint256, uint256, uint256) {
        (bool l, bool o, uint256 cl, uint256 cs, uint256 ol, uint256 os) = ex.markets(0); return (l, o, 0, cl, cs, ol, os);
    }
    function close(uint256 k) external {
        if (ids.length == 0) return; uint256 id = ids[k % ids.length]; (address o,,,,,,,,,) = ex.positions(id); if (o == address(0)) return;
        Actor(o).call(abi.encodeCall(ex.close, (id)));
    }
    function mark(uint256 k) external { if (ids.length == 0) return; try ex.markLiquidatable(ids[k % ids.length]) {} catch {} }
    function liquidate(uint256 k) external {
        if (ids.length == 0) return; uint256 id = ids[k % ids.length];
        if (_po(ex, id) == address(0)) return;
        (uint32 mb, uint64 mts) = ex.marks(id);
        uint256 bust = ex.bustPriceOf(id);
        (,,,, bool isLong,,,,,) = ex.positions(id);
        (uint256 lp,) = orc.getLiquidationPrice(0, isLong);
        try ex.liquidate(id) {
            bool past = isLong ? lp <= bust : lp >= bust;
            if (mb == 0 || block.number < uint256(mb) + 2 || block.timestamp > mts + 120 || !past) badLiq = true;
        } catch {}
    }
    /// mark -> wait the two-block window (within TTL) -> liquidate, in one fuzz step so the TTL is reachable
    function markThenLiquidate(uint256 k, int256 bps) external {
        if (ids.length == 0) return; uint256 id = ids[k % ids.length];
        try ex.markLiquidatable(id) {} catch {}
        hevm.roll(block.number + 2); hevm.warp(block.timestamp + 2);
        int256 b = bps % 30; uint256 pr = orc.px(0); orc.setLiq(0, uint256(int256(pr) + int256(pr) * b / 10_000));
        this.liquidate(k);
    }
    function drainQueue() external {
        ex.processQueue(type(uint256).max);
        if (ex.queuedTotal() != 0 && ex.pool() + ex.insurance() != 0) badOwed = true;
    }
    /// owner withdrawals were removed (no owner path to house capital); this property now asserts that the
    /// owner cannot pull collateral by any remaining call: cash only leaves via user withdraw()
    function ownerCannotWithdraw() external {
        uint256 b0 = usdc.balanceOf(address(this));
        (bool ok,) = address(ex).call(abi.encodeWithSignature("applyWithdraw()"));
        if (ok || usdc.balanceOf(address(this)) > b0) badReserve = true;
    }

    // ------------------------------------------------------------------ two-step orders
    function requestOpen(uint256 i, bool isLong, uint256 m, uint256 lev, bool tight) external {
        Actor ac = _a(i); m = 1e6 + m % 1_500e6; lev = 1 + lev % 12_000;
        uint256 w = tight ? orc.px(0) : (isLong ? type(uint128).max : 0);
        uint256 f0 = ex.free(address(ac));
        (bool ok, bytes memory r) = ac.call(abi.encodeCall(ex.requestOpen, (0, isLong, m, uint32(lev), w)));
        if (!ok) return;
        if (ex.free(address(ac)) + m != f0) badReq = true; // margin must be locked exactly
        rids.push(abi.decode(r, (uint256))); pendingOpenMargin += m;
    }
    function requestClose(uint256 k) external {
        if (ids.length == 0) return; uint256 id = ids[k % ids.length]; address o = _po(ex, id); if (o == address(0)) return;
        uint256 n0 = ex.nextReq();
        (bool ok,) = Actor(o).call(abi.encodeCall(ex.requestClose, (id)));
        if (ok) rids.push(n0);
    }
    function _rid(uint256 k) internal view returns (uint256) { return rids.length == 0 ? 0 : rids[k % rids.length]; }
    function fill(uint256 k, uint256 dt) external {
        uint256 rid = _rid(k); if (rid == 0) return;
        (address tr, uint64 ts,,,, uint128 m,, uint256 pid) = ex.reqs(rid);
        hevm.warp(block.timestamp + dt % 15); hevm.roll(block.number + 1);
        uint256 tm0 = ex.totalMargin(); uint256 n0 = ex.nextPositionId();
        try ex.fill(rid, new bytes[](0)) {
            if (ts == 0 || done[rid]) badReq = true; // never fill an empty / consumed request
            done[rid] = true;
            if (pid == 0) {
                pendingOpenMargin -= m;
                if (ex.nextPositionId() > n0) { ids.push(n0); if (_po(ex, n0) != tr) badReq = true; }
                else if (ex.totalMargin() + m != tm0) badReq = true; // failed open => full refund
            }
        } catch {}
    }
    function cancel(uint256 k, bool late) external {
        uint256 rid = _rid(k); if (rid == 0) return;
        (, uint64 ts,,,, uint128 m,, uint256 pid) = ex.reqs(rid);
        if (late) hevm.warp(block.timestamp + 1 days + 1);
        try ex.cancelRequest(rid) {
            if (ts == 0 || block.timestamp <= ts + 1 days) badReq = true;
            done[rid] = true; if (pid == 0) pendingOpenMargin -= m;
        } catch {}
    }

    // ------------------------------------------------------------------ properties
    function echidna_requests_sound() external view returns (bool) { return !badReq && ex.totalMargin() >= pendingOpenMargin; }
    function echidna_solvency() external view returns (bool) {
        return usdc.balanceOf(address(ex)) >= ex.totalFree() + ex.totalMargin() + ex.pool() + ex.insurance();
    }
    function echidna_users_backed() external view returns (bool) { return usdc.balanceOf(address(ex)) >= ex.totalFree() + ex.totalMargin(); }
    function echidna_owed_paid_when_funds_exist() external view returns (bool) { return !badOwed; }
    function echidna_no_open_beyond_limits() external view returns (bool) { return !badLimits; }
    function echidna_liq_only_underwater_after_two_blocks() external view returns (bool) { return !badLiq; }
    function echidna_owner_cannot_withdraw() external view returns (bool) { return !badReserve; }
}
