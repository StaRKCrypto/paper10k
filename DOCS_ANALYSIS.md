# papertrade.xyz — public documentation analysis

Sources read (all public, retrieved 2026-10-17): the docs site **docs.papertrade.xyz** (a client-rendered SPA; text extracted from its JS bundle),
the product site **papertrade.xyz** / app **exchange.papertrade.xyz**, the staking dashboard **papertrade.trade**, third-party write-ups
(DeFi Prime launch article, ORBITA, PaperJet docs, Circuit SDK reference, three.ws API doc) and the community repo `romme86/papertrade-api`
(reverse-engineered relayer client). **We found no official GitHub organisation or published contract source / audit** for Papertrade; the docs list
contract addresses only inside the SPA. Statements below are labelled *docs* (Papertrade's own words), *3rd-party*, or *inferred*.
Nothing here is verified on-chain by us.

## 1. What it is
Synthetic perpetuals on **HyperEVM (chain 999)**: BTC and ETH, USDC collateral, up to **1000x**, **no funding**, **no order book**, no price impact.
Every trade is a swap between the trader and a **liquidity pool (LP) that is the counterparty to everyone**. Isolated margin only, no top-up, no
partial close, no leverage change. Min margin $10, min notional $10,000, max notional per position $10M, per-side open-interest caps. (*docs, Circuit*)

## 2. Deposit / withdraw flow
- Trading state (positions, queue, balances) lives in an **Exchange contract on HyperEVM**; USDC itself is held on **HyperCore** (Hyperliquid's native spot
  ledger) and moved with **CoreWriter precompile actions**. (*docs*)
- **Deposit:** the user gets a **deterministic per-user proxy ("deposit address")** deployed via **CREATE2** from a single factory (salt/init-code hash public,
  so anyone can recompute and verify it). User sends USDC to it from Hyperliquid, HyperEVM, Ethereum, Arbitrum, Solana (bridged) or USDG from Robinhood Chain.
  Once the proxy holds ≥ 10 USDC (spot + withdrawable perp), a **sweeper/relayer** drives the Exchange "sweep" flow that pulls it into the Exchange's HyperCore
  account and credits the trading balance. Minimum 10 USDC must arrive *after fees*; first deposit pays a **1 USDC activation fee**. (*docs, 3rd-party*)
- **Withdraw:** minimum 10 USDC; **requires the user's main-wallet signature** (session keys cannot withdraw). Output goes back through HyperCore
  (`withdrawToCore`). (*docs, Circuit, API repo*)
- **Real onchain vs UI:** accounting, positions, queue and withdrawal authorisation are onchain; the *relayer* that batches intents, pays gas, sweeps
  deposits and runs the liquidation keeper is **offchain, operated by Papertrade** (centralised dependency, can pause: `VENUE_PAUSED`).

## 3. Wallet connect & chains
- Connect any compatible wallet; the app asks for **one signature that registers a 30-day session key** (scoped keypair) so trades need no popups. (*docs, API repo*)
- Trades are **EIP-712 signed intents** (by wallet or session key) POSTed to Papertrade's **relayer** which batches them onchain and pays gas — the user pays
  no gas. Third-party frontends can do the same, but the contracts only accept opens/closes/session-keys/staking from **configured relayer keys**.
  Withdrawals and PAPER stake/unstake/claim need the real wallet. (*docs, API repo*)
- Execution chain: HyperEVM 999. Funding sources span several chains via bridges (UI + bridge, not Papertrade contracts).

## 4. Pool / LP mechanics ("Martingaler Protocol")
- **No LP deposits.** The pool starts at **$0**; users cannot deposit into it. It grows only from realised trader losses/liquidations. (*docs*)
- If the pool cannot cover a win it issues **debt into a FIFO payout queue**, paid automatically as later losses refill the pool. Queued winners are
  unsecured creditors; no deadline. Margin lost while the queue is active is parked in a `sideBucket` and harvested into queue payouts. Positions can even
  be opened *from queued balance* (the debt claim is the margin). (*docs, ORBITA*)
- Solvency is therefore *deferred*, not guaranteed: the design trades instant payout for unbounded bet size and no seed capital.

## 5. Fees & payout haircut
- **No notional fee, no spread, no funding.** Revenue comes only from profitable closes: (*docs, Circuit*)
  1. **Asymmetric impact haircut** on the gain: `kept = notional × move × (1−baseRate) / (1 + 1/(move×rateMultiplier) + referenceNotional/(1e6×move×positionMultiplier))`,
     where `move` = distance from entry as share of entry **minus a deadband**; nothing if ≤ 0. Docs example: 1% move keeps ≈88%, 0.1% ≈74% of raw gain.
  2. **2% win fee** on what remains (`winFeeRate`). Losses pay nothing extra.
- Losing closes / liquidations also carry a 2% fee, carved from the LP's gain (not added to the user's loss), only while the queue is empty and the LP can cover it;
  never on liquidations of positions opened from queued balance. Fees are split between **PAPER stakers and a dev-fee recipient**.

