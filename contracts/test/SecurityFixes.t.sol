// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {ChainlinkPythOracle, IPythCore} from "../src/ChainlinkPythOracle.sol";

contract CLRevertingDecimals {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, 100_000e8, block.timestamp, block.timestamp, 1); }
    function decimals() external pure returns (uint8) { revert("boom"); }
}
contract PythOk {
    function getPriceUnsafe(bytes32) external view returns (IPythCore.Price memory p) { p = IPythCore.Price(100_000e8, 1e8, -8, block.timestamp); }
}

/// Regression tests for SECURITY_TOOLING.md findings SEC-1 and SEC-2
contract SecurityFixesTest is Base {
    /// SEC-1: LP-utilisation cap must not count capital that is already owed to queued winners
    function test_sec1_utilisationCapExcludesQueuedDebt() public {
        // alice wins far more than pool + insurance can pay -> profit is queued
        vm.prank(alice); uint256 id = ex.open(BTC, true, 1_000e6, 10_000, type(uint256).max);
        _next(); orc.set(BTC, P0 * 105 / 100);
        vm.prank(alice); ex.close(id);
        assertGt(ex.queuedTotal(), 0); assertEq(ex.pool() + ex.insurance(), 0);
        // someone funds insurance, but less than what is owed
        usdc.mintTo(address(this), 50_000e6); usdc.approve(address(ex), type(uint256).max); ex.fundInsurance(50_000e6);
        assertLt(ex.pool() + ex.insurance(), ex.queuedTotal());
        // enable a 100% utilisation cap (liability <= free house capital)
        vm.prank(owner); ex.setLimits(Paper10kExchange.Limits(0, 0, 0, 10_000, 0, 0, 0, 0, 0)); _adv(1, DELAY);
        orc.set(BTC, P0 * 105 / 100);
        // liability 10e6 * 100 = 1_000e6 << 50_000e6 cash, but ALL of that cash is owed => must revert
        vm.prank(bob); vm.expectRevert(Paper10kExchange.Cap.selector); ex.open(BTC, true, 10e6, 10, type(uint256).max);
        // once the queue is paid and fresh capital arrives, opening works again
        usdc.mintTo(address(this), 100_000e6); ex.seedPool(100_000e6); ex.processQueue(10);
        assertEq(ex.queuedTotal(), 0);
        vm.prank(bob); ex.open(BTC, true, 10e6, 10, type(uint256).max);
        _solvent();
    }

    /// SEC-2: a Chainlink feed whose decimals() reverts must make the adapter fail CLOSED (0,0), not revert
    function test_sec2_chainlinkDecimalsRevertFailsClosed() public {
        ChainlinkPythOracle o = new ChainlinkPythOracle(owner, address(new PythOk()), address(0), 0);
        address cl = address(new CLRevertingDecimals());
        vm.prank(owner); o.configure(0, cl, 1 hours, bytes32(uint256(1)), 60, 100, 100);
        (uint256 p, uint64 t) = o.getPrice(0); assertEq(p, 0); assertEq(t, 0);
        (p, t) = o.getLiquidationPrice(0, true); assertEq(p, 0); assertEq(t, 0);
    }
}
