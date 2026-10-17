# MAINNET_LAUNCH.md — checklist for the OWNER (nothing here has been run)

> **Status: mainnet is DISABLED.** `MAINNET_ENABLED = false` in `src/chain/config.js`; `Deploy.s.sol` refuses chain 999 unless `MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK`,
> a multisig `OWNER` (must have code), and `COLLATERAL` are set. No agent has deployed anything, held a funded key, or enabled the flag. **You run the deploy.**
> A 10000x leveraged-gambling product holding real user money carries serious legal, security and ethical risk — read §1–§4 before anything else.

## 0. Honest risk summary (also shown in the UI)
- Nearly all 10000x positions are liquidated within seconds (0.009% adverse move = total loss of margin; below normal price noise). The house wins most of the time by design.
- Pool insolvency: wins above pool cash become queued IOUs. Users can wait indefinitely.
- Oracle risk: price comes from a trusted signer (testnet) or an unverified precompile adapter (mainnet option). Latency arbitrage and manipulation are live risks (AUDIT #1).

## 1. Independent audit (blocking)
- [ ] ≥2 independent smart-contract audits of `contracts/src/` (not this repo's `AUDIT.md`, which is an AI self-audit). Scope: exchange math, queue, oracle, token, deploy script.
- [ ] Fix all High/Medium; re-audit diffs. Publish reports.
- [ ] Formal/differential tests: Solidity vs `src/engine.js` on random paths; fork tests on HyperEVM against the real precompile.
- [ ] Bug bounty live before TVL cap is raised (Immunefi etc.).
- [ ] Frontend security review (dependency pinning, CSP, no third-party scripts; WalletConnect bundle is vendored v2.11.3).

## 2. Legal / compliance (blocking) — get counsel; do not rely on this file
- [ ] Leveraged derivatives/CFD/perp offering: licensing (CFTC/NFA, SEC, FCA, ESMA/MiCA, MAS, SEBI/India VDA rules…) and *prohibited jurisdictions*; retail leverage caps (EU 2:1 crypto CFD, UK ban on retail crypto derivatives, US ban for non-ECP on unregistered venues).
- [ ] Gambling/gaming classification (the payoff is near-lottery at 10000x) — many jurisdictions require a gambling licence.
- [ ] Geo-blocking + ToS + sanctions screening (OFAC etc.), KYC/AML position, travel rule, tax reporting.
- [ ] Token: PAPER10KX is designed with no value/revenue/staking/transferability. Any change (transfers, rewards, sale) → securities/commodities analysis. Do not market it as an investment or airdrop-for-value.
- [ ] Entity, liability, insurance, privacy policy, risk disclosures; marketing rules (no "guaranteed", no targeting minors).
- [ ] "Papertrade" and its docs are third-party: confirm branding/IP does not imply affiliation (we use "inspired by").

## 3. Oracle (v2: HyperCore precompile pull oracle)
- [ ] Mainnet deploy uses `HyperCoreOracle` automatically; `SignedPriceOracle`/`TestUSDC` are testnet-only and the script refuses them on chain 999.
- [ ] **Verify on a live HyperEVM RPC before anything else** (`tools/verify-hypercore.sh`): BBO `0x…080e` returns `(bid,ask)` uint64, oraclePx `0x…0807` returns uint64, and the asset indices / `szDecimals` you pass to `configure` (BTC asset 0 szDec 5, ETH asset 1 szDec 4 at time of writing — re-check via `perpAssetInfo` 0x…080a / HL `meta`). Then deploy to HyperEVM **testnet (998)** and run a $1 open/close there; the in-EVM read has never been exercised (AUDIT "Unverified" #1).
- [ ] Guards: `HyperCoreOracle.setGuards(maxSpreadBps=30, maxDevBps=100, ref, maxRefDevBps, refMaxAge)`. Tune from real tick data. The oracle fails closed (trading halts) rather than serve a suspect price.
- [ ] Optional second reference (Pyth): only after you verify the HyperEVM Pyth address from Pyth's official docs and its `getPriceUnsafe` ABI; deploy `PythReference(owner, pyth)`, `setFeed(market, priceId)`, then `HyperCoreOracle.setGuards(..., ref=<PythReference>, ...)`.
- [ ] Latency-arb economics: set deadband/haircut/`minHold` so that your measured off-chain-information edge < costs; simulate.
- [ ] Runbook for oracle freeze: `pause()` (owner/guardian) → `setEmergencyMode(true)` → users `emergencyCancel`; or `proposeOracle` → wait delay → `applyOracle`.

## 4. Pool-insolvency sizing at 10000x
Worst-case instantaneous liability ≈ `Σ_sides min(OI_side × haircut(move) , maxProfitMult × Σ margin)`. With `maxProfitMult=100` and per-position margin cap `M`, one position can owe `100·M`.
Choose `OI cap`, `MAX_MARGIN`, `TVL_CAP` and **seed** so that `pool ≥ ~5–10% of OI_cap` *and* `100 × (expected simultaneous winners × M) ≤ pool`. Example launch: seed $20k, MAX_MARGIN $50, OI cap $1M/side, TVL cap $5k.
Expect queue formation on any 0.5–1% BTC move if OI is near cap. Start tiny; raise caps only after audits and weeks of monitored operation. Monitor `pool`, `queuedTotal`, OI, price age; alert on queue > 0.

## 5. Owner/admin model
- Owner = **multisig (≥3/5)**. The exchange has its own immutable timelock `configDelay` (deploy script: ≥ 1 day required on mainnet; use **2 days**), so a hostile or compromised owner cannot act instantly. Owner also controls `HyperCoreOracle` (guards) and `PythReference`: put those behind the same multisig; consider a timelock contract in front of them (they are not timelocked by themselves).
- **Open positions are protected:** parameters are versioned; a position keeps the version it opened under (maintenance margin, fees, haircut, deadband, cap, mint rate). New values only affect positions opened after `applyConfig`.
- Timelocked: `proposeConfig/applyConfig/cancelConfig`, `proposeMarket/applyMarket`, `proposeOracle/applyOracle`, `proposeWithdraw/applyWithdraw` (pool or insurance surplus only; blocked while wins are queued; can never touch free balances or margins). Instant: `pause`, `closeMarket` (owner or guardian), `unpause`, `setEmergencyMode`, `setGuardian`, `seedPool`, `fundInsurance`.
- Guardian = hot key that can only `pause()` / `closeMarket()`.
- Emergency: `pause()` → `setEmergencyMode(true)` → users `emergencyCancel(id)` get margin back at entry (no PnL). `withdraw` of free balance always works.

## 6. Exact deploy steps (run yourself, from a clean machine, hardware wallet). Nothing below has been run on mainnet.
```sh
git clone https://github.com/StaRKCrypto/paper10k && cd paper10k/contracts
export PATH=$PATH:~/.foundry/bin
forge test                                                        # 41 tests green
FOUNDRY_FUZZ_RUNS=5000 FOUNDRY_INVARIANT_RUNS=300 FOUNDRY_INVARIANT_DEPTH=100 forge test
bash ../tools/verify-hypercore.sh                                 # precompile layouts live on RPC
# 0. verify COLLATERAL (native USDC on HyperEVM; address seen in Papertrade's bundle: 0xb88339CB7199b77E23DB6E890353E22632Ba630f) on hyperevmscan.io + Circle docs
# 1. Rehearse on HyperEVM TESTNET first (chain 998, throwaway key from the official faucet, never a real key):
OWNER=<throwaway addr> USE_HYPERCORE_ORACLE=1 forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key <THROWAWAY> --broadcast
# 2. Mainnet deploy (deploys PAUSED; refuses unless every check passes):
export OWNER=<your multisig contract address>                    # MUST be a contract on mainnet
export COLLATERAL=<verified USDC address>
export MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK
export CONFIG_DELAY=172800                                        # 2 days (script requires >= 1 day)
export MAX_MARGIN=50000000 TVL_CAP=5000000000 MIN_MARGIN=1000000  # 6-dec units: $50 / $5,000 / $1
forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid.xyz/evm --ledger --broadcast
#   (or --account <keystore name>; never --private-key on a shared shell). Note printed: Oracle, PAPER10KX, Exchange.
```
Then, from the multisig, as separate transactions, in this order:
1. `PAPER10KX.acceptOwnership()`.
2. `HyperCoreOracle.configure(0, <BTC asset idx>, <BTC szDecimals>)` and `configure(1, <ETH asset idx>, <ETH szDecimals>)` (instant on the oracle, but no market is live yet). Optional: `setGuards(...)`.
3. `Exchange.proposeMarket(0, true, capLong, capShort)`, `proposeMarket(1, ...)` → **wait `configDelay`** → `applyMarket(0)`, `applyMarket(1)`. (Deploy defaults for risk params are the reviewed values in `script/Deploy.s.sol`; to change them: `proposeConfig(params, ops)` → wait → `applyConfig()`.)
4. `USDC.approve(exchange, seed)`; `Exchange.seedPool(seed)`; `Exchange.fundInsurance(ins)` (suggest ≥ 25 % of pool).
5. `Exchange.setGuardian(<hot key>)`; verify sources on hyperevmscan.
6. Dry run: with `MAX_MARGIN` tiny, `unpause()` and open/close a $1 position from a separate wallet; watch `getPrice` reverts (guard trips) for a day. If anything looks off: `pause()`.
7. Frontend: edit `src/chain/config.js` → `MAINNET_ENABLED = true`, add `"999": {exchange, collateral, px, oracle, block}` to `deployments.json`, commit. The UI then shows the red **MAINNET — REAL FUNDS** banner on chain 999.

## 7. Go/no-go gates
Audits closed ✅ · legal opinion ✅ · oracle verified on fork ✅ · monitoring/alerts ✅ · multisig+timelock ✅ · caps tiny ✅ · incident runbook rehearsed ✅ · risk disclosures live ✅. Any ❌ → do not enable.
