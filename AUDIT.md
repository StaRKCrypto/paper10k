# AUDIT.md — AI self-audit of the PAPER10K contracts (v2, after remediation)

> **This is an AI-generated self-audit by the same agent that wrote the code. It is NOT an independent audit, carries no assurance, and is NOT a
> substitute for a professional audit (and legal review) before any mainnet use.** Several issues are *design-level risks that cannot be fixed in code*.
> v1 findings are kept below with their v2 status. Nothing has been deployed to any mainnet.

## v2 summary — what changed (remediation round)
| v1 # | Fix in v2 |
|---|---|
| 1 latency arb | **Oracle replaced.** Mainnet uses `HyperCoreOracle`: a *pull* read of the HyperCore BBO precompile (`0x…080e`) and `oraclePx` (`0x…0807`) **inside the trade transaction** — no price is ever pushed, so there is no stale-price window. Guards (fail closed → price 0 → trade reverts): spread ≤ 30 bps, crossed/zero book, |mid − oraclePx| ≤ 100 bps, optional second reference (`PythReference`, conf + staleness + deviation). Win-side "spread": deadband (default 0.0002 %) zeroes tiny wins plus the haircut; `minHold` 3 s and a same-**block** open/close ban. *Residual:* a trader with faster off-chain information than HyperCore's own book still has an edge for moves ≥ deadband; tune with real data. |
| 2 insolvency | **Insurance fund** (`fundInsurance`, `insuranceBps` = 10 % of liquidated margin + win fees flow in). Wins are paid pool → insurance → FIFO queue. Insurance withdrawal is timelocked and blocked while the queue is non-empty. Exact-equality cash-conservation invariant added. *Residual:* correlated wins can still exceed pool + insurance (queue); sizing in MAINNET_LAUNCH §4. |
| 3 owner power | **Versioned parameters + timelock.** `maintBps, fees, haircut rate, deadband, profit cap, mint rate, leverage cap, margin limits` live in a `Params` history; every position stores the version it opened under, so **a config change cannot alter an open position's bust price or payout** (fuzzed + invariant `bustFrozenAtOpen`). `proposeConfig/applyConfig`, `proposeMarket/applyMarket`, `proposeOracle/applyOracle`, `proposeWithdraw/applyWithdraw` all wait the immutable `configDelay` (mainnet script enforces ≥ 1 day; launch doc says 2 days). Instant powers are only safety-reducing: `pause`, `closeMarket` (guardian too). *Note:* `Ops` (deposit cap, `maxPriceAge`, `minHold`) are applied with the same timelock but are operational limits that also affect open positions' close timing (not their economics). |
| 4 signed oracle | `SignedPriceOracle` and `TestUSDC` moved to `src/testnet/`; **the Deploy script refuses them on chain 999**. |
| 5 maint snapshot | Subsumed by versioned params. |
| 6 oracle freeze | No jump guard in the primary oracle (gaps are real). If a guard trips, trading halts but `withdraw` of free balance and `emergencyCancel` keep working; owner can swap oracle after the delay. |
| 15 untested adapter | Precompile layouts **verified live with `eth_call` against the public HyperEVM RPC** (BBO → `(uint64 bid, uint64 ask)`, oraclePx → `uint64`, scale `10^(6−szDecimals)`; BTC szDec 5, ETH 4). Mock-precompile unit tests cover every guard. *Still not run in a HyperEVM fork test or deployed — see "Unverified".* |

## Scope & method (v2)
`contracts/src/*.sol` (Solidity 0.8.26, OpenZeppelin 5.1.0 vendored). Slither 0.11.6 re-run: `slither . --filter-paths "lib|test|script"` → **0 high, 0 medium actionable**.
Remaining detector output: `timestamp`, `low-level-calls` (the intentional precompile `staticcall`), `costly-loop` (queue processing, caller-bounded), `incorrect-equality` (`== 0` sentinel checks only), `missing-zero-check` (`setGuardian(0)` intentionally disables the guardian; `setMinter` locks), unindexed event addresses, one missing event on `PythReference.setMaxConfBps`. All accepted.

