// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {ILiquidationOracle} from "../src/ILiquidationOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOracle is IPriceOracle, ILiquidationOracle {
    mapping(uint32 => uint256) public px;
    mapping(uint32 => uint256) public liqPx;   // 0 => follows px
    bool public liqDown;
    function set(uint32 m, uint256 p) external { px[m] = p; }
    function setLiq(uint32 m, uint256 p) external { liqPx[m] = p; }
    function setLiqDown(bool d) external { liqDown = d; }
    function getLiquidationPrice(uint32 m, bool) external view returns (uint256, uint64) {
        if (liqDown) return (0, 0);
        return (liqPx[m] == 0 ? px[m] : liqPx[m], uint64(block.timestamp));
    }
    function getPrice(uint32 m) external view returns (uint256, uint64) { return (px[m], uint64(block.timestamp)); }
}

abstract contract Base is Test {
    using stdStorage for StdStorage;
    Paper10kExchange ex; Paper10kX x; TestUSDC usdc; MockOracle orc;
    address owner = address(0xA11CE); address alice = address(0xA1); address bob = address(0xB0B); address keeper = address(0xCEE);
    uint32 constant BTC = 0;
    uint256 constant P0 = 100_000e18;
    uint64 constant DELAY = 2 days;

    function defParams() internal pure returns (Paper10kExchange.Params memory p) {
        p = Paper10kExchange.Params({maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 100,
            rateMultiplier: 1000, mintPerCollateral: 100, deadbandWad: 2e12, baseRateWad: 0, minMargin: 1e6, maxMarginPerPosition: 1_000e6});
    }
    uint16 internal bBps; uint128 internal bCap; // liquidation bounty settings used by defOps (0 by default = legacy numbers)
    function defOps() internal view returns (Paper10kExchange.Ops memory o) { o = Paper10kExchange.Ops({maxTotalDeposits: 1_000_000e6, maxPriceAge: 30, minHold: 3, bountyBps: bBps, bountyCap: bCap}); }

    function setUp() public virtual {
        vm.warp(1_000_000); vm.roll(100);
        usdc = new TestUSDC(); orc = new MockOracle(); orc.set(BTC, P0);
        x = new Paper10kX(owner, 1e30);
        ex = new Paper10kExchange(owner, IERC20(address(usdc)), 6, x, orc, DELAY, defParams(), defOps());
        vm.startPrank(owner);
        x.setMinter(address(ex), true);
        ex.setMarket(BTC, true, 10_000_000e6, 10_000_000e6);
        vm.warp(block.timestamp + DELAY); 
        ex.unpause();
        vm.stopPrank();
        _fund(alice, 10_000e6); _fund(bob, 10_000e6);
        usdc.faucet(); usdc.transfer(owner, 10_000e6);
        vm.startPrank(owner); usdc.approve(address(ex), type(uint256).max); ex.seedPool(10_000e6); vm.stopPrank();
        vm.warp(block.timestamp + 1); orc.set(BTC, P0);
    }
    function _fund(address u, uint256 amt) internal {
        vm.startPrank(u); usdc.faucet(); usdc.approve(address(ex), type(uint256).max); ex.deposit(amt); vm.stopPrank();
    }
    /// mark -> wait the 2-block persistence window -> liquidate (price must still be past bust at the end)
    function _liq(uint256 id, address who) internal {
        ex.markLiquidatable(id);
        vm.roll(block.number + 2); vm.warp(block.timestamp + 2);
        vm.prank(who); ex.liquidate(id);
    }
    function _markBlock(uint256 id) internal view returns (uint32 b) { (b,) = ex.marks(id); }
    /// via-IR note: cheatcode-adjacent `block.*` reads can be cached by the compiler inside one function; use real reads here
    function _adv(uint256 blocks, uint256 secs) internal { vm.roll(vm.getBlockNumber() + blocks); vm.warp(vm.getBlockTimestamp() + secs); }
    function _next() internal { vm.warp(block.timestamp + 5); vm.roll(block.number + 1); }
    /// owner withdrawals no longer exist: tests that need a small pool shrink it directly (cash stays >= liabilities)
    function _setPool(uint256 v) internal { stdstore.target(address(ex)).sig("pool()").checked_write(v); }
    function _solvent() internal view {
        assertGe(usdc.balanceOf(address(ex)), ex.totalFree() + ex.totalMargin() + ex.pool() + ex.insurance());
    }
}
