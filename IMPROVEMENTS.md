# PAPER10K vs papertrade.xyz — improvement research (2026-10-21, research only, no code changes)

Rule used: every number is quoted from a source (URL or repo file); anything not found is marked **unknown**.
Repo notes: `ANALYSIS.md` (A), `DOCS_ANALYSIS.md` (DA), `HOUSE.md` (H), `AUDIT.md`.

## 1. What Papertrade does today
| Area | Papertrade | Source |
|---|---|---|
| Product | Synthetic perps on HyperEVM (chain 999), BTC + ETH, up to 1000x, one-click buy/sell, no order book, fills at Hyperliquid BBO mid, no spread/slippage/funding | https://docs.papertrade.xyz/ , https://papertrade-sdk.pages.dev/docs/protocol |
| Limits | min margin $10, min notional $10,000, max notional per position $10M, max leverage 1000x | papertrade-sdk protocol page; DA §1 |
| Fees | no notional fee; winners pay an impact haircut on the gain, then a 2% win fee; losers pay exactly the loss | papertrade-sdk protocol page; DA §5 |
| LP | starts at $0, grows only from trader losses ("Martingaler"); no direct LP deposits; insolvent → FIFO debt queue paid from later losses | https://docs.papertrade.xyz/ ; DA §4 |
| Token PAPER | fair launch, no pre-mint/team/VC/airdrop; minted only from realised losses/liquidations: 100 PAPER per $1 of loss basis while tracked LP < $2M, then decays; non-transferable at launch, stake/unstake only | https://docs.papertrade.xyz/ ; DA §9 |
| Staking | staked PAPER earns USDC: 1% of realised PnL of settled trades (while queue empty) + all LP gain above a staker cap ($5M per docs; airdrops.io reports a scheduled raise to $10M on 2026-10-17 — third-party, unverified); no lockup, boosts or tiers | https://docs.papertrade.xyz/ , https://papertrade.network/docs/paper/staking/ , https://airdrops.io/papertrade/ |
| Fee flow | win fee / LP-side fee split between PAPER stakers and a dev-fee recipient | DA §5 |
| Referrals / points | none; "builder codes" (revenue share for third-party frontends, whitelist) planned | https://airdrops.io/papertrade/ (third-party); DA §C |
| Leaderboard | yes, via API `/state/leaderboard/accounts` and `/state/leaderboard/positions` (24h / all) | papertrade-sdk protocol page |
| UX | EIP-712 intents batched by a relayer (gasless for users), session keys, per-user CREATE2 deposit addresses, multi-chain deposits | papertrade-sdk protocol page; DA §2 |
| Risk controls | per-side OI caps run by a market keeper, guardian `pauseMarket` (permanent) and `setTradingPaused`; no oracle deviation/TWAP breaker | DA §C |
| Governance | upgradeable proxies owned by a Timelock (7 days per docs, not verified on-chain) owned by a 2-of-3 multisig | DA §B |
| X handle | **unknown**: searches did not confirm an @papertradexyz account | — |
| PAPER market price | **unknown**: non-transferable, so no market found | — |

PAPER10K today (this repo): 10000x, house pool + insurance fund, FIFO queue, 100x profit cap, 2% win fee, deadband, PAPER10KX minted only on liquidation (non-transferable, hard-capped, **no value / no revenue rights** by design, DA §9 legal note), 2-block mark→liquidate rule, keeper bounty, launch limits (commit 62aeb0a), Base target. Exchange runtime 22,734 B → **~1.8 kB headroom**.

## 2. Comparable venues and token designs
| Venue | Mechanic worth copying | Source |
|---|---|---|
| gTrade (Gains) | fee split: 76% DAO, 15% vault LPs, 5% referrals, 4% trigger keepers (the GNS buyback-and-burn share currently goes to the DAO); Degen pairs at a fixed 500x with 0.02% open/close; 1000x on FX majors; staking GNS gives 5–50% fee discount; "Gains Credits" volume tiers give 2.5–25% | https://docs.gains.trade/gtrade-leveraged-trading/fees-and-spread , https://docs.gains.trade/loyalty-programs/gtrade-credits , https://docs.gains.trade/gtrade-leveraged-trading/pair-list |
| GMX | 27% of fees buy back GMX on the open market for stakers (currently accumulating in Treasury until GMX reaches $90); staking gives governance votes | https://docs.gmx.io/docs/tokenomics/rewards/ |
| Jupiter Perps / JLP | 75% of perps fees reinvested into JLP (price appreciation, no staking), 25% to Jupiter; mint/burn fee 0.20% base + weight-based adjustment; AUM cap | https://docs.jup.ag/user-docs/earn/jlp/earn |
| Hyperliquid HLP | community vault: market making, liquidations, platform fees; HLP page showed $179,035,592 TVL, 3% past-month return when fetched | https://app.hyperliquid.xyz/vaults/0xdfc24b077bc1425ad1dea75bcb6f8158e10df303 |
| Ostium / OLP | 30% of opening fees to OLP at daily settlement; OLP freely transferable ERC-20, not staked | https://docs.ostium.com/vault/reference/olp-token |
| Avantis → Veranta (Base) | "Upside perps": no open/close fee, pay only a profit share (keep 75–95% by ROI); staking AVNT saves 25% of profit share; loss-protection rebate up to 20% for skew-balancing trades; gasless intents + EIP-7702 smart wallet; AVNT buyback-and-burn from 30% of fees; Security Module staking with slashing up to 20% | https://docs.avantisfi.com/support/faqs , https://docs.veranta.xyz/trading/upside-perps/profit-sharing , https://avantisfi.medium.com/dex-arbitrage-series-part-1-avantis-hyperliquid-ed4134a2da2b , https://blockworks.com/token-transparency/filing/veranta |
| Vertex | **not researched / status unknown** in this pass | — |
| Base platform | Coinbase Smart Wallet Spend Permissions (spender moves tokens within token/amount/time limits, no further signatures) | https://docs.base.org/identity/smart-wallet/guides/spend-permissions/ |

