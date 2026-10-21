// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The owner-approved launch numbers (/workspace/p10k-backtest/final_params.json, mirrored in
///         script/final_params.example.json) produce the documented Rules/FAQ table: $20 seed, maxProfit 2x, 1% payout cap.
contract FinalParamsTest is Base {
    string j;
    function _j(string memory k) internal view returns (uint256) { return vm.parseJsonUint(j, k); }
    function setUp() public override {
        super.setUp();
        string memory path = "/workspace/p10k-backtest/final_params.json";
        j = vm.exists(path) ? vm.readFile(path) : vm.readFile("script/final_params.example.json");
        bool nested = vm.keyExistsJson(j, ".Params");
        string memory P = nested ? ".Params." : "."; string memory L = nested ? ".Limits." : "."; string memory S = nested ? ".Staking." : ".";
        Paper10kExchange.Params memory p = Paper10kExchange.Params({maxLeverage: uint16(_j(string.concat(P, "maxLeverage"))), maintBps: uint16(_j(string.concat(P, "maintBps"))),
            winFeeBps: uint16(_j(string.concat(P, "winFeeBps"))), insuranceBps: uint16(_j(string.concat(P, "insuranceBps"))), maxProfitMult: uint16(_j(string.concat(P, "maxProfitMult"))),
            rateMultiplier: uint32(_j(string.concat(P, "rateMultiplier"))), mintPerCollateral: uint32(_j(string.concat(P, "mintPerCollateral"))),
            deadbandWad: uint64(_j(string.concat(P, "deadbandWad"))), baseRateWad: uint64(_j(string.concat(P, "baseRateWad"))),
            minMargin: uint128(_j(string.concat(P, "minMargin"))), maxMarginPerPosition: uint128(_j(string.concat(P, "maxMarginPerPosition")))});
        ex = new Paper10kExchange(owner, IERC20(address(usdc)), 6, x, orc, DELAY, p, defOps());
        vm.startPrank(owner);
        ex.setLimits(Paper10kExchange.Limits({minNotional: 0, maxNotional: 0, maxWalletMargin: 0, maxLiabPoolBps: uint32(_j(string.concat(L, "maxLiabPoolBps"))),
            maxJumpBps: uint16(_j(string.concat(L, "maxJumpBps"))), jumpWindow: uint32(_j(string.concat(L, "jumpWindow"))), maxPayoutPoolBps: uint16(_j(string.concat(L, "maxPayoutPoolBps"))),
            walletMaxMult: uint16(_j(string.concat(L, "walletMaxMult"))), mintDecayPool: uint64(_j(string.concat(L, "mintDecayPool")))}));
        ex.setStaking(address(0x5747), uint16(_j(string.concat(S, "stakerLossBps"))), uint16(_j(string.concat(S, "stakerFeeBps"))), _j(string.concat(S, "stakerCap")));
        vm.stopPrank();
    }
    function test_params_match_owner_decision() public view {
        uint16 mult = ex.currentParams().maxProfitMult;
        assertEq(mult, 2, "maxProfit 2x");
        (,,,,,, uint16 payBps, uint16 wMult, uint64 decay) = ex.limits();
        assertEq(payBps, 100, "1% payout cap"); assertEq(wMult, 3); assertEq(decay, 1_000e6);
        assertEq(ex.stakerLossBps(), 500, "stakers get 5% of losses"); assertEq(ex.stakerFeeBps(), 5000, "and 50% of win fees");
    }
    function test_pool_size_table() public {
        uint256[6] memory pools = [uint256(20e6), 100e6, 1_000e6, 10_000e6, 200_000e6, 1_000_000e6];
        uint256[6] memory want = [uint256(0.10e6), 0.50e6, 5e6, 50e6, 1_000e6, 1_000e6]; // min($1000, 0.5% of pool+insurance)
        for (uint256 i; i < 6; i++) { _setPool(pools[i]); assertEq(ex.maxMarginNow(), want[i]); }
    }
    function test_mint_halving() public {
        uint256[6] memory pools = [uint256(20e6), 999e6, 1_000e6, 2_000e6, 4_000e6, 8_000e6];
        uint256[6] memory want = [uint256(100), 100, 50, 25, 12, 6];
        for (uint256 i; i < 6; i++) { _setPool(pools[i]); assertEq(ex.mintRateNow(100), want[i]); }
    }
    function test_seed_20_gives_10c_max_margin() public {
        uint256 s = vm.exists("/workspace/p10k-backtest/final_params.json") && vm.keyExistsJson(j, ".Seed.recommended_pool_seed_usd") ? _j(".Seed.recommended_pool_seed_usd") * 1e6 : 20e6;
        assertEq(s, 20e6); _setPool(s); assertEq(ex.maxMarginNow(), 0.10e6);
    }
}