Tests: `forge test` → **41 tests** (unit, governance/timelock, oracle guards with mock precompiles, Pyth adapter, token, 7 fuzz properties, 9 stateful invariants). Run at 5000 fuzz runs and 300 × depth-100 invariant runs: clean. Coverage: Exchange 98 % lines / 95 % statements, HyperCoreOracle 100 % lines, total 85 % (testnet-only helpers lowest).
Invariants: exact cash conservation (`balance == free + margin + pool + insurance`), users always fully backed, Σ position margins == `totalMargin`, queue sum, free-balance sum, OI == Σ notionals, **bust price frozen at open under random config changes**, params version monotone, PAPER10KX supply ≤ cap.
Mutation checks: (a) double-counting liquidation margin into the pool → caught by 3 unit tests, the conservation invariant and a fuzz test; (b) `unpause` not clearing emergency mode → was **not** caught, so `test_unpauseClearsEmergencyMode` was added.
Fuzz properties: settlement ≤ margin·(1+cap) and solvent for any leverage/side/move; wins monotone in move; bust distance = (1−maint)/lev; random valid config never changes an open position's bust or payout; deposit/withdraw accounting; owner withdrawal bounded by pool/insurance; PAPER10KX mint exact.
Also verified end-to-end on local anvil (public dev keys only) through the real UI: connect, wrong-network prompt, sign-in, faucet, deposit, open, liquidation minting PAPER10KX.

## Unverified / not done (be explicit)
1. `HyperCoreOracle` has **never executed against real HyperCore state inside the EVM** (no fork test possible here; Foundry's EVM has no HyperCore precompiles). Only the byte layouts were checked via raw RPC. Gas use of the precompile reads and behaviour at block boundaries are unmeasured on-chain.
2. `PythReference`: the Pyth contract address on HyperEVM and the `getPriceUnsafe` ABI were **not verified** (address only seen truncated). It is optional and off by default; do not enable until verified from Pyth's official address list.
3. Guard thresholds (30 bps spread, 100 bps oraclePx deviation, 0.0002 % deadband, 3 s hold) are untuned; a single live sample showed book-vs-`oraclePx` deviation ≈ 4.5 bps (BTC) / 4.7 bps (ETH) and spreads < 0.5 bps, so 100 bps is generous; it may still halt trading in violent markets (fails safe, a liveness cost). One sample is not tuning.
4. No public-testnet deployment (no faucet-funded throwaway key could be obtained safely), WalletConnect never tested with a real wallet.
5. Latency arbitrage is *reduced and priced*, not eliminated. Keeper liquidation ops/incentives are not built (anyone can call `liquidate`; no bounty).
6. Independent audit, legal review, owner multisig/timelock setup, USDC address verification: all still required.

---
# Original v1 findings (status updated above)
Scope: `contracts/src/*.sol` @ this commit (Solidity 0.8.26, OpenZeppelin 5.1.0 vendored). Method: manual review against the checklist below, Slither 0.11.6
(`slither . --filter-paths "lib|test" --exclude-dependencies`), Foundry unit + fuzz + stateful invariant tests, one mutation check (injecting a +1 wei pool
inflation in `_liquidate` is caught by `invariant_solvent`). **Not done:** formal verification, differential fuzzing vs. the JS engine, fork tests against the real
HyperCore precompile, gas-griefing analysis under real chain conditions, review of the frontend for XSS beyond escaping.

Deep invariant run: 4 seeds × 6000 runs × depth 150 (`FOUNDRY_INVARIANT_RUNS=6000 FOUNDRY_INVARIANT_DEPTH=150`) clean after excluding system contracts as fuzz senders (an early failure was a test artefact: the fuzzer used the exchange itself as `msg.sender` to call `usdc.transfer`; not a contract bug).

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
