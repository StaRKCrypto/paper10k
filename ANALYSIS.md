# Analysis of papertrade.xyz (public surface only)

Method: fetched `https://papertrade.xyz/` HTML, its single JS bundle (`/assets/main-*.js`, ~49 KB) and CSS,
`docs.papertrade.xyz` (client-rendered shell, little text), and read third-party public docs found by web search
(Circuit SDK reference, PaperJet docs, three.ws docs, an open-source API client). `exchange.papertrade.xyz` returned
404 to a plain unauthenticated GET, and the trading app is an on-chain, wallet-gated dApp; **no auth was bypassed and
the app UI itself was not inspected.** Details of the trade UI below are therefore inferred from the third-party docs.

## Landing page (papertrade.xyz)
- Static Vite build, one canvas (`#ascii`, an ASCII-art animated background) plus HTML overlay; Inter font from Google Fonts;
  i18n by path (`/`, `/zh/`, `/ko/`); links to "trade" (exchange subdomain) and "docs"; "mobile app coming soon".
- Copy: "1000x leverage · 0 market impact · 100% user owned · fully onchain on hyperliquid". Title: "Synthetic perpetuals on Hyperliquid".
- A ticker strip shows a live BTC "microprice". The only network call in the bundle is a WebSocket to
  `wss://api.hyperliquid.xyz/ws` subscribing `{type:"bbo", coin:"BTC"}`; the code validates timestamps (monotonic), checks bid<=ask,
  and computes a size-weighted microprice `(bid*askSz + ask*bidSz)/(bidSz+askSz)` falling back to the mid. It has a reconnecting socket helper.

## Protocol / exchange (from third-party docs)
- "Synthetic": no order book on the venue and not a Hyperliquid perp. Each trade is a swap against a liquidity pool contract
  on HyperEVM (chain 999) priced at Hyperliquid's best-bid/best-ask **midpoint** (read on-chain). USDC collateral.
- "0 market impact": the fill price is the mid regardless of size, bounded by per-side open-interest caps (no slippage, no spread).
  Winners pay a payout haircut ("impact") plus a win fee; losses are capped at margin.
- Markets: BTC and ETH at launch; up to 1000x; isolated margin; no funding; min margin ~$10, min notional ~$10k; positions are not
  resizable (close and reopen); liquidation ("bust") at `entry*(1-1/L)*(1+buffer)` (long), forfeiting all margin, ~5 bps before zero equity.
- "100% user owned": self-custodied wallet and session keys; PAPER token minted from realised losses, stakeable.

## UX flows inferred
Connect wallet -> deposit USDC -> pick market (BTC/ETH) -> long/short -> margin + leverage -> quote (notional, bust price, payout ladder,
OI headroom checks) -> open -> positions list with entry/bust/mark/est. PnL -> close -> history/cashflows.

## What paper10k mirrors (original code, name, visuals)
- Landing hero with the same three promise stats, adapted: **10000x leverage / 0 market impact (fills at mid) / 100% simulated, you own the state (localStorage)**.
- Hyperliquid public feed (WS + REST), mid-price fills, isolated margin, margin+leverage ticket, live quote of notional / liquidation price /
  distance, liquidation forfeits margin, positions with entry/mark/liq, history, minimal-friction flow with no wallet.
- Deliberate differences: 10000x cap; also limit orders, simulated taker fee and HL-rate-based funding (documented in README); no payout haircut;
  fake USD only; local leaderboard; shareable PnL card; Binance fallback and an explicit "feed offline" banner.