## 3. Ranked additions
Size: "0" = no exchange change; "ext" = separate contract that reads events/state; "+X" = change inside the exchange (headroom ~1.8 kB).
Legal: **H** = likely securities/derivatives/gambling issue, needs counsel before launch; **M** = consumer-protection/marketing rules; **L** = low.

| # | Addition | What / why | Effort | Size | Risk | Legal |
|---|---|---|---|---|---|---|
| 1 | Coinbase Smart Wallet + batched calls + paymaster (gasless) | one-tap deposit+open, removes the ETH-for-gas step; Veranta already gasless | M | 0 | paymaster spend abuse → cap per user | L |
| 2 | Share cards ("rekt" / win cards) + Farcaster mini app | viral loop for a game-like product; Papertrade has none documented | S | 0 | none on-chain | M (no profit promises in copy) |
| 3 | Seasons + leaderboards + competitions (off-chain indexer over events) | Papertrade has a leaderboard API but no seasons/points; drives retention | S–M | 0 | sybil/wash-trading → filter on min hold, unique-wallet rules | M (prize competitions are regulated in some places) |
| 4 | Stop-loss / take-profit via operator approval | users set a trigger, a trigger keeper closes for them; at 10000x the bust distance is 0.009%, so TP matters more than SL | M | +small (`setOperator` + `closeFor`, est. <0.5 kB, **unmeasured**) + ext trigger contract | operator griefing, keeper MEV → owner-only close-at-or-better price check | L |
| 5 | "Rekt" soulbound NFT / achievements | badge minted from `Liquidated` events (first rekt, 10 rekts, biggest notional); gives PAPER10KX-style flex with zero financial value | S | ext | none | L |
| 6 | PAPER10KX as season score / leaderboard multiplier | keep it valueless but useful: rank, cosmetic tiers, mini-app badges | S | 0 / ext | none | L |
| 7 | Session keys (Smart Wallet sub-accounts or Spend Permissions) | no popup per trade; Papertrade uses session keys | M | 0 | key leakage → scoped spend + expiry | L |
| 8 | Referrals (off-chain attribution first, then on-chain fee share) | gTrade pays 5% of fees to referrals; growth lever | S off-chain / M on-chain | 0 / +small | farming | M |
| 9 | More markets (SOL, majors with Chainlink feeds on Base) | more reasons to come back | S per market | 0 (`proposeMarket` + oracle config) | thinner feeds, oracle lag | L |
| 10 | Liquidation-insurance rebate in PAPER10KX or points | soften rekts (Avantis-style loss protection); must not be paid in USDC from the pool without modelling | M | ext | pool drain if USDC | M/H if cash |
| 11 | Win-fee discount for PAPER10KX holders | classic fee-discount utility (gTrade, Veranta) | M | +small (balance read in `_pnl`) | Sybil if token is transferable | M |
| 12 | Higher-leverage tiers by staking | **not recommended**: 10000x is already the hard cap, so this only gates lower tiers | M | +small | encourages bigger losses | H (looks like a gambling inducement) |
| 13 | Copy trading | follow a leader's opens via operator rights | L | ext + operator hook | leader front-running, liability | H (may be investment advice / management) |
| 14 | Boosted LP / public house pool deposits | let users LP like JLP/HLP/OLP | L | ext vault + exchange hooks | LP loses to skilled traders; already documented in H | H (pooled investment) |
| 15 | Stake PAPER10KX for a share of house fees / buyback-and-burn from win fees / governance | Papertrade, GMX, Veranta all do some of this | M–L | ext staking + fee hook (+small) | turns the token into an investment asset | **H**: DA §9 legal note already flags USDC revenue share as a likely securities/CIS risk; do only after counsel |

## 4. Top 5 to build first for the Base launch
1. **Coinbase Smart Wallet + paymaster gasless flow** (no exchange change).
2. **Share cards + Farcaster mini app** (no exchange change).
3. **Seasons, leaderboards and competitions** with PAPER10KX as the non-financial season score (no exchange change).
4. **Take-profit / stop-loss through operator approval** (small exchange change: measure size before committing).
5. **Rekt soulbound NFT / achievements** (separate contract).

Deferred until legal review: anything that gives PAPER10KX cash value (fee share, buyback, LP boost, copy trading).
Unknowns: Papertrade's X handle, user counts, PAPER price; Vertex status; exact byte cost of the operator hook.
