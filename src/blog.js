// /#blog: product page + backtest write-up. Every number below comes from /workspace/p10k-backtest/BACKTEST.md.
import { poolTable, DEMO } from './chain/rules.js';
const ch = (k, face = 'idle') => (window.charFig ? window.charFig(k).replace('data-face="idle"', `data-face="${face}"`) : '');
const T = (head, rows) => `<div class="tw"><table class="btbl"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
const ev = (v) => `<span class="${v < 0 ? 'up' : 'dn'}">${v > 0 ? '+' : ''}${v.toFixed(3)}</span>`;
export function blogHtml() {
  const EV = { // per-trade trader EV per $1 margin, uniform 1–11 s fill delay (BACKTEST.md §1). Negative = house wins.
    measured: { 2: [-0.483, -0.243, -0.473, -0.642], 3: [-0.413, -0.161, -0.416, -0.577], 5: [-0.28, 0.065, -0.346, -0.477], 10: [-0.093, 0.439, -0.287, -0.309] },
    wide: { 2: [-0.456, -0.163, -0.544, -0.799], 3: [-0.319, 0.061, -0.385, -0.719], 5: [-0.095, 0.438, -0.102, -0.56], 10: [0.262, 1.033, 0.248, -0.151] },
    stress: { 2: [-0.49, -0.239, -0.574, -0.828], 3: [-0.327, 0.006, -0.392, -0.751], 5: [-0.006, 0.489, -0.021, -0.56], 10: [0.752, 1.645, 0.729, 0.1] },
  };
  const evRows = []; for (const sc of ['measured', 'wide', 'stress']) for (const M of [2, 3, 5, 10]) evRows.push([`${sc}`, `${M}×${M === 2 ? ' <span class="stk g">chosen</span>' : ''}`, ...EV[sc][M].map(ev)]);
  return `<article class="blog">
  <header class="bhero">
    <div><span class="stk pk">field notes</span><h1>PAPER10K: 10000x, immutable, and backtested until it stopped breaking</h1>
    <p class="lede">A synthetic perp where nearly every trade gets liquidated in seconds and that is the product. Here is what it is, how we tested it on real 1-second market data, and why every rule is exactly what it is.</p>
    <p class="meta">Base · Pyth + Chainlink · no owner after launch · numbers from the public backtest (BACKTEST.md)</p></div>
    <div class="bcrew">${ch('girl', 'happy')}${ch('punk', 'cope')}${ch('peng', 'dead')}</div>
  </header>
  <nav class="btoc"><a href="#b-what">What it is</a><a href="#b-data">Data</a><a href="#b-mech">Mechanics</a><a href="#b-traders">Traders</a><a href="#b-ev">Results</a><a href="#b-pool">Pool sim</a><a href="#b-rules">Why each rule</a><a href="#b-limits">Limits</a><a href="#b-vibe">The vibe</a></nav>

  <section id="b-what"><h2>What PAPER10K is</h2>
  <p>Pick BTC, ETH or SOL, pick up to <b>10000x</b>, put down a few cents of USDC. Liquidation sits 0.9 bps away (10% maintenance on a 10000x position), so most positions die within seconds: in the backtest the average time to liquidation was <b>≈ 20 s</b>. When you get liquidated you are minted <b>PAPER10KX</b>, a plain ERC-20 you can stake for a share of house income in USDC.</p>
  <p>You trade against a shared house pool. After launch the contracts are <b>finalized</b>: every setter is disabled, both owners are renounced, there is no proxy and no owner withdrawal path. The rules on this page cannot change, which is exactly why they had to be right before launch.</p></section>

  <section id="b-data"><h2>Data: real prices, nothing synthetic</h2>
  <ul><li><b>Binance spot 1-second klines</b> for BTCUSDT and ETHUSDT from data.binance.vision, 40 day-files: crash days (2024-08-05, 2025-04-07, 2025-10-10, 2025-10-11), calm days (2025-06-15, 2025-08-17) and 14 recent days (2026-10-07 … 10-20).</li>
  <li><b>Pyth via Hermes</b>: 1 Hz samples, 600 s calm (2026-10-20) and the most volatile 10 minutes of 2026-10-14.</li>
  <li>The simulated year resamples those days with replacement, which gives 6 crash days out of 20: far more violent than a real year, so the test is deliberately conservative.</li></ul>
  <h3>Pyth vs Binance</h3>
  ${T(['window', 'symbol', 'best lag', 'mean (bps)', 'sd (bps)', 'max |Δ| (bps)', 'return corr'], [['calm 2026-10-20', 'BTC', '1 s', '−13.18', '0.40', '1.14', '0.69'], ['calm 2026-10-20', 'ETH', '1 s', '−12.88', '0.39', '1.35', '0.65'], ['volatile 2026-10-14', 'BTC', '1 s', '−8.90', '1.48', '20.0', '0.90'], ['volatile 2026-10-14', 'ETH', '1 s', '−8.76', '1.69', '19.43', '0.89']])}
  <p>Pyth tracks the Binance close about one kline later (lag under ~1 s). The −9 to −13 bps level offset is the static USD/USDT basis and cannot be traded; the tradable residual is ~0.4 bps calm and ~1.6 bps volatile, 20 bps worst case. That became the three oracle scenarios: <b>measured</b> (1 s lag, 1 bps noise), <b>wide</b> (3 s, 10 bps) and <b>stress</b> (5 s, 40 bps, the testnet-like figure).</p></section>

  <section id="b-mech"><h2>Mechanics, as the contract runs them</h2>
  <ul><li><b>Two-step orders.</b> You request an open or close; a permissionless keeper fills it at the first Pyth price published <i>after</i> your request. Nobody can pick a stale price. The backtest draws the fill delay uniformly from 1–11 s and also runs the worst case of 1 s.</li>
  <li><b>Liquidation</b> at entry·(1 ∓ 0.9/10000). A keeper marks the position, then liquidates at least 2 blocks (~4 s) later if it is still underwater on <b>both</b> Pyth and Chainlink. Marks expire after 120 s. A liquidation can land while a close is pending.</li>
  <li><b>Wins</b> = notional·(move − 1 bp deadband)·(1 − 20%) / (1 + 1/((move − db)·1000)), capped at <b>2× margin</b>, minus a 2% win fee. Losses are linear and capped at the margin. No trading fees, no funding.</li>
  <li>Opens are checked against the 1% payout cap, the per-side liability cap (50%), the per-wallet cap (3× max margin) and the price-jump breaker (50 bps / 60 s).</li></ul></section>

  <section id="b-traders"><h2>Who we threw at it</h2>
  <div class="bcards">
   <div>${ch('cat')}<b>Farmers</b><p>4,000 trades/day, random side, hold 3 s–2 h, take-profit 0.5–5×, median margin $1.</p></div>
   <div>${ch('ape')}<b>Whales</b><p>400 trades/day at up to the max size, take-profit 1–20×.</p></div>
   <div>${ch('punk', 'cope')}<b>Adversarial whales</b><p>400 trades/day, always max size, always aiming for the profit cap.</p></div>
   <div>${ch('girl', 'shock')}<b>Latency arbitrageur</b><p>Sees Binance before the oracle and trades every gap above the deadband (best threshold chosen), also as 5 and 20 Sybil wallets.</p></div></div>
  <p class="fine">A low-activity variant runs 10% of this flow. Trade flow is synthetic; prices are real.</p></section>

  <section id="b-ev"><h2>Result 1: the profit cap decides everything</h2>
  <p>Expected value per trade for the trader, per $1 of margin, with two-step orders and the uniform 1–11 s fill delay (<span class="up">green</span> = trader loses = house safe):</p>
  ${T(['oracle', 'max win', 'adv. whale', 'arb', 'farmer', 'whale'], evRows)}
  <p><b>Without</b> two-step orders, any oracle lag of 1 s or more made latency arbitrage strongly profitable for every parameter set. <b>With</b> them, <b>2× is the only cap where every strategy loses in all three oracle scenarios and both delay models.</b> From 3× up, the arb and the adversarial whale turn positive once the oracle is wide or stressed.</p></section>

  <section id="b-pool"><h2>Result 2: 180-day pool simulations</h2>
  <figure><img src="assets/blog/pool_equity_seed10.png" alt="Pool equity over 180 days from a $10 seed: M=2 grows steadily in every scenario, M=3/5/10 crash or flatline in some" loading="lazy"><figcaption>$10 seed. Left: 2× cap, every scenario. Right: 3×/5×/10×, where several paths are drained to dust and freeze.</figcaption></figure>
  <figure><img src="assets/blog/pool_equity_seed100.png" alt="Pool equity over 180 days from a $100 seed" loading="lazy"><figcaption>$100 seed, same story.</figcaption></figure>
  <figure class="half"><img src="assets/blog/pool_equity_sybil_lowact.png" alt="Pool equity with 20 Sybil arbitrage wallets and with low activity" loading="lazy"><figcaption>20 Sybil arb wallets under stress, and the low-activity run.</figcaption></figure>
  <ul><li><b>2× cap: 0% ruin and 0 bad debt</b> across every scenario, delay model, seed, payout cap and sensitivity variant. Worst drawdown 8–18% with the 1% cap. With 20 Sybil arb wallets under stress the pool dipped to 47% of its seed in 1 of 2 runs, then recovered.</li>
  <li><b>5× and 10×</b> drained the pool to dust under the wide and stress oracles. <b>3×</b> produced queued wins (bad debt) under the wide oracle.</li>
  <li>Trader win rates at 2×: farmers 20%, whales 11%, adversarial whale 18.5%, arb 33%. About 5% of opens were blocked, almost all by the breaker.</li>
  <li>Median days to milestones from $10: $1k in 0.3, $10k in 0.6, $100k in 0.9. <i>Caveat:</i> those absolute numbers come from an assumed constant flow of losing max-size bots. Read them as "never ruined, positive drift", not a revenue forecast.</li></ul></section>

  <section id="b-rules"><h2>Why each rule is what it is</h2>
  <div class="bwhy">
   <div><h3>2× max win</h3><p>The ~4 s liquidation confirmation is a free option: if price runs your way you keep it, if it runs against you there is a short window before liquidation. At 3× and above, arb bots and whales monetise that option and drain the pool. Since nothing can be changed after finalize, a drained pool is dead forever. 2× was the only safe multiple.</p></div>
   <div><h3>1% payout cap</h3><p>One win can pay at most 1% of pool + insurance. Caps of 0.5% / 1% / 2% gave max drawdowns of ≈5% / 8–11% / 16–18%. 1% balances growth and safety. With a 2× cap this makes max margin = min($1000, 0.5% of the pool).</p></div>
   <div><h3>$20 seed → $0.10 max margin</h3><p>0.5% of $20 is $0.10, i.e. $1,000 of notional at 10000x. Both $10 and $100 seeds were simulated and neither was ruined. Margin grows linearly with the pool (step tiers grew ~15× slower for no safety gain) and the $1000 hard cap binds from a $200k pool, limiting whale tail risk forever.</p></div>
   <div><h3>No funding</h3><p>The contract has no funding rate and no trading fee. Positions live ~20 s on average, so funding would be rounding noise; risk is handled by the 30 s minimum hold (better than 3 s or 10 s in the grid), two-oracle liquidation and the 2× cap. The house earns from the 1 bp deadband, the 20% win haircut and the 2% win fee.</p></div>
   <div><h3>Breaker 50 bps / 60 s</h3><p>New opens pause while price is more than 0.5% from its 60 s reference. A 20 bps breaker blocked 17% of flow for no solvency gain; 50 bps blocks ≈5%. Closes and liquidations are never blocked.</p></div>
   <div><h3>Staking &amp; emissions</h3><p>Stakers get 5% of trader losses and 50% of the win fee, in USDC, from real flow only. That costs ~10–25% on time to each pool milestone (1000 bps cost 30–60%); neither caused ruin. PAPER10KX mints 100 per $1 liquidated, halving per doubling of the pool above $1000, so essentially all emission happens while the pool is under ~$10k and everyone is capped at ≤ $50 margin.</p></div>
  </div>
  ${poolTable(DEMO)}</section>

  <section id="b-limits"><h2>Limits of the backtest</h2>
  <ul><li>The Pyth comparison covers 2 × 10 minutes only. Base inclusion/reorg effects and keeper outages are not modelled; keepers are assumed to liquidate as early as allowed.</li>
  <li>Trade flow is synthetic; price paths are real. 11 of 15 planned pool chunks finished (every scenario has at least one seed at 2×).</li>
  <li>Size-maxing bots collect 82–89% of PAPER10KX in this flow mix. There is no per-wallet token cap, and one would not stop a Sybil anyway.</li>
  <li>Staker yield scales with volume; an APR in % cannot be computed without a PAPER10KX price, so the app shows real trailing USDC per 1,000 staked instead.</li></ul></section>

  <section id="b-vibe" class="bvibe"><h2>Why it looks like this</h2>
  <p>The terminal is clean and quiet because you need to read a liquidation price in under a second. The characters are there because 10000x is a joke you are in on: <i>mi_lady</i> watches your sizing, <i>chonk_peng</i> dies with you, <i>pxl_guy</i> copes. Memes on open, win and rekt; no confetti on the numbers that matter. Paper-thin margins, paper-white UI.</p>
  <div class="bcrew">${['girl', 'punk', 'cat', 'peng', 'ape'].map((k) => ch(k)).join('')}</div>
  <p><a href="#trade" data-blog-go="trade" class="brk">[ TRY THE SIMULATOR ]</a> <a href="#rules" data-blog-go="rules" class="brk">[ READ THE RULES ]</a> <a href="https://github.com/StaRKCrypto/paper10k" target="_blank" rel="noopener" class="brk">[ SOURCE ]</a></p></section>
</article>`;
}
