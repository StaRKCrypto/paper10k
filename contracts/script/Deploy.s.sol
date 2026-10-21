// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {Paper10kX} from "../src/Paper10kX.sol";
import {Paper10kStaking} from "../src/Paper10kStaking.sol";
import {ChainlinkPythOracle} from "../src/ChainlinkPythOracle.sol";
import {TriggerOrders, IP10KExchange} from "../src/periphery/TriggerOrders.sol";
import {RektBadges, IRektSource} from "../src/periphery/RektBadges.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {SignedPriceOracle} from "../src/testnet/SignedPriceOracle.sol";
import {IPriceOracle} from "../src/IPriceOracle.sol";

/// @notice ONE-SHOT immutable launch. Key only on the command line (--account / --ledger); never in files.
///  Economic params: env `P10K_<key>` > JSON file (`PARAMS_JSON`, default /workspace/p10k-backtest/final_params.json, flat
///  object of the keys below) > testnet placeholder. On MAINNET (8453) every key must come from env or the JSON, else it reverts
///  "missing param: <key>" — there are no silent defaults for real money.
///  Flow (single broadcast, nothing can be skipped): oracle (configured, bootstrapped, renounced) -> PAPER10KX -> exchange (paused)
///  -> staking, TriggerOrders, RektBadges -> markets, limits, staking shares, guardian -> lock minter -> seed pool/insurance
///  -> unpause + finalize() in consecutive calls -> renounce exchange + PAPER10KX ownership. Asserts the end state.
contract Deploy is Script {
    address constant BASE_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    address constant BASE_SEQ = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    address constant CL_BTC = 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F;
    address constant CL_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address constant CL_SOL = 0x975043adBb80fc32276CbF9Bbcfd4A601a12462D;
    bytes32 constant PY_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PY_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant PY_SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;

    bool mainnet; string json; bool hasJson;

    /// env > json > placeholder (testnet only)
    function _u(string memory k, uint256 placeholder) internal view returns (uint256) {
        string memory ek = string.concat("P10K_", k);
        if (vm.envExists(ek)) return vm.envUint(ek);
        if (hasJson) {
            // flat keys (example file) or the backtest's nested sections (Params / Ops / Limits / Staking)
            string[5] memory pre = ["", ".Params", ".Ops", ".Limits", ".Staking"];
            for (uint256 i; i < 5; i++) {
                string memory jk = string.concat(pre[i], ".", k);
                if (vm.keyExistsJson(json, jk)) return vm.parseJsonUint(json, jk);
            }
            if (keccak256(bytes(k)) == keccak256("seedPool") && vm.keyExistsJson(json, ".Seed.recommended_pool_seed_usd"))
                return vm.parseJsonUint(json, ".Seed.recommended_pool_seed_usd") * 1e6;
        }
        require(!mainnet, string.concat("missing param: ", k));
        return placeholder;
    }

    function _params() internal view returns (Paper10kExchange.Params memory p, Paper10kExchange.Ops memory o, Paper10kExchange.Limits memory l) {
        // defaults = the owner-approved final_params.json (backtest): maxProfit 2x, 1% payout cap => maxMargin = 0.5% of pool+insurance
        p = Paper10kExchange.Params({
            maxLeverage: uint16(_u("maxLeverage", 10_000)), maintBps: uint16(_u("maintBps", 1000)), winFeeBps: uint16(_u("winFeeBps", 200)),
            insuranceBps: uint16(_u("insuranceBps", 1000)), maxProfitMult: uint16(_u("maxProfitMult", 2)),
            rateMultiplier: uint32(_u("rateMultiplier", 1000)), mintPerCollateral: uint32(_u("mintPerCollateral", 100)),
            deadbandWad: uint64(_u("deadbandWad", 1e14)), baseRateWad: uint64(_u("baseRateWad", 2e17)),
            minMargin: uint128(_u("minMargin", 0.001e6)), maxMarginPerPosition: uint128(_u("maxMarginPerPosition", 1_000e6))
        });
        o = Paper10kExchange.Ops({
            maxTotalDeposits: uint128(_u("maxTotalDeposits", 1_000_000_000e6)), maxPriceAge: uint64(_u("maxPriceAge", 30)),
            minHold: uint64(_u("minHold", 30)), bountyBps: uint16(_u("bountyBps", 200)), bountyCap: uint128(_u("bountyCap", 10e6))
        });
        l = Paper10kExchange.Limits({
            minNotional: uint128(_u("minNotional", 0)), maxNotional: uint128(_u("maxNotional", 0)), maxWalletMargin: uint128(_u("maxWalletMargin", 0)),
            maxLiabPoolBps: uint32(_u("maxLiabPoolBps", 5000)), maxJumpBps: uint16(_u("maxJumpBps", 50)), jumpWindow: uint32(_u("jumpWindow", 60)),
            maxPayoutPoolBps: uint16(_u("maxPayoutPoolBps", 100)), walletMaxMult: uint16(_u("walletMaxMult", 3)), mintDecayPool: uint64(_u("mintDecayPool", 1_000e6))
        });
    }

    function run() external {
        uint256 id = block.chainid;
        bool testnet = id == 84532 || id == 31337;
        require(testnet || id == 8453, "unsupported chain (Base 8453, Base Sepolia 84532, local 31337)");
        mainnet = !testnet;
        string memory path = vm.envOr("PARAMS_JSON", string("/workspace/p10k-backtest/final_params.json"));
        if (vm.exists(path)) { json = vm.readFile(path); hasJson = true; }
        if (mainnet) {
            require(keccak256(bytes(vm.envString("MAINNET_ENABLE"))) == keccak256("I_ACCEPT_REAL_FUNDS_RISK"), "mainnet flag off");
            require(hasJson || vm.envExists("P10K_maxLeverage"), string.concat("final params missing: ", path));
        }
        (Paper10kExchange.Params memory p, Paper10kExchange.Ops memory o, Paper10kExchange.Limits memory l) = _params();
        uint256 oiCap = _u("oiCap", 10_000_000e6);
        uint256 seed = _u("seedPool", 20e6); uint256 seedIns = _u("seedInsurance", 0);
        uint16 sLoss = uint16(_u("stakerLossBps", 500)); uint16 sFee = uint16(_u("stakerFeeBps", 5000));
        uint256 sCap = _u("stakerCap", 0); uint64 cooldown = uint64(_u("stakeCooldown", 0));
        uint256 pxMax = _u("pxMaxSupply", 1e30);
        address guardian = vm.envOr("GUARDIAN", address(0));
        require(seed > 0, "seedPool must be > 0 (trades cannot open on an empty pool)");

        vm.startBroadcast();
        address me = msg.sender;
        address collateral = testnet ? address(new TestUSDC()) : vm.envAddress("COLLATERAL"); // Base native USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
        address oracle = _oracle(testnet, me);
        Paper10kX px = new Paper10kX(me, pxMax);
        Paper10kExchange ex = new Paper10kExchange(me, IERC20(collateral), 6, px, IPriceOracle(oracle), 5 minutes, p, o);
        Paper10kStaking st = new Paper10kStaking(IERC20(address(px)), IERC20(collateral), address(ex), cooldown);
        TriggerOrders trig = new TriggerOrders(IP10KExchange(address(ex)));
        RektBadges badges = new RektBadges(IRektSource(address(ex)));

        ex.setMarket(0, true, oiCap, oiCap); ex.setMarket(1, true, oiCap, oiCap); ex.setMarket(2, true, oiCap, oiCap);
        ex.setLimits(l);
        ex.setStaking(address(st), sLoss, sFee, sCap);
        if (guardian != address(0)) ex.setGuardian(guardian);
        px.setMinter(address(ex), true); // locked forever

        if (testnet) TestUSDC(collateral).mintTo(me, seed + seedIns);
        IERC20(collateral).approve(address(ex), seed + seedIns);
        ex.seedPool(seed); if (seedIns > 0) ex.fundInsurance(seedIns);

        // the ONLY place unpause is called: immediately followed by finalize() in the same broadcast
        ex.unpause();
        ex.finalize();
        ex.renounceOwnership();
        px.renounceOwnership();
        vm.stopBroadcast();

        require(ex.finalized() && !ex.paused() && ex.owner() == address(0) && px.owner() == address(0) && px.minterLocked() && px.minter() == address(ex), "end state");
        console.log("chainId", id);
        console.log("Collateral", collateral); console.log("Oracle", oracle); console.log("PAPER10KX", address(px));
        console.log("Exchange", address(ex)); console.log("Staking", address(st)); console.log("TriggerOrders", address(trig)); console.log("RektBadges", address(badges));
        console.log("finalizedBlock", ex.finalizedBlock());
    }

    function _oracle(bool testnet, address me) internal returns (address) {
        if (testnet && block.chainid != 8453 && vm.envOr("USE_SIGNED_ORACLE", false)) return address(new SignedPriceOracle(me, vm.envAddress("ORACLE_SIGNER")));
        // Base mainnet sources (verified live 2026-10-21). On a local chain these addresses are only valid on a Base fork.
        ChainlinkPythOracle o = new ChainlinkPythOracle(me, vm.envOr("PYTH", BASE_PYTH), vm.envOr("SEQ_FEED", BASE_SEQ), 3600);
        uint16 dev = uint16(_u("oracleMaxDevBps", 100)); uint16 conf = uint16(_u("oracleMaxConfBps", 50)); uint32 age = uint32(_u("pythMaxAge", 30));
        o.configure(0, vm.envOr("CL_BTC", CL_BTC), 3900, PY_BTC, age, dev, conf);
        o.configure(1, vm.envOr("CL_ETH", CL_ETH), 3900, PY_ETH, age, dev, conf);
        o.configure(2, vm.envOr("CL_SOL", CL_SOL), 86_700, PY_SOL, age, dev, conf);
        string[3] memory syms = ["BTC", "ETH", "SOL"];
        for (uint32 i; i < 3; i++) {
            address t = vm.envOr(string.concat("THIRD_", syms[i]), address(0));
            if (t != address(0)) o.setThird(i, t, uint32(vm.envOr(string.concat("THIRD_MAX_AGE_", syms[i]), uint256(86_400))));
        }
        o.finalizeBootstrap();
        o.renounceOwnership();
        return address(o);
    }
}
