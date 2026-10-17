# PAPER10K — simulated perpetuals paper-trading exchange

> **Paper trading. Simulated funds. Not financial advice.** No real money, no wallets, no keys, no trackers. Nothing can be deposited or withdrawn.

Synthetic perps priced from live Hyperliquid mids, with up to **10000x** leverage, a $1,000 fake-USD start balance, isolated margin,
market + limit orders, local leaderboard and shareable PnL card. Inspired by (not copied from) papertrade.xyz — see `ANALYSIS.md`.

**New: simulated house + LP pool.** Every trade is against a simulated **house pool** (seed $1,000,000 fake) at the Hyperliquid mid, zero impact. Trader losses, fees and funding go to the pool; wins are paid from it. An **LP / House** tab lets you deposit/withdraw simulated funds, shows share price, TVL, utilization, cumulative PnL, a fee-APR estimate and a pool-history chart. Risk controls (OI caps, net-exposure cap, position cap by leverage tier, payout haircut option, auto-deleverage, stress banner) keep 10000x from draining the pool, and optional **simulated bot traders** (clearly labelled) give the pool live activity. Read **[HOUSE.md](HOUSE.md)** for the economics and why 10000x is dangerous for traders and for the pool.

## Run
```sh
./serve.sh 8080          # python3 http.server; any static server works (ES modules need http://, not file://)
# open http://localhost:8080
node --test test/        # unit tests: margin/liquidation math (engine) + pool accounting, share math, caps, haircut, ADL, bots (Node >= 20, no deps)
python3 shots.py         # optional: Playwright + system Chrome screenshots & console-error check
```
No build step, no dependencies.

## Architecture
| file | role |
|---|---|
| `src/engine.js` | Pure sim math & state transitions (open/close/limit/funding/liquidation). No DOM/network. Unit-tested. |
| `src/feed.js` | Price feed. Hyperliquid `allMids` WebSocket + `metaAndAssetCtxs` REST poll (24h open via `prevDayPx`, funding rate); candles via `candleSnapshot`. If HL is silent >8 s, polls Binance futures public REST (`/fapi/v1/ticker/24hr`, klines). If both fail the status becomes **offline**: a red banner shows, trading/closing/liquidation checks/limit fills pause. Prices are never invented. |
| `src/pool.js` | Pure house/LP accounting: assets vs trader collateral, NAV/share price, deposit/withdraw, caps, stress levels, haircut, ADL plan, fee APR. Unit-tested. |
| `src/venue.js` | Glue: every open/close/liquidation/limit fill settles against the pool; ADL execution; LP actions; reset; stress drill. |
| `src/bots.js` | **Simulated** bot-trader traffic (seeded RNG, fake funds, labelled `BOT`). |
| `src/lpchart.js` | Pool-history line chart. |
| `src/chart.js` | Self-written canvas candlestick chart; live-updates last candle from ticks; draws entry/liq/limit lines. |
| `src/card.js` | Canvas PnL card -> PNG download. |
| `src/app.js` | UI wiring, rendering, localStorage (`paper10k.v1` state, `paper10k.runs.v1` leaderboard). |

Fills are at the live **mid** price with zero market impact/slippage (like the product it is inspired by). Market-closes also fill at mid. The counterparty is the simulated house pool (see below).

## Margin model (isolated)
Let `M` margin, `L` leverage, `N = M·L` notional, `size = N / entry`, `k = 0.10` (maintenance = 10% of initial margin).
- Equity: `eq = M + uPnL − funding`, `uPnL = ±(mark − entry)·size` (+ long, − short).
- **Liquidated when `eq ≤ k·M`.**
- **Liquidation price:**
  - long: `entry − (M·(1−k) − funding) / size`  = `entry·(1 − (1−k)/L)` with no funding
  - short: `entry + (M·(1−k) − funding) / size` = `entry·(1 + (1−k)/L)`
- Adverse move to liquidate = `(1−k)/L`: 90% at 1x, 0.9% at 100x, **0.009% at 10000x** (≈ 0.01%).
- Liquidation forfeits all margin; loss never exceeds margin (isolated) and no extra closing fee. Normal close returns `max(0, M + uPnL − funding)`.
- Accrued funding moves the liquidation price toward entry (longs paying funding liquidate sooner).

## Fees & funding (simulated, documented)
- **Taker fee: 3.5 bps (0.035%) of notional**, charged from free balance on open and on close (not from margin; never charged on liquidation).
  Note at extreme leverage the fee on notional can exceed the margin itself (at 10000x a $2 margin pays $7) — that is intentional realism.
