# HOUSE.md — the simulated house, the LP pool, and why 10000x is dangerous

> **Everything here is simulated.** The pool, the LPs, the "bot traders" and every dollar are fake. No real money, wallets or keys. Not financial advice.

This follows the structure observed in `ANALYSIS.md` for papertrade.xyz-style venues: no order book, fills at the oracle (Hyperliquid) mid with **zero market impact**, and a house/vault as the counterparty to every trade. PAPER10K models that counterparty explicitly (`src/pool.js`, `src/venue.js`).

## 1. Who is on the other side?
Every trade is against the **house pool**. Because fills are at mid with no impact, the pool is *not* a market maker earning a spread; it is a **counterparty taking the opposite side of net trader flow**:

- trader **loses** (price moves against them, funding paid, liquidation) → pool **gains**;
- trader **wins** → the pool **pays**;
- **fees** (3.5 bps open and close, simulated) → pool;
- **funding** paid by traders → pool (received funding is paid by it).

So the pool is, economically, short whatever traders are net long, per market. Its expected PnL = fees + funding + (trader losses − trader wins). If traders are collectively skilled (or lucky) the pool loses.

## 2. Accounting (what the code does and the tests prove)
Two buckets, never mixed:

| bucket | owner | meaning |
|---|---|---|
| `assets` | LPs | cash LPs own, backs payouts |
| `collateral` | traders | margin posted by open positions, **not** usable for payouts |

- **Open:** trader pays `margin + fee`. `collateral += margin`, `assets += fee`.
- **Close / liquidation:** trader receives `proceeds = max(0, margin + uPnL − funding)` minus close fee. `collateral −= margin`; `assets += margin − (proceeds − closeFee)`. Liquidation: proceeds = 0, pool keeps the margin (this engine forfeits the full margin on liquidation).
- **Conservation invariant** (tested after every step of a 4000-step randomised soak with bots, LP flows, a whale-win drill and a reset):
  `assets + collateral + Σ(trader balances + reserved limit orders) == total simulated funds minted`.
