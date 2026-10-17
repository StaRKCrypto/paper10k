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

## 3. Oracle
- [ ] **Do not use `SignedPriceOracle` on mainnet** unless the signer is a hardened threshold/multisig service with monitoring and you accept AUDIT #4.
- [ ] If using `HyperCoreBboOracle`: verify precompile address (`0x…080e`), ABI (`bid,ask` uint64), per-asset `szDecimals`, and behaviour at block boundaries on a HyperEVM **testnet and fork**; add a second reference/deviation circuit-breaker; decide staleness semantics (adapter returns `block.timestamp`).
- [ ] Set `maxPriceAge`, `minHold`, deadband/haircut so latency arbitrage is unprofitable; simulate with real tick data.
- [ ] Runbook for oracle freeze (§ AUDIT #6): who calls `pause`, `setEmergencyMode`, `forcePrice`.

## 4. Pool-insolvency sizing at 10000x
Worst-case instantaneous liability ≈ `Σ_sides min(OI_side × haircut(move) , maxProfitMult × Σ margin)`. With `maxProfitMult=100` and per-position margin cap `M`, one position can owe `100·M`.
Choose `OI cap`, `MAX_MARGIN`, `TVL_CAP` and **seed** so that `pool ≥ ~5–10% of OI_cap` *and* `100 × (expected simultaneous winners × M) ≤ pool`. Example launch: seed $20k, MAX_MARGIN $50, OI cap $1M/side, TVL cap $5k.
Expect queue formation on any 0.5–1% BTC move if OI is near cap. Start tiny; raise caps only after audits and weeks of monitored operation. Monitor `pool`, `queuedTotal`, OI, price age; alert on queue > 0.

## 5. Owner/admin model
- Owner = **multisig (≥3/5) behind a ≥48 h timelock** (owner can change haircut/fees/caps retroactively — AUDIT #3). `Ownable2Step`: new owner must `acceptOwnership()`.
- Guardian = separate hot key that can only `pause()`.
- Powers: `setMarket`, `setRisk`, `setPricing`, `proposeOracle/applyOracle (delay)`, `seedPool`, `withdrawPool` (surplus only), `pause/unpause`, `setEmergencyMode`, `setGuardian`, `rescueToken` (not collateral). Users can always `withdraw` free balance, even paused.
- Emergency: `pause()` → (optional) `setEmergencyMode(true)` → users `emergencyCancel(id)` get margin back at entry (no PnL). There is no function that lets the owner take user balances or margin.

## 6. Exact deploy commands (run yourself, from a clean machine, hardware wallet)
```sh
git clone https://github.com/StaRKCrypto/paper10k && cd paper10k/contracts
export PATH=$PATH:~/.foundry/bin && forge test               # all green, then: forge build
# verify COLLATERAL (native USDC on HyperEVM; address seen in papertrade's bundle: 0xb88339CB7199b77E23DB6E890353E22632Ba630f) on hyperevmscan.io + Circle docs
export OWNER=<your multisig contract address>                 # MUST be a contract on mainnet
export COLLATERAL=<verified USDC address>
export MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK
export MAX_MARGIN=50000000 TVL_CAP=5000000000 MIN_MARGIN=1000000     # 6-dec units: $50 / $5,000 / $1
export USE_HYPERCORE_ORACLE=true                              # or ORACLE_SIGNER=<hardened signer> for the signed oracle
forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid.xyz/evm --ledger --broadcast   # or --account <keystore name>; never --private-key on a shared shell
# Then, from the multisig (each a separate proposal): 
#   PAPER10KX.acceptOwnership(); [HyperCoreBboOracle].configure(0, <BTC asset idx>, <szDec>); configure(1, <ETH idx>, <szDec>)
#   Exchange.setMarket(0,true,capLong,capShort); setMarket(1,...); setPricing/setRisk to reviewed values; setGuardian(<hot key>)
#   USDC.approve(exchange, seed); Exchange.seedPool(seed); verify sources on hyperevmscan; dry-run a $1 position; THEN Exchange.unpause()
```
Frontend: only after the above, edit `src/chain/config.js` → `MAINNET_ENABLED = true`, add `"999": {exchange, collateral, px, oracle, block}` to `deployments.json`, commit. The UI then shows a red **MAINNET — REAL FUNDS** banner on chain 999.

## 7. Go/no-go gates
Audits closed ✅ · legal opinion ✅ · oracle verified on fork ✅ · monitoring/alerts ✅ · multisig+timelock ✅ · caps tiny ✅ · incident runbook rehearsed ✅ · risk disclosures live ✅. Any ❌ → do not enable.