## 6. Liquidation rules
- Each position shows a **bust price**: long `entry×(1−1/lev)×(1+bustBuffer)`, short `entry×(1+1/lev)×(1−bustBuffer)`, with `bustBuffer` ≈ **4.76 bps (≈5 bps)** fixed in price.
  Crossing it is a **hard bust: the entire isolated margin is forfeited** even if a voluntary close a moment earlier would have returned equity
  (at 1000x ≈ half the margin). A trader can never lose more than margin. (*docs, Circuit*)
- A **Papertrade-run keeper** submits liquidations immediately, paying a higher priority fee than any other protocol tx.
- *Inferred:* with a fixed-in-price buffer, the formula breaks above ≈2000x (buffer > 1/lev) — one reason Papertrade stops at 1000x and why our 10000x
  version snapshots a **percentage-of-margin** maintenance (see below) instead.

## 7. Contracts architecture (as described)
Proxied (upgradeable) contracts: **Exchange** (markets, positions, queue, balances, caps, pause), **proxy factory** + per-user **CREATE2 deposit proxies**,
**batch executor** (relayer entrypoint verifying signatures), **staking** (PAPER, rewards; `0xAAd6…F016` per papertrade.trade), **PAPER token**,
keeper functions (`pushStakerFees()`). **Owner** (per docs) can: swap relayers/keepers, list new markets (any HL perp incl. HIP-3), reconcile failed sweeps,
**upgrade implementations** ("in principle the owner can…" move funds via upgrade). Dev-fee recipient claims dev fees. No audit report was found in the public docs.

## 8. Oracle usage
**Hyperliquid BBO midpoint read directly by the contract through a HyperCore read precompile** (docs mention address `0x…080e`): "free, instant, no off-chain
feed, no price signer". Entry and exit both fill at the mid; size does not move price, bounded by OI caps. *Risks (inferred):* mid can be manipulated by thin-book
quoting at a block boundary; entry/exit at the same venue as hedging users; any precompile semantic change affects settlement; no staleness/deviation guard is documented.

## 9. Token
**PAPER**: fair launch, zero pre-mint/team/VC/airdrop/vesting. **Only mint path = a trader's losing close or liquidation**: 100 PAPER per $1 of eligible loss while tracked
LP < $2M, then decaying along an emissions curve. Initially **non-transferable**; can be staked/unstaked (instant, min 1,000 PAPER). Staked PAPER earns **USDC**:
(1) 1% of realised PnL of settled trades while queue is empty and LP covers it, (2) all LP gain above a **$5M cap** via `pushStakerFees()`. Not a loss refund, no promised value.
*Legal note (ours):* a token that pays USDC revenue share is a likely securities/CIS risk; ours (PAPER10KX) deliberately has **no revenue rights, no staking, no value**.

## 10. Real onchain vs UI/offchain summary
| Piece | Onchain | Offchain / UI |
|---|---|---|
| Positions, margin, PnL math, queue, balances, PAPER mint | ✅ Exchange | |
| Price | ✅ HyperCore precompile read | |
| Liquidation *execution* | ✅ function | 🟧 keeper run by Papertrade |
| Trade submission, gas | ✅ batch executor verifies sigs | 🟧 relayer (centralised, can pause) |
| Deposit sweep, multi-chain funding | ✅ CREATE2 proxy + HyperCore | 🟧 sweeper + bridges |
| Withdraw | ✅ needs wallet sig | 🟧 relayer submits |
| Upgrades / market listing / relayer set | ✅ owner | 🟧 key management unknown |
| Docs site, charts, leaderboards, stats | | ✅ UI |

