// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {SignedPriceOracle} from "../src/SignedPriceOracle.sol";
import {HyperCoreBboOracle} from "../src/HyperCoreBboOracle.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";

/// @notice Deploy script. Key is supplied ONLY on the command line (--private-key / --account / --ledger); never in files.
///  Testnets (998 HyperEVM testnet, 84532 Base Sepolia, 31337 local): deploys TestUSDC + SignedPriceOracle.
///  Mainnet (999 HyperEVM): REFUSES unless MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK and all mainnet envs are set.
///  Always deploys PAUSED. Owner must configure caps/markets then call unpause().
contract Deploy is Script {
    struct Cfg {
        address owner; address signer; uint64 delay; uint256 minMargin; uint256 maxMargin; uint256 tvlCap;
        bool testnet; bool useHL; address collateral;
    }

    function _cfg() internal view returns (Cfg memory c) {
        uint256 id = block.chainid;
        c.testnet = id == 998 || id == 84532 || id == 31337;
        require(c.testnet || id == 999, "unsupported chain");
        c.owner = vm.envAddress("OWNER");           // testnet: any; mainnet: a multisig
        c.signer = vm.envOr("ORACLE_SIGNER", address(0));
        c.delay = uint64(vm.envOr("ORACLE_DELAY", uint256(c.testnet ? 5 minutes : 2 days)));
        c.minMargin = vm.envOr("MIN_MARGIN", uint256(1e6));
        c.maxMargin = vm.envOr("MAX_MARGIN", c.testnet ? uint256(1_000e6) : uint256(50e6));
        c.tvlCap = vm.envOr("TVL_CAP", c.testnet ? uint256(1_000_000e6) : uint256(5_000e6));
        if (!c.testnet) {
            require(keccak256(bytes(vm.envString("MAINNET_ENABLE"))) == keccak256("I_ACCEPT_REAL_FUNDS_RISK"), "mainnet flag off");
            require(c.owner.code.length > 0, "mainnet owner must be a contract (multisig)");
            c.collateral = vm.envAddress("COLLATERAL"); // verify the USDC address yourself
            c.useHL = vm.envOr("USE_HYPERCORE_ORACLE", false);
        }
    }

    function run() external {
        Cfg memory c = _cfg();
        vm.startBroadcast();
        if (c.testnet) { c.collateral = address(new TestUSDC()); console.log("TestUSDC", c.collateral); }
        address oracle;
        if (c.useHL) {
            // HyperCore BBO precompile 0x...080e (VERIFY on a live RPC before use)
            oracle = address(new HyperCoreBboOracle(c.owner, address(0x000000000000000000000000000000000000080e)));
        } else {
            require(c.signer != address(0), "ORACLE_SIGNER required");
            oracle = address(new SignedPriceOracle(c.owner, c.signer));
        }
        Paper10kX px = new Paper10kX(msg.sender, 1e30);
        Paper10kExchange ex = new Paper10kExchange(c.owner, IERC20(c.collateral), 6, px, IPriceOracle(oracle), c.delay, c.minMargin, c.maxMargin, c.tvlCap);
        px.setMinter(address(ex), true);       // lock minter forever
        px.transferOwnership(c.owner);         // owner must acceptOwnership()
        vm.stopBroadcast();

        console.log("chainId", block.chainid);
        console.log("Oracle", oracle);
        console.log("PAPER10KX", address(px));
        console.log("Exchange", address(ex));
        console.log("NEXT: owner calls setMarket(...), setRisk/setPricing, seedPool, px.acceptOwnership(), unpause()");
    }
}
