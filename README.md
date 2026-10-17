# PAPER10K — simulated perpetuals paper-trading exchange

> **Paper trading. Simulated funds. Not financial advice.** No real money, no wallets, no keys, no trackers. Nothing can be deposited or withdrawn.

Synthetic perps priced from live Hyperliquid mids, with up to **10000x** leverage, a $1,000 fake-USD start balance, isolated margin,
market + limit orders, local leaderboard and shareable PnL card. Inspired by (not copied from) papertrade.xyz — see `ANALYSIS.md`.

## Run
```sh
./serve.sh 8080          # python3 http.server; any static server works (ES modules need http://, not file://)
# open http://localhost:8080
node --test test/        # unit tests for the margin/liquidation math (Node >= 20, no deps)
python3 shots.py         # optional: Playwright + system Chrome screenshots & console-error check
```
No build step, no dependencies.

## Architecture
| file | role |
|---|---|
| `src/engine.js` | Pure sim math & state transitions (open/close/limit/funding/liquidation). No DOM/network. Unit-tested. |
| `src/feed.js` | Price feed. Hyperliquid `allMids` WebSocket + `metaAndAssetCtxs` REST poll (24h open via `prevDayPx`, funding rate); candles via `candleSnapshot`. If HL is silent >8 s, polls Binance futures public REST (`/fapi/v1/ticker/24hr`, klines). If both fail the status becomes **offline**: a red banner shows, trading/closing/liquidation checks/limit fills pause. Prices are never invented. |
| `src/chart.js` | Self-written canvas candlestick chart; live-updates last candle from ticks; draws entry/liq/limit lines. |
| `src/card.js` | Canvas PnL card -> PNG download. |
| `src/app.js` | UI wiring, rendering, localStorage (`paper10k.v1` state, `paper10k.runs.v1` leaderboard). |

Fills are at the live **mid** price with zero market impact/slippage (like the product it is inspired by). Market-closes also fill at mid.

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

## Limitations
- Simulation only; mid-price fills with no spread/impact/OI caps; no partial fills, TP/SL, cross margin, or position resizing.
- Mids update about once per second (WS); at 10000x liquidation is checked on each tick only, so a sub-tick wick between ticks is not seen. Liquidation fills at the observed mark, not the theoretical liq price.
- State is per-browser localStorage (clearing site data erases it); leaderboard is local only.
- Simulation pauses while the tab is closed (funding accrues by wall-clock when reopened; liquidations only evaluated against live ticks).
- `HYPE`/others are not listed; markets are a fixed list in `src/feed.js`.