## 11. What we copied vs changed in PAPER10K
| | Papertrade | PAPER10K on-chain version |
|---|---|---|
| Leverage | 1000x | **10000x** (hard-coded ceiling; owner can lower) |
| Pool | $0 start, no deposits | owner/house **seed** + losses; owner can withdraw only surplus above queued debt |
| Queue | FIFO debt queue | FIFO queue (same idea), plus **profit cap 100x margin** |
| Haircut | impact + 2% win fee | same shape, owner-bounded params, simplified (no reference-notional term) |
| Liquidation | fixed ~5 bps price buffer | **maintenance = 10% of margin** → bust at `(1−0.10)/lev` move (0.009% at 10000x), snapshotted per position |
| Oracle | HyperCore precompile only | `IPriceOracle`: EIP-712 **signed price** (testnet) or HyperCore-BBO adapter (untested), staleness + jump guards, timelocked swap |
| Relayer/session keys | yes | **No**: users send txs themselves (simpler, more gas, nothing to custody) |
| Token | PAPER, staking, revenue share | **PAPER10KX**: points only, non-transferable, mint on **liquidation only**, hard cap, no staking/revenue |
| Upgradeability | proxied | **immutable** (no proxy) — fixes by redeploy |
| Collateral | USDC on HyperCore | ERC-20 USDC on HyperEVM (tUSDC faucet token on testnets) |

---

# Addendum (2026-10-17, second pass) — findings the first pass missed

Method: read-only. Fetched the public landing page and JS bundles of papertrade.xyz (`/assets/main-*.js`, landing only — contains no contract data),
the docs SPA bundle `docs.papertrade.xyz/assets/index-*.js` (the full docs text is embedded; the first pass had an older/partial reading), and made
**read-only `eth_getCode` / `eth_call` / `eth_getStorageAt` calls to the public HyperEVM RPC** (`rpc.hyperliquid.xyz/evm`). No transactions, no keys, no wallet.
`exchange.papertrade.xyz` returned HTTP 404 to an unauthenticated fetch (SPA/geo/route gated) so the app bundle was **not** analysed. No code was copied; this is
our own summary. Everything below is *docs* (their words) or *on-chain-read* (we called it) as labelled; nothing is audited by us.

