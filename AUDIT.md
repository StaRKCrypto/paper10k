# AUDIT.md — AI self-audit of the PAPER10K contracts

> **This is an AI-generated self-audit by the same agent that wrote the code. It is NOT an independent audit, carries no assurance, and is NOT a
> substitute for a professional audit (and legal review) before any mainnet use.** Several issues below are *design-level risks that cannot be fixed in code*.

Scope: `contracts/src/*.sol` @ this commit (Solidity 0.8.26, OpenZeppelin 5.1.0 vendored). Method: manual review against the checklist below, Slither 0.11.6
(`slither . --filter-paths "lib|test" --exclude-dependencies`), Foundry unit + fuzz + stateful invariant tests, one mutation check (injecting a +1 wei pool
inflation in `_liquidate` is caught by `invariant_solvent`). **Not done:** formal verification, differential fuzzing vs. the JS engine, fork tests against the real
HyperCore precompile, gas-griefing analysis under real chain conditions, review of the frontend for XSS beyond escaping.

Test status: `forge test` → 21 tests (13 unit, 3 oracle, 2 token, 2 fuzz at 512 runs, 4 invariants × 64 runs × depth 64), all passing. Line coverage 91%, branch 70%.

## Findings

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| 1 | **High (design)** | Oracle latency arbitrage / front-running | With any push oracle, a trader who sees (off-chain or in mempool) a price move before it is posted can open at the stale price and close after the update; at 10000x a 0.1–0.2% move is a 10–20x return, haircut-reduced but still large. `worstPrice` (slippage bound) does not help against *stale* prices. | **Mitigated, not solved:** 30 s max age, 3 s `minHold`, steep haircut for small moves, 100x profit cap, OI caps, per-position margin cap. Real fix = per-block oracle read (HyperCore precompile) + keeper-priced two-step orders or dynamic spread. **Do not launch with the signed oracle on mainnet.** |
| 2 | **High (design)** | Pool insolvency | Pool is counterparty to all trades; correlated wins (all longs +x%) can exceed pool. Winners become *unsecured queued debt*. | **Accepted/mitigated:** FIFO queue (cannot over-pay), profit cap `maxProfitMult` (100x), OI caps per side, TVL cap, owner can only withdraw pool surplus above `queuedTotal`. Sizing formula in MAINNET_LAUNCH.md. Invariant-tested: cash ≥ free + margin + pool. |
| 3 | High (trust) | Owner power over open positions | `setPricing` / `setRisk` (haircut steepness, fee, deadband, profit cap) take effect **retroactively** on open positions; owner could set parameters (within hard bounds) that zero out wins. | **Open — trust assumption.** Bounds limit the damage (fee ≤10%, mult ≤1e6, cap ≤10000x) but don't remove it. Mitigation: owner = multisig behind a ≥48 h timelock; consider snapshotting params per position (costs gas/storage). |
| 4 | High (trust) | Signed oracle | `signer` key controls prices; `forcePrice` (owner) bypasses jump guard. Key compromise = pool drained to queue. | **Open for mainnet.** Testnet only. Oracle swap on the exchange is timelocked (`oracleDelay`), signer swap on the oracle is not (use a timelock as oracle owner). |
| 5 | Medium | Maintenance changed under open positions | `maintBps` was read live, letting owner move liquidation of open positions. | **Fixed:** snapshotted into `Position.maint` at open. |
| 6 | Medium | Oracle freeze | `maxJumpBps` (5%) rejects legit large gap moves; oracle freezes → price stale → nobody can open/close/liquidate until `forcePrice`. Users' `withdraw` of free balance still works; `emergencyCancel` needs pause+emergencyMode. | **Documented**; owner runbook in MAINNET_LAUNCH.md. |
| 7 | Medium | Pause semantics | While paused, close/liquidate are blocked; busted positions aren't liquidated, so on unpause pool may have missed liquidations (or traders get saved by reversals). `guardian` can pause but not unpause; a malicious/compromised guardian can grief by pausing (not steal). | By design; pause is a safety stop. `emergencyCancel` gives users a way out at entry (no PnL) when owner sets emergency mode. |
| 8 | Medium | Queue bloat / dust | Anyone can add many tiny queue entries (cost: gas + ≥minMargin at risk) to lengthen `processQueue`. Processing is O(entries) with caller-chosen `maxEntries`, so no hard DoS. | Accepted. |
| 9 | Medium | Collateral token assumptions | Assumes plain ERC-20 (no fee-on-transfer — enforced by balance-delta checks; no rebasing; no ERC-777 hooks; blacklist (USDC) only blocks the blacklisted user). Decimals must be passed correctly (6). | Documented; deploy script hard-codes 6. |
| 10 | Low | PAPER10KX mint abuse | Mint only by `minter` (locked to the exchange at deploy). Self-liquidation farming costs the margin (forfeited to pool), so farming is net-costly, but if PAPER10KX ever acquired value, sybil farming would be the attack. Mint never reverts at cap (minted less) so liquidation can't be DoS'd by the cap. | OK. Supply cap `1e30` (1e12 tokens). Non-transferable by default. |
| 11 | Low | Reentrancy | All state-changing externals are `nonReentrant`, CEI used, only the collateral token and trusted `px` are called. | No issue found. |
| 12 | Low | Access control | `Ownable2Step`; guardian pause-only; `rescueToken` cannot touch collateral; `withdrawPool` only touches `pool` (not user funds) and cannot dip into `queuedTotal`. Contract deployed **paused**. | No issue found. Constructor sets owner = argument (use multisig). |
| 13 | Low | Rounding | Loss and bust-distance round in the trader's favour by <1 wei; no share/LP-token accounting so no first-depositor inflation attack. Haircut uses `mulDiv` (no overflow up to uint128 prices). | OK. |
| 14 | Low | Overflow/casts | Solidity 0.8 checked math; explicit guards before `uint128` (price, notional, margin) and `uint16` (maint ≤ 5000) casts. | OK. |
| 15 | Low | HyperCore adapter | `HyperCoreBboOracle` is **untested against the real precompile** (address, ABI encoding and decimals are from docs); returns `block.timestamp` (no real staleness info); spread guard rejects crossed/wide books. | **Must be verified on a HyperEVM fork/testnet before use.** |
| 16 | Info | Slither | 6 informational (missing zero-checks on `guardian`/`minter`(intentional)/precompile, strict equality on 0 checks, missing event on `setMaxSpreadBps`); timestamp/low-level-call detectors are intended. | Accepted. |
| 17 | Info | Immutability | No proxy: bugs require redeploy + user migration (withdraw works anytime). | By design. |

## Checklist result
reentrancy ✅ · access control ✅ (see 3,4,7) · oracle manipulation/staleness ⚠️ (1,4,6,15) · rounding/share inflation ✅ · pool insolvency ⚠️ (2) · pause & emergency paths ✅ tested (7) ·
PAPER10KX mint abuse ✅ (10) · integer overflow ✅ · front-running ⚠️ (1; open uses `worstPrice`).

## Tests of note
`test_liquidation_at_10000x_mints_px`, `test_profitCapAndQueue` (owner can't withdraw queue-reserved cash), `test_pauseWithdrawAndEmergency`, `test_oracleTimelock`, `test_stalePriceReverts`,
`Oracle.t.sol` (replay, wrong signer, future/stale ts, jump, tampered price), `testFuzz_settlementBounds` (payout ≤ margin + 100×margin; solvency after every settlement),
`InvariantTest` (cash ≥ free+margin+pool; queue sum; supply cap; free-balance sum).
