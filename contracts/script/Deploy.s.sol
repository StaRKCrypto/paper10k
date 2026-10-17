// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {HyperCoreOracle} from "../src/HyperCoreOracle.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {SignedPriceOracle} from "../src/testnet/SignedPriceOracle.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";

/// @notice Deploy script. A key is supplied ONLY on the command line (--private-key / --account / --ledger); never in files.
///  Testnets (998 HyperEVM testnet, 84532 Base Sepolia, 31337 local): TestUSDC + (HyperCoreOracle on 998 if USE_HYPERCORE_ORACLE=1, else SignedPriceOracle).
///  Mainnet (999 HyperEVM): REFUSES unless MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK, OWNER is a contract (multisig) and COLLATERAL is set.
///  Mainnet ALWAYS uses HyperCoreOracle (the signed-price oracle lives in src/testnet and is refused here).
///  Always deploys PAUSED. The owner (multisig) then runs the steps in MAINNET_LAUNCH.md.
contract Deploy is Script {
    address constant HL_BBO = 0x000000000000000000000000000000000000080e;
    address constant HL_ORACLE_PX = 0x0000000000000000000000000000000000000807;

    struct Cfg { address owner; address signer; uint64 delay; bool testnet; bool useHL; address collateral; Paper10kExchange.Params p; Paper10kExchange.Ops o; }

    function _cfg() internal view returns (Cfg memory c) {
        uint256 id = block.chainid;
        c.testnet = id == 998 || id == 84532 || id == 31337;
        require(c.testnet || id == 999, "unsupported chain");
        c.owner = vm.envAddress("OWNER");
        c.signer = vm.envOr("ORACLE_SIGNER", address(0));
        c.delay = uint64(vm.envOr("CONFIG_DELAY", uint256(c.testnet ? 5 minutes : 2 days)));
        c.p = Paper10kExchange.Params({
            maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 100,
            rateMultiplier: uint32(vm.envOr("RATE_MULTIPLIER", uint256(1000))), mintPerCollateral: 100,
            deadbandWad: uint64(vm.envOr("DEADBAND_WAD", uint256(2e12))), baseRateWad: 0,
            minMargin: uint128(vm.envOr("MIN_MARGIN", uint256(1e6))),
            maxMarginPerPosition: uint128(vm.envOr("MAX_MARGIN", c.testnet ? uint256(1_000e6) : uint256(50e6)))
        });
        c.o = Paper10kExchange.Ops({
            maxTotalDeposits: uint128(vm.envOr("TVL_CAP", c.testnet ? uint256(1_000_000e6) : uint256(5_000e6))),
            maxPriceAge: 30, minHold: uint64(vm.envOr("MIN_HOLD", uint256(3)))
        });
        if (c.testnet) {
            c.useHL = id == 998 && vm.envOr("USE_HYPERCORE_ORACLE", false);
        } else {
            require(keccak256(bytes(vm.envString("MAINNET_ENABLE"))) == keccak256("I_ACCEPT_REAL_FUNDS_RISK"), "mainnet flag off");
            require(c.owner.code.length > 0, "mainnet owner must be a contract (multisig)");
            require(c.delay >= 1 days, "mainnet config delay >= 1 day");
            require(c.p.deadbandWad >= 2e13, "mainnet deadband >= 0.2 bps (HL BBO half-spread jitter)"); // v3
            c.collateral = vm.envAddress("COLLATERAL"); // verify the USDC address yourself
            c.useHL = true;
        }
    }

    function run() external {
        Cfg memory c = _cfg();
        vm.startBroadcast();
        if (c.testnet) { c.collateral = address(new TestUSDC()); console.log("TestUSDC", c.collateral); }
        address oracle;
        if (c.useHL) {
            oracle = address(new HyperCoreOracle(c.owner, HL_BBO, HL_ORACLE_PX, c.delay));
        } else {
            require(c.signer != address(0), "ORACLE_SIGNER required");
            oracle = address(new SignedPriceOracle(c.owner, c.signer));
        }
        Paper10kX px = new Paper10kX(msg.sender, 1e30);
        Paper10kExchange ex = new Paper10kExchange(c.owner, IERC20(c.collateral), 6, px, IPriceOracle(oracle), c.delay, c.p, c.o);
        px.setMinter(address(ex), true);       // lock minter forever
        px.transferOwnership(c.owner);         // owner must acceptOwnership()
        vm.stopBroadcast();

        console.log("chainId", block.chainid);
        console.log("Oracle", oracle);
        console.log("PAPER10KX", address(px));
        console.log("Exchange", address(ex));
        console.log("NEXT (owner): oracle.configure (bootstrap), oracle.finalizeBootstrap() BEFORE unpause, exchange.proposeMarket -> wait delay -> applyMarket, seedPool, fundInsurance, px.acceptOwnership(), unpause()");
    }
}