## A. Contract addresses (HyperEVM 999, from the docs "Contract addresses" page) — all 10 have code on-chain
| Contract | Address | On-chain read |
|---|---|---|
| Exchange | `0x6cd5661646289FB6E65EA5C032310fDEd797D0a2` | **ERC-1967 proxy** (1852-hex-char runtime), impl slot → `0x0f3febfc94876b0c895f7acecdc8f5c863b549ee`, `owner()` = the Timelock |
| BatchExecutor | `0x233Ff29b239abc1D7748605dA9b205C3e008626E` | proxy-sized code |
| PriceOracle | `0xa9B4c7b7Ca5835652d81E25739c870D49F39cC2e` | proxy-sized code |
| SessionKeyManager | `0x8326Eb8896e358717f10502Ec73CE8D28E37B108` | proxy-sized code |
| DepositProxyFactory | `0x1629b7D46bef6E13FF754174FC9F32dEa309b38F` | proxy-sized code |
| PaperToken | `0xe40f17915DAa230324030003A197cdAEf2261C0e` | proxy-sized code |
| PaperStaking | `0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016` | proxy-sized code |
| PaperTokenomics | `0x75174549dbBD44497D31a47E2E2D7406408d63D9` | proxy-sized code |
| USDC (collateral) | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` ("native Circle USDC on HyperEVM") | — (not independently verified vs Circle's list) |
| Timelock | `0xB915Fa41e824D6aA31BB833Ee81220C0F2c8EA0F` | contract (6.4 kB code); owner of Exchange |
| Multisig | `0x696292762fD5AC3677a45EdBe54EAECE4194d1F6` | contract (6.3 kB code), "2-of-3", owns the Timelock |
Precompiles named in the docs: BBO `0x…080e` (used), Mark `0x…0806`, Oracle `0x…0807` (read "for analytics / forward-compat"), CoreWriter (deposit sweep + `withdrawToCore`).
**Correction to §7/§11 of the first pass:** the docs now state a **7-day Timelock owned by a 2-of-3 multisig owns the contracts** (we confirmed `Exchange.owner()` == Timelock on-chain; we did *not* verify the 7-day delay or the multisig's signers/threshold — the Timelock's `getMinDelay()` selector reverted, so it is not stock OZ). "The owner can upgrade implementations" is still true, just behind that timelock. Still no published source/audit.

## B. Exchange function surface (decoded from the implementation bytecode with `evmole`, names via a public signature DB; 98 selectors, 52 resolved)
Resolved: `liquidate(uint256)`, `liquidateBatch(uint256[])`, `close(uint256[])` (batch), `harvest(uint256)`, `pushStakerFees()`, `requestSweep(address)`, `sweep(address)`, `pauseMarket(uint32)`,
`unpauseMarket(uint32)` (exists in ABI but docs say retired IDs can never be unpaused → expect a revert path), `setTradingPaused(bool)`, `setPauseGuardian/ setAuthorizedExecutor / setAuthorizedKeeper / setProxyFactory / setSessionKeyManager / setPaperTokenomics / changeDevFeeAddress`,
`setFeeRates(uint256,uint256,uint256)`, `claimDevFees()`, `creditStakingReward(address,uint256)`, views `lpBankrollAvailable() totalQueued() sideBucket() treasury() totalLockedMargin() totalBalances() queueHead() queueNode(uint256) userQueueHead(address) liquidationFeeRate() collateralScale() devFeeAccumulator() stakerFeeAccumulator() positions(uint256) getUserOpenPositionIds(address) nextPositionId() instrumentCount()`, `initialize(address,address,address)`.
Unresolved selectors with plausible shapes: `openPositionBySig`-style (7-arg incl. `uint256[]`), several `…BySig` withdraw/stake paths, `setInstrument/OI-cap/min-margin` keeper setters (`uint32,bool,uint128,uint32…`), `reconcileSweepCredit`.
Roles visible as getters: `owner`, `pauseGuardian`, `marketKeeper`, `authorizedExecutor` (BatchExecutor), `authorizedKeeper`, `devFeeRecipient`. Public maintenance paths (docs): liquidate, harvest, requestSweep/finalizeSweep, pushStakerFees, `withdrawToCoreBySig` (any submitter, wallet sig).

## C. Oracle & fee/risk parameters the first pass lacked (*docs*)
- **BBO read:** `staticcall(abi.encode(asset))` → `(uint64 bid, uint64 ask)`, **price = (bid+ask)/2**; asset index on the 999 deployment **BTC = 0, ETH = 1**. Reverts only if zero or **crossed** book. **No max-deviation, TWAP or lookback breaker** — Papertrade itself documents this as a residual risk ("BBO jitter": resting a non-filling inside quote shifts the mid a tick or two).
- **Deadband = 0.2 bps** (`entryPrice/50000`): raw profit below it → 0, above it the deadband is *subtracted* before the curve. (Our v2 default was 0.02 bps — 10× weaker; fixed in audit v3.)
- **Impact curve launch parameters:** `baseRate = 10 %`, `rateMultiplier = 15,000`, `referenceNotional = $100,000`, `positionMultiplier` **814.598 (BTC) / 483.979 (ETH)**; `scale = (1−baseRate)/(1 + 1/(move·rateMult) + refNotional/(1e6·move·posMult))`, `term2` uses a *fixed* reference notional (so haircut % is size-independent — a deliberate change vs Rollbit's model).
- **Fees:** 2 % win fee (on the gain after the haircut), 2 % LP-side fee on losing closes/liquidations of balance-funded positions only while queue empty & LP can cover it (`liquidationFeeRate = 0.02e18` read on-chain ✔). Half to PAPER stakers, half to dev-fee recipient. **Builder codes**: planned 1 % of the LP-revenue carve to originating frontends, *not live*.
- **Liquidation buffer ≈ 5 bps fixed in price** (worked example in docs: $99.05 trigger for a 100× $100 long) — at 1000× liquidation fires after ≈0.052 % while a voluntary close would still return ~half the margin.
- **Retirement mechanics:** `pauseMarket(id)` (pause guardian) freezes the BBO bid/ask at that instant; opens revert `MarketIsPaused`; closes/liquidations use the frozen BBO; **permanent**, relist under a fresh ID. `setTradingPaused(true)` is a reversible global opens gate (guardian engages, **only owner lifts**) and does *not* freeze price.
- **Market keeper:** moves per-asset, per-side **OI caps** (launch policy: current side OI + **$1B** of BBO-valued headroom, rebuilt only when headroom leaves a ±10 % band, i.e. $900M–$1.1B) and holds min-margin / min-position-value. Cannot touch the curve, collateral or oracle.
- **Queue internals:** `harvest(maxEntries)` is permissionless (unpaid caller; their keeper calls `harvest(32)`), pays `sideBucket` first; `lpBankrollAvailable()` is 0 whenever anything is queued; **debt-funded (queued-balance) positions**: the claim is the margin, a liquidation destroys it, no fee, still mints PAPER; USD margin returns immediately on a win (only *profit* queues).
- **Deposits:** only the relayer may deploy a deposit proxy (anti-gas-grief, ≥10 USDC at the address); `requestSweep(user)` snapshots Core balances, `finalizeSweep(user)` credits only if the proxy balance fell, else drops the snapshot and the **owner credits manually via `reconcileSweepCredit`** (manual trust path); raw ERC-20 transfers to the proxy on HyperEVM are *not* monitored (recoverable via `withdrawStuckToken` by the proxy owner). One deposit at a time.
- **PAPER mint curve:** flat 100 PAPER per $1 of mint basis while `trackedLpUsd < $2M`; above it `100·(S/(S+H))²` with `S = $120M` (`tailDecayScaleUsd`) and **H a one-way high-water mark** (`tailProgressUsd`, never decreases even when stakers drain LP). Mint basis = loss net of LP-side fee. Staking: `stakeBySig` only (direct stake disabled), PAPER auto-approves staking, `distribute()` public path disabled → `distributeBySig` via keeper/relayer. $5M "staker reward cap" on tracked LP; excess pushable by anyone via `pushStakerFees()`.
- **Data sources/contracts named:** `QueueLib.sol` (`settle`, `applyMarketImpact`) and `Exchange.sol`; whitepaper "Martingaler" by Martin Galer. The docs reference a repo path `contracts/src/…` but we found no public repo.

## D. Live on-chain snapshot (read-only `eth_call`, 2026-10-17 ~16:30 IST; point-in-time, unverified interpretation)
`instrumentCount = 2`, `tradingPaused = false`, `queueHead = 4` with `totalQueued = 0` and `sideBucket = 0` (queue currently empty), `nextPositionId ≈ 1,152,533`,
`treasury ≈ $67.8 M`, `totalLockedMargin ≈ $9.47 M` (values 1e18-scaled, `collateralScale = 1e12` for 6-dec USDC). So the "pool starts at $0" story has long since changed: at least ≈$58 M of non-margin treasury (LP + fees + balances) sits in the Exchange. Owner = Timelock confirmed.

## E. What we still could NOT see
The app bundle (`exchange.papertrade.xyz`, 404 without session/route), unresolved selectors, contract source (unverified on the explorer as far as we could fetch), Timelock delay value on-chain, multisig signer set, relayer/keeper EOAs (getters return addresses; not labelled). Inferences remain inferences.

## F. Tooling vetting note (REA, `rea-agents@6.5.0`)
Vetted before use: MIT licence; npm `scripts` have **no `preinstall/install/postinstall`** (only `prepare` → husky, which is a no-op for a registry install, and `prepack`); 1,650-file tarball, a prebuilt Windows `.node` (irrelevant on Linux); `install.sh` only runs `curl` to the GitHub releases API and `npm install -g`; `dist` URLs are only GitHub/Hopper/example domains — no telemetry hosts found; it spawns external RE tools (Ghidra, Frida, gdb…) only when asked. We installed it with `--ignore-scripts` in a throwaway dir with an empty env (`env -i`, throwaway `HOME`) and only ran `--help` (Node 20 here vs. its required ≥22.19, so we did **not** run its analysis commands). The site analysis above was done with plain `curl` + our own scripts plus REA's own dependency `evmole` (selector extraction). We did not run `rea setup`/`mcp add` (would write agent configs).
