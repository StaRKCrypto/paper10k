// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {ChainlinkPythOracle, IPythCore, IAggV3} from "../src/ChainlinkPythOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Run: forge test --match-contract ForkL2 --fork-url <base|robinhood rpc> -vv
/// Real: Chainlink feeds, sequencer feed (Base), Pyth contract code, collateral token (USDC on Base, USDG on RH).
/// Mocked: Pyth getPriceUnsafe (Hermes needs an API key since 2026-08-26, so no signed update could be posted) => set to Chainlink answer.
contract ForkL2 is Test {
    address constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a; // same address on Base + RH (code verified on both)
    bytes32 constant BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    address owner = address(0xA11CE); address alice = address(0xA1); address keeper = address(0xCEE);
    Paper10kExchange ex; Paper10kX x; ChainlinkPythOracle orc; IERC20 col; address clBtc; address seq;

    function _pyth(uint256 px8) internal {
        vm.mockCall(PYTH, abi.encodeWithSelector(IPythCore.getPriceUnsafe.selector, BTC_ID),
            abi.encode(IPythCore.Price(int64(uint64(px8)), uint64(px8 / 10_000), -8, vm.getBlockTimestamp())));
    }
    uint256 realA8; uint256 realUpd;
    function _clPx() internal view returns (uint256 a8, uint256 upd) { (, int256 a,, uint256 u,) = IAggV3(clBtc).latestRoundData(); return (uint256(a), u); }
    /// after the 2-day timelock warp the real feed is "old"; re-post the REAL fork answer as fresh (same value)
    function _clFresh(uint256 a8) internal {
        vm.mockCall(clBtc, abi.encodeWithSelector(IAggV3.latestRoundData.selector), abi.encode(uint80(1), int256(a8), vm.getBlockTimestamp(), vm.getBlockTimestamp(), uint80(1)));
    }

    function setUp() public {
        if (block.chainid == 8453) {
            col = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913); clBtc = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;
            seq = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
        } else if (block.chainid == 4663) {
            col = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168); clBtc = 0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251; seq = address(0);
        } else revert("chain");
        (realA8, realUpd) = _clPx();
        console2.log("chainlink BTC age s", vm.getBlockTimestamp() - realUpd);
        console2.log("chainlink BTC answer 8dp", realA8);
        uint256 g = gasleft();
        orc = new ChainlinkPythOracle(owner, PYTH, seq, 3600);
        console2.log("gas deploy oracle", g - gasleft());
        g = gasleft(); x = new Paper10kX(owner, 1e30); console2.log("gas deploy PAPER10KX", g - gasleft());
        Paper10kExchange.Params memory p = Paper10kExchange.Params({maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000,
            maxProfitMult: 100, rateMultiplier: 1000, mintPerCollateral: 100, deadbandWad: 2e13, baseRateWad: 0, minMargin: 1e6, maxMarginPerPosition: 1_000e6});
        Paper10kExchange.Ops memory o = Paper10kExchange.Ops({maxTotalDeposits: 1_000_000e6, maxPriceAge: 60, minHold: 3, bountyBps: 200, bountyCap: 10e6});
        g = gasleft(); ex = new Paper10kExchange(owner, col, 6, x, orc, 2 days, p, o); console2.log("gas deploy Exchange", g - gasleft());
        console2.log("Exchange runtime bytes", address(ex).code.length);
        vm.startPrank(owner);
        orc.configure(0, clBtc, 2 days, BTC_ID, 60, 100, 50); orc.finalizeBootstrap();
        x.setMinter(address(ex), true);
        ex.proposeMarket(0, true, 10_000_000e6, 10_000_000e6); vm.warp(vm.getBlockTimestamp() + 2 days); ex.applyMarket(0); ex.unpause();
        vm.stopPrank();
        deal(address(col), owner, 10_000e6); deal(address(col), alice, 1_000e6);
        vm.prank(owner); col.approve(address(ex), type(uint256).max); vm.prank(owner); ex.seedPool(10_000e6);
        vm.prank(alice); col.approve(address(ex), type(uint256).max); vm.prank(alice); ex.deposit(1_000e6);
    }

    function test_fork_tradeAndLiquidate() public {
        uint256 a8 = realA8; _clFresh(a8); _pyth(a8);
        (uint256 pr,) = orc.getPrice(0); assertEq(pr, a8 * 1e10);
        uint256 g = gasleft(); orc.getLiquidationPrice(0, true); console2.log("gas oracle.getLiquidationPrice (view)", g - gasleft());
        vm.prank(alice); g = gasleft(); uint256 id = ex.open(0, true, 20e6, 10_000, type(uint256).max); console2.log("gas open", g - gasleft());
        vm.roll(vm.getBlockNumber() + 1); vm.warp(vm.getBlockTimestamp() + 5); _pyth(a8);
        _clFresh(a8);
        vm.prank(alice); g = gasleft(); uint256 id2 = ex.open(0, true, 20e6, 10_000, type(uint256).max); console2.log("gas open #2", g - gasleft());
        vm.roll(vm.getBlockNumber() + 1); vm.warp(vm.getBlockTimestamp() + 5); _pyth(a8);
        _clFresh(a8);
        vm.prank(alice); g = gasleft(); ex.close(id2); console2.log("gas close", g - gasleft());
        // Pyth says -2% but Chainlink (unchanged) disagrees by > maxDev => no liq price (fail closed)
        _pyth(a8 * 98 / 100);
        (uint256 lp,) = orc.getLiquidationPrice(0, true); assertEq(lp, 0);
        // both sources move: Chainlink mocked to -0.05% (both agree bust at 10000x, 0.01% move)
        uint256 dn = a8 * 9995 / 10000;
        vm.mockCall(clBtc, abi.encodeWithSelector(IAggV3.latestRoundData.selector), abi.encode(uint80(1), int256(dn), vm.getBlockTimestamp(), vm.getBlockTimestamp(), uint80(1)));
        _pyth(dn);
        vm.prank(keeper); g = gasleft(); ex.markLiquidatable(id); console2.log("gas markLiquidatable", g - gasleft());
        vm.roll(vm.getBlockNumber() + 1); vm.warp(vm.getBlockTimestamp() + 1); _pyth(dn);
        vm.prank(keeper); vm.expectRevert(); ex.liquidate(id); // 1 block: too soon (two-block rule)
        vm.roll(vm.getBlockNumber() + 1); vm.warp(vm.getBlockTimestamp() + 1); _pyth(dn);
        uint256 kb = col.balanceOf(keeper);
        vm.prank(keeper); g = gasleft(); ex.liquidate(id); console2.log("gas liquidate", g - gasleft());
        console2.log("keeper bounty (6dp)", col.balanceOf(keeper) + ex.free(keeper) - kb);
        console2.log("PAPER10KX minted to alice", x.balanceOf(alice));
    }

    function test_fork_sequencerGateAndStale() public {
        uint256 a8 = realA8; _pyth(a8); // real feed, after the 2-day warp => stale
        (uint256 p0,) = orc.getPrice(0); assertEq(p0, 0);
        _clFresh(a8); (uint256 p1,) = orc.getPrice(0); assertGt(p1, 0);
        vm.warp(vm.getBlockTimestamp() + 2 days + 1); _pyth(a8);
        (uint256 pr,) = orc.getPrice(0); assertEq(pr, 0, "stale chainlink must fail closed");
    }
}
