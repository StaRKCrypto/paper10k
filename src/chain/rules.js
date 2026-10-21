// Rules / FAQ: every live rule read from the contracts, with on-chain proof of immutability.
// In demo mode (no deployment) it shows the documented launch PLACEHOLDERS (contracts/script/final_params.example.json).
import { enc, words, toBig, toAddr } from './abi.js';
const S = {
  currentParams: '0xa50bd4ca', ops: '0xe70abe92', limits: '0x860aefcf', finalized: '0xb3f05b97', finalizedBlock: '0x4084c3ab', finalizedAt: '0x365d57a4',
  owner: '0x8da5cb5b', guardian: '0x452a9320', haltsUsed: '0x6a05e3f9', opensHaltedUntil: '0x29229ab4', staking: '0x4cf088d9',
  stakerLossBps: '0x7d907a26', stakerFeeBps: '0x05bf3b52', stakerCap: '0x95062bae', maxMarginNow: '0x61fff068', mintRateNow: '0xdb619b24',
  oracle: '0x7dc0d1d0', minterLocked: '0xcc54cce3', minter: '0x07546172', cooldown: '0x787a08a6', bootstrapped: '0x35142c8c', pool: '0x16f0115b', insurance: '0x89cf3204',
};
export const DEMO = { // = /workspace/p10k-backtest/final_params.json (owner-approved launch numbers), shown until a deployment exists
  demo: true, maxLeverage: 10000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 2, rateMultiplier: 1000, mintPerCollateral: 100, deadbandWad: 1e14, baseRateWad: 2e17,
  minMargin: 1000n, maxMarginPerPosition: 1000000000n, maxPriceAge: 30, minHold: 30, bountyBps: 200, bountyCap: 10000000n, maxTotalDeposits: 1000000000000000n,
  maxLiabPoolBps: 5000, maxJumpBps: 50, jumpWindow: 60, maxPayoutPoolBps: 100, walletMaxMult: 3, mintDecayPool: 1000000000n, minNotional: 0n, maxNotional: 0n, maxWalletMargin: 0n,
  stakerLossBps: 500, stakerFeeBps: 5000, stakerCap: 0n, cooldown: 0, finalized: false, pool: 20000000n, insurance: 0n, maxMarginNow: 100000n, mintRateNow: 100,
};
export async function loadRules(call, d) {
  const r = (to, sel, ...a) => call(to, enc(sel, ...a));
  const n = async (to, sel, ...a) => { try { return toBig((await r(to, sel, ...a)).slice(2, 66)); } catch { return null; } };
  const ad = async (to, sel) => { try { return toAddr(words(await r(to, sel))[0]); } catch { return null; } };
  const cp = words(await r(d.exchange, S.currentParams)).map(toBig), op = words(await r(d.exchange, S.ops)).map(toBig), li = words(await r(d.exchange, S.limits)).map(toBig);
  const R = {
    demo: false, maxLeverage: Number(cp[0]), maintBps: Number(cp[1]), winFeeBps: Number(cp[2]), insuranceBps: Number(cp[3]), maxProfitMult: Number(cp[4]),
    rateMultiplier: Number(cp[5]), mintPerCollateral: Number(cp[6]), deadbandWad: Number(cp[7]), baseRateWad: Number(cp[8]), minMargin: cp[9], maxMarginPerPosition: cp[10],
    maxTotalDeposits: op[0], maxPriceAge: Number(op[1]), minHold: Number(op[2]), bountyBps: Number(op[3]), bountyCap: op[4],
    minNotional: li[0], maxNotional: li[1], maxWalletMargin: li[2], maxLiabPoolBps: Number(li[3]), maxJumpBps: Number(li[4]), jumpWindow: Number(li[5]), maxPayoutPoolBps: Number(li[6]), walletMaxMult: Number(li[7]), mintDecayPool: li[8],
  };
  Object.assign(R, {
    finalized: (await n(d.exchange, S.finalized)) === 1n, finalizedBlock: await n(d.exchange, S.finalizedBlock), finalizedAt: await n(d.exchange, S.finalizedAt),
    owner: await ad(d.exchange, S.owner), guardian: await ad(d.exchange, S.guardian), haltsUsed: await n(d.exchange, S.haltsUsed), haltedUntil: await n(d.exchange, S.opensHaltedUntil),
    staking: await ad(d.exchange, S.staking), stakerLossBps: Number(await n(d.exchange, S.stakerLossBps) ?? 0), stakerFeeBps: Number(await n(d.exchange, S.stakerFeeBps) ?? 0), stakerCap: await n(d.exchange, S.stakerCap),
    maxMarginNow: await n(d.exchange, S.maxMarginNow), mintRateNow: await n(d.exchange, S.mintRateNow, R.mintPerCollateral), oracle: await ad(d.exchange, S.oracle),
    pool: await n(d.exchange, S.pool), insurance: await n(d.exchange, S.insurance),
  });
  if (d.px) Object.assign(R, { pxOwner: await ad(d.px, S.owner), minterLocked: (await n(d.px, S.minterLocked)) === 1n, minter: await ad(d.px, S.minter) });
  if (R.oracle) Object.assign(R, { oracleOwner: await ad(R.oracle, S.owner), oracleFinal: (await n(R.oracle, S.bootstrapped)) === 1n });
  if (R.staking && !/^0x0+$/.test(R.staking)) R.cooldown = Number(await n(R.staking, S.cooldown) ?? 0);
  return R;
}
const Z = (a) => !a || /^0x0{40}$/i.test(a);
export function rulesHtml(R, { fmt, explorer, sym = 'USDC' }) {
  R = R ?? DEMO;
  const f = (v) => fmt(BigInt(v ?? 0)), pct = (bps) => `${(Number(bps) / 100).toLocaleString()}%`, off = (v, s) => (Number(v) === 0 ? '<span class="muted">off</span>' : s);
  const link = (a) => (a && explorer ? `<a href="${explorer}/address/${a}" target="_blank" rel="noopener"><code>${a.slice(0, 8)}…${a.slice(-6)}</code></a>` : `<code>${a ?? '—'}</code>`);
  let h = `<div class="ccard wide"><h3>Rules & FAQ ${R.demo ? '<span class="muted">(launch parameters from the backtest; not deployed yet)</span>' : '<span class="up">(read live from the contracts)</span>'}</h3>`;
  // immutability proof
  if (!R.demo) {
    const ok = R.finalized && Z(R.owner) && (!R.px || Z(R.pxOwner)) && R.minterLocked !== false && (!R.oracle || Z(R.oracleOwner));
    h += `<div class="cbanner ${ok ? '' : 'main'}">${ok ? `✓ IMMUTABLE since block ${R.finalizedBlock}${R.finalizedAt ? ` (${new Date(Number(R.finalizedAt) * 1000).toUTCString()})` : ''}` : '⚠ NOT finalized yet: rules can still change. Do not trade real funds until this shows immutable.'}</div>`;
    h += `<dl class="quote"><dt>exchange.finalized()</dt><dd class="${R.finalized ? 'up' : 'dn'}">${R.finalized}</dd><dt>exchange.owner()</dt><dd>${link(R.owner)} ${Z(R.owner) ? '<b class="up">renounced</b>' : '<b class="dn">set</b>'}</dd>`
      + `<dt>PAPER10KX.owner()</dt><dd>${link(R.pxOwner)} ${Z(R.pxOwner) ? '<b class="up">renounced</b>' : ''}</dd><dt>PAPER10KX minter</dt><dd>${link(R.minter)} ${R.minterLocked ? '<b class="up">locked forever</b>' : '<b class="dn">not locked</b>'}</dd>`
      + `<dt>Oracle</dt><dd>${link(R.oracle)} ${R.oracleFinal ? '<b class="up">config final</b>' : ''} ${Z(R.oracleOwner) ? '<b class="up">owner renounced</b>' : ''}</dd>`
      + `<dt>Guardian</dt><dd>${Z(R.guardian) ? 'none' : link(R.guardian)} · halts used ${R.haltsUsed ?? 0}/3${R.haltedUntil && Number(R.haltedUntil) * 1000 > Date.now() ? ` · <b class="dn">new opens halted until ${new Date(Number(R.haltedUntil) * 1000).toUTCString()}</b>` : ''}</dd></dl>`;
  } else h += `<div class="cbanner">Demo mode. On a live deployment this card shows on-chain proof: finalized == true, owner == 0x0, minter locked.</div>`;
  const rows = [
    ['Max leverage', `${R.maxLeverage}x`], ['Margin per position', `${f(R.minMargin)} – ${f(R.maxMarginPerPosition)} ${sym} (hard bounds)`],
    ['Max margin right now (pool-scaled)', R.maxMarginNow != null ? `<b>${f(R.maxMarginNow)} ${sym}</b> = min(hard cap, (pool+insurance) × ${pct(R.maxPayoutPoolBps)} ÷ ${R.maxProfitMult})` : `(pool+insurance) × ${pct(R.maxPayoutPoolBps)} ÷ profit cap ${R.maxProfitMult}, capped at ${f(R.maxMarginPerPosition)}`],
    ['Max payout of one position', `${R.maxProfitMult}× margin and ≤ ${pct(R.maxPayoutPoolBps)} of pool+insurance (else "pool too small, try later")`],
    ['Per-wallet open margin', `${off(R.walletMaxMult, `${R.walletMaxMult}× current max margin`)}${Number(R.maxWalletMargin) ? ` and ≤ ${f(R.maxWalletMargin)}` : ''}`],
    ['Notional bounds', `${Number(R.minNotional) ? f(R.minNotional) : 'none'} – ${Number(R.maxNotional) ? f(R.maxNotional) : 'none'}`],
    ['Liquidation', `at ${pct(10000 - R.maintBps)} of margin lost; needs Pyth AND Chainlink (and the optional 3rd feed) to agree, marked ≥2 blocks earlier`],
    ['Liquidation bounty', `${pct(R.bountyBps)} of margin, max ${f(R.bountyCap)} ${sym}, from the liquidated margin`],
    ['Win fee', pct(R.winFeeBps)], ['Profit haircut', `${(Number(R.baseRateWad ?? 0) / 1e16).toFixed(0)}% of the raw win (on top of the deadband)`], ['Funding fees', 'none: there is no funding rate on PAPER10K'], ['Insurance share of losses', pct(R.insuranceBps)], ['Deadband (no-profit zone)', `${(Number(R.deadbandWad) / 1e14).toFixed(2)} bps`],
    ['Oracle-jump breaker', off(R.maxJumpBps, `opens blocked while price is > ${pct(R.maxJumpBps)} from the ${R.jumpWindow}s reference`)],
    ['Side utilisation cap', off(R.maxLiabPoolBps, `worst-case payout per side ≤ ${pct(R.maxLiabPoolBps)} of free house capital`)],
    ['Min hold', `${R.minHold}s`], ['Deposit cap (TVL)', `${f(R.maxTotalDeposits)} ${sym}`],
    ['PAPER10KX on liquidation', `${R.mintRateNow != null ? R.mintRateNow : R.mintPerCollateral} per 1 ${sym} margin now (base ${R.mintPerCollateral}; halves per doubling of the pool above ${f(R.mintDecayPool)})`],
    ['Stakers earn', `${pct(R.stakerLossBps)} of every trader loss + ${pct(R.stakerFeeBps)} of win fees${Number(R.stakerCap) ? ` + pool above ${f(R.stakerCap)}` : ''}; unstake cooldown ${R.cooldown ?? 0}s`],
  ];
  h += `<table class="tbl rulestbl">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  h += poolTable(R);
  const faq = [
    ['Can anyone change these rules?', 'No. Every setter only works before finalize(); finalize is one-way and the owner key is then renounced (owner == 0x0 above). There is no timelock because there is nothing left to schedule, and no proxy: the code can never be upgraded.'],
    ['Can the team withdraw the pool or my funds?', 'No. There is no owner withdrawal function at all. The pool only pays winners, queued wins and stakers. Your free balance is withdrawable any time.'],
    ['Can trading be paused?', 'Closes, liquidations, deposits, withdrawals, staking and claims can never be paused. The guardian can only halt NEW opens for 72 h, at most 3 times ever.'],
    ['Why is my trade a "request"?', 'To stop stale-price arbitrage, every open and close is filled at the first Pyth price published after your request (~1–3 s). Nobody, not you, not the filler, can pick the price. If it moved past your slippage guard, your margin is refunded. A close request cannot be cancelled.'],
    ['Which prices are used?', 'Fill: Pyth (aggregates Binance, OKX, Bybit and other first-party publishers). Sanity bound and second liquidation vote: Chainlink. Binance, Coinbase, Hyperliquid and Lighter are shown in the app and checked by keepers off-chain only; they never set a price on-chain.'],
    ['What if wins exceed the pool?', 'Unpaid wins join a first-in-first-out queue paid from future pool inflows. That is why a single position can win at most a small % of the pool.'],
    ['What is PAPER10KX?', 'A standard, freely transferable ERC-20 (with permit) minted when you get liquidated. Nobody can freeze it. Stake it to earn a share of house income in USDC.'],
    ['Is there a funding rate?', 'No. The contract has no funding rate or trading fee at all. At 10000x the average position lives about 20 seconds before liquidation (backtest), so funding would be noise; the 30 s minimum hold, the 2x win cap and two-oracle liquidation handle the risk instead. The house earns from the deadband, a 20% haircut on wins and a 2% win fee.'],
    ['Why can I win at most 2x my margin?', 'Liquidations need two blocks (~4 s) of confirmation. At a 3x cap or higher, that delay hands arbitrage bots and size-maxing whales a free option; in the backtest they turned positive and drained the pool. Because the rules can never change after launch, a drained pool would be dead forever. 2x was the only multiple where every trader type lost on average in every oracle scenario.'],
    ['Why is the max margin so small at launch?', 'Max margin = min($1000, 0.5% of pool+insurance), so one win can pay at most 1% of the pool. The pool is seeded with $20, giving $0.10 max margin ($1,000 notional at 10000x). It grows automatically with the pool: $1 at a $200 pool, $5 at $1k, $50 at $10k, capped at $1000 from a $200k pool.'],
    ['At 10000x, how far is liquidation?', '~0.009% adverse move. Most positions are liquidated quickly. Only risk what you can lose.'],
  ];
  h += `<div class="ccard wide"><h3>FAQ</h3>${faq.map(([q, a]) => `<details><summary><b>${q}</b></summary><p>${a}</p></details>`).join('')}</div>`;
  return h;
}

// pool-size table computed from the same rules the contract enforces (maxMarginNow / mintRateNow)
export function poolTable(R) {
  const cap = Number(R.maxMarginPerPosition) / 1e6, bps = R.maxPayoutPoolBps, M = R.maxProfitMult, decay = Number(R.mintDecayPool) / 1e6, base = R.mintPerCollateral;
  const now = R.pool != null ? (Number(R.pool) + Number(R.insurance ?? 0)) / 1e6 : null;
  const pools = [10, 20, 100, 1000, 10000, 100000, 200000, 1000000];
  const mm = (pv) => Math.min(cap, (pv * bps) / 10000 / M);
  const mint = (pv) => (!decay || pv < decay ? base : base / 2 ** (Math.floor(Math.log2(pv / decay)) + 1));
  const usd = (v) => '$' + (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
  let h = `<div class="ccard wide"><h3>Pool size → limits</h3><p class="fine">Max margin = min(${usd(cap)}, ${(bps / 100)}% of pool+insurance ÷ ${M}). A win can pay at most ${M}× margin = ${(bps / 100)}% of the pool. Mint halves per doubling of the pool above ${usd(decay)}.${now != null ? ` Pool now: <b>${usd(now)}</b> → max margin <b>${usd(mm(now))}</b>.` : ''}</p><div class="tblwrap"><table class="tbl pooltbl"><tr><th>Pool + insurance</th><th>Max margin</th><th>Max notional @${R.maxLeverage}x</th><th>Max win</th><th>Wallet cap</th><th>PAPER10KX / $ liq.</th></tr>`;
  for (const pv of pools) { const m = mm(pv); h += `<tr${pv === 20 ? ' class="me"' : ''}><td>${usd(pv)}${pv === 20 ? ' <span class="stk pk">launch seed</span>' : ''}</td><td>${usd(m)}</td><td>${usd(m * R.maxLeverage)}</td><td>${usd(m * M * (1 - R.winFeeBps / 10000))}</td><td>${R.walletMaxMult ? usd(m * R.walletMaxMult) : '—'}</td><td>${+mint(pv).toFixed(4)}</td></tr>`; }
  return h + `</table></div></div>`;
}