- **Share price** = `NAV / total shares`, `NAV = assets − Σ trader unrealised PnL` (a trader's unrealised loss counts at most their margin, because margin is isolated). Open winners are therefore a *liability* marked into the share price, so a late depositor cannot buy in cheaply on top of a winning trader's unrealised gain, and an LP cannot exit just before it is realised.
- **Deposit** mints `amount / sharePrice` shares; **withdraw** burns `amount / sharePrice` shares. Neither changes the share price. The house seed ($1,000,000, held by "house") is just another LP.
- **Withdrawals** are limited so the pool still covers open exposure: `maxWithdraw = min(your value, NAV − reserve)`, `reserve = max(net exposure / net-cap%, largest side OI / OI-cap%, open winners)`.
- **Fee APR** shown in the LP tab = fees over the last ≤30 min, annualised (simple, not compounded), over average NAV. With simulated bots it is only a *demo number* — random and noisy, not a forecast.

## 3. Risk controls
All are constants in `POOL_CFG` and are caps **as a function of pool size** (NAV, so they shrink as LPs lose money):

| control | default | effect |
|---|---|---|
| per-market, per-side OI cap | 30% of pool | blocks opens that grow a side beyond it |
| max net exposure | 25% of pool | Σ over markets of \|long OI − short OI\|; blocks net-increasing opens |
| max position size | 5% of pool × leverage tier | tier: ≤100x ×1, ≤1000x ×0.5, **>1000x ×0.2** → at the $1M seed, a 10000x position is max **$10,000 notional** ($1 margin) |
| stress multiplier | ok/watch ×1, stress ×0.5, critical ×0 | tightens caps for *new* risk; at critical, only net-reducing orders are accepted |
| payout haircut (option) | on | when **stress/critical**: winning payout (the profit, never the margin) is scaled by `min(1, pool assets / Σ open winners)` |
| hard payout cap | always | a win can never exceed pool assets; pool assets can't go negative; any shortfall is recorded as `stats.shortfall` |
| auto-deleverage (ADL) | +10% over a hard cap | positions on the overweight side are closed **at mark, fee-free**, most profitable×leverage first, until caps hold |
| stress banner | watch / stress / critical | based on utilization (max of net/cap, side-OI/cap: ≥65% / 85% / >100%) **or** share-price drawdown from peak (≥5% / 15% / 30%) |

Limit orders are re-checked against the caps at *fill* time; a rejected fill is refunded in full. Caps also apply to bot traffic: bots go through the same gate.

## 4. Why 10000x is dangerous

### For traders
- Liquidation at `(1 − 0.10)/10000 = 0.009%` adverse move. BTC at $100,000: **$9**. That is less than the bid-ask spread, one tick of noise, or a wick.
- The fee on notional (3.5 bps) is `3.5 ×` the margin at 10000x: the round trip costs 7× the stake. You are underwater the instant you open. Expected outcome ≈ lose 100% of margin, quickly.
- Gambler's-ruin arithmetic: the barrier is 0.009% away. To merely **break even** after 7 bps of round-trip fees you need a favourable move of about +0.07% *before* a 0.009% adverse tick. A driftless price does that with probability ≈ 0.009 / (0.07 + 0.009) ≈ **11%**; the other ~89% lose the whole margin. Even a +100% ROE win (+0.01%) is ≈ 47% before fees and a loss after them.

### For the pool (the asymmetry)
- A trader's loss is **capped at margin** ($1), their win is **uncapped** (a $10k notional position gains $100 on a 1% move = 100× margin). The pool is selling cheap, deep out-of-the-money-for-the-trader / in-the-money-for-the-pool *options* with payoff 100×; many small premia, rare large payouts.
- Notional is `100×–10000×` the collateral that is actually posted. The collateral is not a buffer for the pool: a winning 10000x trader is paid from **LP assets**, margin is returned and profit comes from the pool.
- **Correlation:** 10000x traders across markets all long during a pump are one trade. Net exposure cap addresses this; per-market caps alone would not.
- **Wicks and sampling:** the sim only checks liquidation on observed mids (~1 s ticks). A sub-tick wick through the liquidation price that reverts is *not* seen: the trader escapes liquidation for free and keeps the upside. That is a free option against the pool. At 10000x the whole liquidation band (0.009%) is smaller than normal tick-to-tick noise on most coins, so many positions are liquidated at a price already beyond their liquidation price (fine for the pool, who keeps only margin), while others survive wicks that a real engine with a mark-price/index feed would have liquidated. In a real venue this is mitigated with a faster mark price, candle high/low checks, and a liquidation buffer; here it is **documented but not mitigated**, which is why the high-leverage position cap exists.
- **Oracle latency / free-option fills:** fills at a mid that can be seconds stale vs. the real market make high leverage a pure latency game for a real attacker. In a simulator this only shows up as extreme variance.
- **Gap risk (the trader's free put):** isolated margin means a trader's loss stops at the margin. If price gaps far through the liquidation price, the excess loss is simply forgiven: the position is closed, the margin kept, nothing more is collected. The trader has a floor under the loss and unlimited upside, which is exactly the payoff the pool is selling.

### What the controls do and do not do
- Caps bound *how big* the pool's worst case can be (e.g. net ≤ 25% of NAV: a 4× adverse move would be needed to wipe it out, but 1000x-leveraged traders in aggregate can move *their own PnL* by a few % of notional easily). They do not make the trade positive-EV for the pool.
- The haircut socialises a loss: winners get less than they were owed. That is unfair to winners but protects LPs and solvency; it is an option for exactly that tradeoff.
- ADL is a last resort: it forcibly closes winners at mark, ignoring their profit targets.
- None of this removes the wick/gap risk, which is why the sim keeps high-leverage position caps small relative to the pool.

## 5. Bot traders (simulated)
Optional (LP tab). A fake account with a fake $1M float opens random positions (leverage mostly 5–100x, some 500–10000x; median notional $600; hold 15–240 s; an occasional "whale" at 200–1000x). Every bot action is labelled `BOT` in the activity log, and bot positions count toward OI, caps, stress and ADL like any other position. The float is replenished from freshly minted simulated money (tracked in the conservation ledger). This flow is **random**, so it is *not* a prediction of real flow, and APR / PnL shown while bots run are demo values.

## 6. Limitations
- One shared pool in one browser; "other LPs" are just the house seed. No real LP behaviour, no pool-level liquidations of LPs.
- Liquidation/ADL/haircut are evaluated on the ~1 s feed ticks while the tab is open; the pool is frozen when it is closed (bots too).
- Liquidation forfeits the full margin (no maintenance residual returned, no insurance fund). Funding goes straight to the pool.
- The haircut factor uses unrealised winners at the time of a close; it is a simple pro-rata rule, not a full waterfall.
- Fees, caps, tiers and thresholds are illustrative defaults.
