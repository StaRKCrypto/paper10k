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
