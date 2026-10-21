// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {ChainlinkPythOracle} from "../src/ChainlinkPythOracle.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPythFull {
    function getUpdateFee(bytes[] calldata) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata) external payable;
}

/// REAL signed Pyth update (no mocks) on a Base mainnet fork. Data: `tools/fetch-pyth-update.sh` (needs PYTH_API_KEY).
/// Run: tools/fetch-pyth-update.sh && forge test --match-contract ForkL2Live --fork-url https://mainnet.base.org -vv
contract ForkL2LiveTest is Test {
    address constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    address constant SEQ = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    address constant CL_BTC = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;
    bytes32 constant PY_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes[] upd; uint256 T; uint256 pub; uint256 rawPx;

    function setUp() public {
        if (block.chainid != 8453 || !vm.exists("./.pyth/update.hex")) return;
        upd.push(vm.parseBytes(vm.readFile("./.pyth/update.hex")));
        T = vm.parseUint(vm.readLine("./.pyth/meta.txt")); pub = vm.parseUint(vm.readLine("./.pyth/meta.txt")); rawPx = vm.parseUint(vm.readLine("./.pyth/meta.txt"));
    }

    function test_live_realSignedUpdate_feeGasAndTwoStepFill() public {
        if (upd.length == 0) { vm.skip(true); return; }
        vm.warp(T - 1); vm.roll(vm.getBlockNumber() + 1);
        // 1) fee + gas of a plain updatePriceFeeds (what keepers pay before mark/liquidate)
        uint256 fee = IPythFull(PYTH).getUpdateFee(upd);
        vm.deal(address(this), 1 ether);
        uint256 g = gasleft(); IPythFull(PYTH).updatePriceFeeds{value: fee}(upd); uint256 gUpd = g - gasleft();
        console.log("pyth fee wei", fee); console.log("updatePriceFeeds gas", gUpd); console.log("update bytes", upd[0].length);

        // 2) full immutable stack with the REAL oracle adapter
        TestUSDC usdc = new TestUSDC(); Paper10kX px = new Paper10kX(address(this), 1e30);
        ChainlinkPythOracle o = new ChainlinkPythOracle(address(this), PYTH, SEQ, 3600);
        o.configure(0, CL_BTC, 3900, PY_BTC, 120, 100, 50); o.finalizeBootstrap();
        Paper10kExchange.Params memory p = Paper10kExchange.Params({maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 1,
            rateMultiplier: 1000, mintPerCollateral: 100, deadbandWad: 2e13, baseRateWad: 0, minMargin: 1e4, maxMarginPerPosition: 1_000e6});
        Paper10kExchange.Ops memory op = Paper10kExchange.Ops({maxTotalDeposits: 1e15, maxPriceAge: 120, minHold: 3, bountyBps: 200, bountyCap: 10e6});
        Paper10kExchange ex = new Paper10kExchange(address(this), IERC20(address(usdc)), 6, px, IPriceOracle(address(o)), 5 minutes, p, op);
        px.setMinter(address(ex), true);
        ex.setMarket(0, true, 1e15, 1e15);
        usdc.mintTo(address(this), 2_000e6); usdc.approve(address(ex), type(uint256).max); ex.seedPool(1_000e6); ex.unpause(); ex.deposit(1_000e6);
        ex.finalize();

        uint256 rid = ex.requestOpen(0, true, 1e6, 10_000, type(uint128).max); // at T-1 => fill needs the first update >= T
        vm.warp(pub + 2); vm.roll(vm.getBlockNumber() + 1);
        g = gasleft(); ex.fill{value: fee}(rid, upd); uint256 gFill = g - gasleft();
        console.log("fill (parseUnique + Chainlink bound + open) gas", gFill);
        (,,,,,,, uint128 entry,,) = ex.positions(1);
        assertEq(entry, rawPx * 1e10, "entry = the signed Pyth price (expo -8)");
        // the same signed data cannot satisfy a later request (uniqueness)
        uint256 rid2 = ex.requestOpen(0, true, 1e6, 10_000, type(uint128).max);
        vm.expectRevert(); ex.fill{value: fee}(rid2, upd);
    }
    receive() external payable {}
}
