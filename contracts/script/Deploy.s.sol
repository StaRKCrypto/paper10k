// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {HyperCoreOracle} from "../src/HyperCoreOracle.sol";
import {ChainlinkPythOracle} from "../src/ChainlinkPythOracle.sol";
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
    // Base mainnet (8453) price sources, verified live over RPC on 2026-10-21 (description() + latestRoundData / getPriceUnsafe)
    address constant BASE_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;      // Pyth Core proxy (parsePriceFeedUpdatesUnique)
    address constant BASE_SEQ = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;       // Chainlink L2 sequencer uptime feed
    address constant CL_BTC = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;         // Chainlink "BTC / USD"
    address constant CL_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;         // Chainlink "ETH / USD"
    address constant CL_SOL = 0x975043adBb80fc32276CbF9Bbcfd4A601a12462D;         // Chainlink "SOL / USD"
    bytes32 constant PY_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PY_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant PY_SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;

    struct Cfg { address owner; address signer; uint64 delay; bool testnet; bool useHL; address collateral; Paper10kExchange.Params p; Paper10kExchange.Ops o; }

    function _cfg() internal view returns (Cfg memory c) {
        uint256 id = block.chainid;
        c.testnet = id == 998 || id == 84532 || id == 31337;
        require(c.testnet || id == 999 || id == 8453, "unsupported chain");
        c.owner = vm.envAddress("OWNER");
        c.signer = vm.envOr("ORACLE_SIGNER", address(0));
        c.delay = uint64(vm.envOr("CONFIG_DELAY", uint256(c.testnet ? 5 minutes : 2 days)));
        c.p = Paper10kExchange.Params({
            maxLeverage: 10_000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 100,
            rateMultiplier: uint32(vm.envOr("RATE_MULTIPLIER", uint256(1000))), mintPerCollateral: 100,
            deadbandWad: uint64(vm.envOr("DEADBAND_WAD", uint256(2e12))), baseRateWad: 0,
            minMargin: uint128(vm.envOr("MIN_MARGIN", uint256(1e6))),
            maxMarginPerPosition: uint128(vm.envOr("MAX_MARGIN", uint256(1e6)) /* launch rule: exactly 1 USDC per position */)
        });
        c.o = Paper10kExchange.Ops({
            maxTotalDeposits: uint128(vm.envOr("TVL_CAP", c.testnet ? uint256(1_000_000e6) : uint256(5_000e6))),
            maxPriceAge: 30, minHold: uint64(vm.envOr("MIN_HOLD", uint256(3))),
            bountyBps: uint16(vm.envOr("BOUNTY_BPS", uint256(200))), bountyCap: uint128(vm.envOr("BOUNTY_CAP", uint256(10e6)))
        });
        if (c.testnet) {
            c.useHL = id == 998 && vm.envOr("USE_HYPERCORE_ORACLE", false);
        } else {
            require(keccak256(bytes(vm.envString("MAINNET_ENABLE"))) == keccak256("I_ACCEPT_REAL_FUNDS_RISK"), "mainnet flag off");
            require(c.owner.code.length > 0, "mainnet owner must be a contract (multisig)");
            require(c.delay >= 1 days, "mainnet config delay >= 1 day");
            require(c.p.deadbandWad >= 2e13, "mainnet deadband >= 0.2 bps (HL BBO half-spread jitter)"); // v3
            c.collateral = vm.envAddress("COLLATERAL"); // verify the USDC address yourself (Base native USDC 0x8335...2913)
            c.useHL = id == 999;
        }
    }

    function run() external {
        Cfg memory c = _cfg();
        vm.startBroadcast();
        if (c.testnet) { c.collateral = address(new TestUSDC()); console.log("TestUSDC", c.collateral); }
        address oracle;
        if (block.chainid == 8453) {
            // Pyth = fill price (unique first update after each request) ; Chainlink = sanity bound + 2nd liquidation source ;
            // optional THIRD_<SYM> AggregatorV3-compatible push feed (RedStone Push / API3 / Chronicle if whitelisted) = 3rd vote.
            // Deployer configures + finalizes the oracle in the same broadcast, then hands ownership to OWNER (nothing left to change).
            ChainlinkPythOracle o = new ChainlinkPythOracle(msg.sender, BASE_PYTH, BASE_SEQ, 3600);
            uint16 dev = uint16(vm.envOr("ORACLE_MAX_DEV_BPS", uint256(100))); uint16 conf = uint16(vm.envOr("ORACLE_MAX_CONF_BPS", uint256(50)));
            uint32 pyAge = uint32(vm.envOr("PYTH_MAX_AGE", uint256(30)));
            o.configure(0, CL_BTC, 3900, PY_BTC, pyAge, dev, conf); // CL heartbeats: re-check on data.chain.link before launch
            o.configure(1, CL_ETH, 3900, PY_ETH, pyAge, dev, conf);
            o.configure(2, CL_SOL, 86_700, PY_SOL, pyAge, dev, conf);
            string[3] memory syms = ["BTC", "ETH", "SOL"];
            for (uint32 i; i < 3; i++) {
                address t = vm.envOr(string.concat("THIRD_", syms[i]), address(0));
                if (t != address(0)) o.setThird(i, t, uint32(vm.envOr(string.concat("THIRD_MAX_AGE_", syms[i]), uint256(86_400))));
            }
            o.finalizeBootstrap();
            o.renounceOwnership();
            oracle = address(o);
        } else if (c.useHL) {
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
        console.log("NEXT (owner): oracle.configure (bootstrap), oracle.finalizeBootstrap() BEFORE unpause, exchange.setMarket, setLimits, setStaking, seedPool, fundInsurance, unpause() + finalize() + renounceOwnership() (see MAINNET_LAUNCH.md)");
    }
}