- **Funding:** continuous accrual `size·mark·rate·Δt(h)`; `rate` is Hyperliquid's live hourly funding for the coin (fallback 0.00125%/h when on Binance fallback). Longs pay when rate > 0, shorts receive.
- Limit orders reserve margin + open fee from balance; fill when the mark crosses the limit (buy ≤, sell ≥) at the limit price; cancel refunds.
- Min margin $1, leverage 1–10000x.

## House pool & risk controls (summary; details in HOUSE.md)
- Funds: `assets` (LP-owned) and `collateral` (trader margin) are kept separate. Invariant `assets + collateral + Σ trader funds == minted funds` is unit-tested, including a 4000-step randomised soak.
- Share price = `NAV / shares`, `NAV = assets − trader unrealised PnL` (loss floored at margin). Deposits/withdrawals don't move it. Withdrawals are limited by reserve for open exposure.
- Caps (functions of pool NAV; defaults in `POOL_CFG`): per-market per-side OI ≤ 30%; net exposure ≤ 25%; position ≤ 5% × leverage tier (≤100x ×1, ≤1000x ×½, 10000x ×⅕ → **$10k notional max at the $1M seed**). Stress halves the caps, critical blocks net-increasing opens.
- Payout haircut (toggle): when stressed, winning profit is scaled by `min(1, assets / open winners)`. Payouts are always capped by pool assets.
- Auto-deleverage when a hard cap is exceeded by >10% (e.g. the pool shrank): most profitable×leverage positions on the heavy side are closed at mark, fee-free. A banner shows watch / stress / critical.
- Bot traders: LP tab toggle + rate. Simulated, random, not real users.
- **Stress drill** button: a simulated whale win drains 20% of the pool (funds go to the bot account, conserved) to demo the banner/haircut/ADL.

## Limitations
- The pool is one shared simulated pool; "other LPs" are just the house seed. LP APR with bots is a noisy demo number, not a forecast.
- Wicks: liquidation only sees ~1 s ticks, so a wick that reverts between ticks is a free option for the trader (documented in HOUSE.md; mitigated only by the small position cap at high leverage).
- Pool, bots and ADL only run while a tab is open; state is local (localStorage `paper10k.pool.v1`). Old saves migrate (open margin becomes collateral).
- Reset closes your positions through the pool and keeps your LP shares.
- Simulation only; mid-price fills with no spread/impact; no partial fills, TP/SL, cross margin, or position resizing.
- Mids update about once per second (WS); at 10000x liquidation is checked on each tick only, so a sub-tick wick between ticks is not seen. Liquidation fills at the observed mark, not the theoretical liq price.
- State is per-browser localStorage (clearing site data erases it); leaderboard is local only.
- Simulation pauses while the tab is closed (funding accrues by wall-clock when reopened; liquidations only evaluated against live ticks).
- `HYPE`/others are not listed; markets are a fixed list in `src/feed.js`.


---
## ⛓ On-chain TESTNET mode (new, branch `wallet-testnet`)
The simulator is unchanged. A second mode, **On-chain (testnet)**, adds wallet connect (EIP-1193 injected + vendored WalletConnect, no trackers), a network check,
and Solidity contracts (`contracts/`): house pool + isolated-margin perps up to 10000x, signed-price oracle, and **PAPER10KX** (no-value points token minted to a trader on liquidation).
- **Testnet only. No real funds.** Mainnet support exists in code but is **OFF** (`MAINNET_ENABLED=false`) and has never been deployed — see `MAINNET_LAUNCH.md`.
- `DOCS_ANALYSIS.md` (papertrade.xyz teardown) · `TESTNET.md` (deploy/run) · `AUDIT.md` (**AI self-audit, not independent**) · `MAINNET_LAUNCH.md` (audit/legal/oracle/insolvency checklist + deploy commands).
- Tests: `cd contracts && forge test` (unit/fuzz/invariant) · `node --test test/` · local e2e: `tools/e2e-local.sh && python3 tools/e2e-shots.py`.
- Honest risk copy: nearly all 10000x positions are liquidated within seconds.

**UI (10kx redesign):** landing with live ticker + original ASCII-density canvas, nav (Trade/Positions/House/Leaderboard/On-chain), markets strip, chart, ticket; mobile-first below 640px. Code: `index.html`, `style.css`, `src/ui10k.js`. Screenshots: `docs/shots/ui-*.png`. Layout inspired by public structure of synthetic-perp exchanges; all code/art original.
