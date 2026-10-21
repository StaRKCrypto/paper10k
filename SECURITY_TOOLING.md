# PAPER10K: security tooling and pre-deploy check

Branch `oracle-l2-adapters`, worktree `/workspace/p10k-sec` (forked from `a4aca65`). Build: Foundry, solc 0.8.26, `via_ir = true`, optimizer 200, cancun.
Scope: `contracts/src/{Paper10kExchange,ChainlinkPythOracle,HyperCoreOracle,PythReference,Paper10kX}.sol`. `testnet/` mocks and `script/` are out of scope.
Raw tool output is in `security/`.

> This is an automated, tool-assisted check plus a focused manual pass. **It is not an audit.** See "What's left for a human auditor".

## 1. Tools and references (GitHub stars checked live via the GitHub API on 2026-10-21)

| Tool / resource | Repo | Stars | Use here |
|---|---|---|---|
| Slither (Trail of Bits / crytic) | https://github.com/crytic/slither | 6,385 | static analysis, run |
| Aderyn (Cyfrin) | https://github.com/Cyfrin/aderyn | 798 | Rust static analyser, run |
| Mythril (ConsenSys Diligence) | https://github.com/ConsenSysDiligence/mythril | 4,274 | symbolic execution, run on the Exchange (time-boxed) |
| Echidna (crytic) | https://github.com/crytic/echidna | 3,185 | property fuzzer, run |
| Medusa (crytic) | https://github.com/crytic/medusa | 495 | parallel property fuzzer, run (same harness) |
| Halmos (a16z) | https://github.com/a16z/halmos | 1,035 | symbolic testing of Foundry tests. **Not run**, suggested next step |
| Foundry (forge fuzz + invariant) | https://github.com/foundry-rs/foundry | 10,684 | existing fuzz and invariant suites, run |
| Semgrep smart-contract rules (Decurity) | https://github.com/Decurity/semgrep-smart-contracts | 712 | pattern rules, run (semgrep 1.182.0) |
| crytic/properties (ERC and DeFi property library) | https://github.com/crytic/properties | 371 | reference for invariants |
| Building Secure Contracts (Trail of Bits) | https://github.com/crytic/building-secure-contracts | 2,480 | guide, used for the fuzzing approach |
| Cyfrin audit checklist (backs the Solodit checklist, https://solodit.cyfrin.io/checklist) | https://github.com/Cyfrin/audit-checklist | 372 | manual checklist |
| Solodit findings content | https://github.com/solodit/solodit_content | 133 | search past perp, oracle and liquidation findings |
| SWC Registry | https://github.com/SmartContractSecurity/SWC-registry | 902 | weakness IDs. No longer maintained (last push 2024-08) |
| Smart contract vulnerabilities (kadenzipfel) | https://github.com/kadenzipfel/smart-contract-vulnerabilities | 2,496 | vulnerability list |
| DeFiHackLabs (SunWeb3Sec) | https://github.com/SunWeb3Sec/DeFiHackLabs | 6,827 | real exploit PoCs (oracle, perp, liquidation) |
| DeFiVulnLabs (SunWeb3Sec) | https://github.com/SunWeb3Sec/DeFiVulnLabs | 1,981 | vulnerable-pattern labs |
| SCSVS (ComposableSecurity) | https://github.com/ComposableSecurity/SCSVS | 512 | verification standard |
| Pashov audit reports | https://github.com/pashov/audits | 1,335 | public reports, including perp DEXes |
| Certora Prover (open source) | https://github.com/Certora/CertoraProver | 338 | formal verification. Not run |
| OpenZeppelin Contracts | https://github.com/OpenZeppelin/openzeppelin-contracts | 27,290 | the dependency used (Ownable2Step, SafeERC20, ReentrancyGuard) |

Perp-specific vulnerability list: the GitHub search turned up no dedicated, widely starred "perp DEX vulnerability" repo. For perp, oracle and liquidation classes, use the Solodit search (tags *oracle*, *liquidation*, *perpetual*), DeFiHackLabs and the Cyfrin checklist (sections on oracles and liquidations).

## 2. Commands (all run inside `contracts/`)

```bash
# install (box): python venv (py3.13) for slither/semgrep; uv venv py3.10 for mythril (needs setuptools<70); release binaries for echidna 2.2.7, medusa 1.5.1, aderyn
python3 -m venv /workspace/secvenv && /workspace/secvenv/bin/pip install slither-analyzer semgrep solc-select
uv venv -p 3.10 /workspace/mythvenv && VIRTUAL_ENV=/workspace/mythvenv uv pip install mythril "setuptools<70"
git clone --depth 1 https://github.com/Decurity/semgrep-smart-contracts /workspace/sectools/semgrep-smart-contracts

forge build && forge test                                                     # 81 pass, 1 skipped (ForkL2 needs --fork-url)
slither . --filter-paths "lib/|test/|script/|testnet/" --exclude-informational --json ../security/slither.json
aderyn . --src src -x testnet -o ../security/aderyn.md
semgrep --metrics=off --config /workspace/sectools/semgrep-smart-contracts/solidity src --exclude testnet --json -o ../security/semgrep.json
# mythril on the via-IR runtime bytecode (source mode cannot replay the via_ir + remappings build); time-boxed
myth analyze -f ../security/Exchange.runtime.hex --bin-runtime --execution-timeout 900 -t 2 --solver-timeout 20000
echidna . --contract P10KEchidna --config test/invariants/echidna.yaml          # 50k calls
medusa fuzz --config test/invariants/medusa.json                              # 10 min, about 3.27M calls
```

### Invariant harness: `contracts/test/invariants/P10KEchidna.sol` (one harness for both Echidna and Medusa)
Setup: limits on (minNotional 10, maxNotional 1M, maxWalletMargin 2k, LP utilisation 50%, jump breaker 3% over 60 s), pool 200k, 3 actors, 10000x max leverage, bounty 2%.

| Property | Meaning | Echidna | Medusa |
|---|---|---|---|
| `echidna_solvency` | cash >= totalFree + totalMargin + pool + insurance | pass | pass |
| `echidna_users_backed` | cash >= totalFree + totalMargin | pass | pass |
| `echidna_owed_paid_when_funds_exist` | after `processQueue`, queuedTotal == 0 or pool + insurance == 0 (owed winners are never left unpaid while house funds sit idle) | pass | pass |
| `echidna_no_open_beyond_limits` | no successful open beyond min/maxNotional, maxWalletMargin, LP-utilisation cap, OI cap or 10000x | pass | pass |
| `echidna_liq_only_underwater_after_two_blocks` | a successful `liquidate` had a mark at least 2 blocks old, still inside the TTL, and the liquidation price was past bust | pass | pass |
| `echidna_owner_withdraw_reserve_gated` | a successful owner `applyWithdraw` never leaves pool + insurance below `reservedLiability()` | pass | pass |

Echidna's coverage report confirms that `open`, `liquidate` (through the 2-block path), `_payProfit` queueing and `applyWithdraw` were all reached. The existing Foundry invariant suite (`test/Invariant.t.sol`, 14 invariants) also passes.

## 3. Findings (triaged, sorted by severity)

TP = true positive, FP = false positive, D = design or accepted risk.

| ID | Sev | Source | Finding | Verdict | Status |
|---|---|---|---|---|---|
| M-1 | **High (design)** | manual | **Pyth pull-oracle price selection / latency arbitrage.** `getPriceUnsafe` accepts any Pyth price up to `pythMaxAge` (<=120 s) old, and the exchange gate is `maxPriceAge` (5–600 s). A trader can open on a stale stored price and close after posting a fresh update (or the reverse). At 10000x a 0.01% move equals 100% of margin. `minHold`, the deadband (<=1%), `maxDevBps` against Chainlink and `maxProfitMult` limit but do not remove the edge. | TP (economic) | **Open, human auditor.** Recommend two-step orders (request, then keeper fill at a Pyth price with publishTime > request time), or require `publishTime >= block.timestamp - 1..2 s` in the same tx as the update, and set maxPriceAge to the minimum |
| SEC-1 | Medium | manual | LP-utilisation cap (`maxLiabPoolBps`) counted `pool + insurance` as backing capital even when that cash is already owed to queued winners (`queuedTotal`). New risk could be opened against money that is spoken for. | TP | **Fixed**: cap now uses `max(0, pool + insurance - queuedTotal)`. Test `test_sec1_utilisationCapExcludesQueuedDebt` (fails before, passes after) |
| M-2 | Medium | manual | Centralisation: the owner can pause instantly. While paused, `close`, `markLiquidatable` and `liquidate` are blocked, and margins are recoverable only if the owner also turns on `emergencyMode`. A malicious or lost owner key can freeze open margins indefinitely. Free balances stay withdrawable. Oracle, params and withdraw changes are timelocked (`configDelay`). | D | Open. Use a multisig plus a timelock contract as owner. Consider auto-emergency after N hours paused |
| M-3 | Low/Med | manual | `getLiquidationPrice` reports the Pyth timestamp while the Chainlink leg may be up to `clMaxAge` (<=2 days) old. A stale CL price can only *block* liquidation ("least favourable" pick), and loss is capped at margin (isolated), so the house takes no bad debt. Underwater positions may linger. | D | Open. Tune `clMaxAge` to the feed heartbeat |
| SEC-2 | Low | manual (seen via Aderyn H-2 context) | `ChainlinkPythOracle._cl` called `decimals()` outside the try-guard, so a reverting feed made `getPrice` and `getLiquidationPrice` **revert** instead of failing closed with `(0,0)` as documented. | TP | **Fixed**: guarded with try/catch. Test `test_sec2_chainlinkDecimalsRevertFailsClosed` |
| L-1 | Low | manual | The jump circuit breaker re-anchors `refPx` to whatever the price is after `jumpWindow`, so it delays rather than blocks opens after a real jump. | D | Accept / document |
| L-2 | Low | manual | `close()` on a busted position self-liquidates without the 2-block mark (owner only, zero bounty). This is intended. | D | Accept |
| A-H1 | (High per Aderyn) | Aderyn | "Storage array edited with memory": `paramsHistory[p.pv]` passed to pure helpers (`_busted`, `bustPrice`). They only read it. | FP | |
| A-H2 | (High per Aderyn) | Aderyn | Unsafe cast `uint64(upd)` in `_cl`: `upd <= block.timestamp`, which fits. | FP | |
| MY-101 | (High per Mythril, x46) | Mythril | SWC-101 integer overflow on trivial getters (`WAD()`, `paused()`, `pool()`...). These are artefacts of symbolic execution over via-IR bytecode. Solidity 0.8 checked arithmetic reverts on overflow. | FP | |
| MY-123 | (Med per Mythril) | Mythril | SWC-123 requirement violation in `seedPool`: the nested ERC20 call reverts when the token is not set (empty symbolic storage). | FP | |
| S-1 | Med (Slither) | Slither `incorrect-equality` | `== 0` checks on prices, timestamps and queue amounts. These are sentinels, not balance equality. | FP | |
| S-2 | Med (Slither) | `uninitialized-local` | `ts` in `_liqPrice` and `bounty` in `_liquidate` default to 0 intentionally. | FP | |
| S-3 | Med (Slither) | `unused-return` | Destructured `latestRoundData` ignores roundId/answeredInRound. Acceptable for Chainlink L2 feeds, which do not use answeredInRound. | FP | |
| S-4 | Low (Slither) | `missing-zero-check` setGuardian/setMinter, `events-maths` PythReference.setMaxConfBps, `timestamp` | Zero guardian is a valid "none"; timestamps are inherent to staleness and timelock checks. Missing event in `setMaxConfBps` is informational. | FP / Info | |
| AD-L | Low (Aderyn L-1..L-11) | Aderyn | Centralisation (see M-2), loop over `marketIds` (owner-bounded), literals, `nonReentrant` order, PUSH0 (cancun target, OK on Base/Robinhood), unspecific pragma. | Info | |
| SG | Info (x91) | Semgrep Decurity | Gas and style only (custom errors, prefix ++, nested ifs, `basic-arithmetic-underflow` on 0.8 checked math). No security rule matched. | FP / Info | |

No Critical findings. Fuzzing with both Echidna and Medusa falsified none of the required invariants.

Other changes in the commit:
- `test/ForkL2.t.sol` now `vm.skip`s when it is not on a Base (8453) or Robinhood (4663) fork instead of reverting. The suite is green offline; run it with `--fork-url`.
- Exchange runtime size after the fixes: 22,761 B (EIP-170 limit is 24,576).

## 4. What's left for a human auditor
1. **M-1 Pyth latency and price-selection arbitrage at 10000x.** This is the highest-risk area. It needs economic modelling and probably a two-step order flow.
2. Economic review of the profit curve (`_pnl`: deadband, rate multiplier, `maxProfitMult`, fee) against the pool and insurance size. Check whether the house edge holds under adversarial flow, and whether the queue (unbacked debt) can grow without bound.
3. `HyperCoreOracle` and `PythReference` were only tool-scanned, not manually reviewed in depth.
4. Keeper and MEV: mark, clearMark and liquidate races, griefing via `clearMark` near the bust price, and L2 sequencer downtime on Robinhood Chain (no uptime feed).
5. Governance and ops: owner = multisig + timelock, guardian key handling, deploy script correctness (`script/Deploy.s.sol`), minter lock, `finalizeBootstrap`.
6. Formal or symbolic checks: Halmos or Certora on `_pnl` bounds, bust price and the accounting invariants.
7. Suggested routes. No prices are quoted; get quotes directly.
   - Competitive audit: **Code4rena** (https://code4rena.com), **Sherlock** (https://www.sherlock.xyz, also offers post-audit coverage), **Cantina** (https://cantina.xyz, competitions or a solo or team review).
   - After launch: an **Immunefi** bug bounty (https://immunefi.com) with critical rewards scaled to TVL.
