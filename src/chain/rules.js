// Rules / FAQ: every live rule read from the contracts, with on-chain proof of immutability.
// In demo mode (no deployment) it shows the documented launch PLACEHOLDERS (contracts/script/final_params.example.json).
import { enc, words, toBig, toAddr } from './abi.js';
const S = {
  currentParams: '0xa50bd4ca', ops: '0xe70abe92', limits: '0x860aefcf', finalized: '0xb3f05b97', finalizedBlock: '0x4084c3ab', finalizedAt: '0x365d57a4',
  owner: '0x8da5cb5b', guardian: '0x452a9320', haltsUsed: '0x6a05e3f9', opensHaltedUntil: '0x29229ab4', staking: '0x4cf088d9',
  stakerLossBps: '0x7d907a26', stakerFeeBps: '0x05bf3b52', stakerCap: '0x95062bae', maxMarginNow: '0x61fff068', mintRateNow: '0xdb619b24',
  oracle: '0x7dc0d1d0', minterLocked: '0xcc54cce3', minter: '0x07546172', cooldown: '0x787a08a6', bootstrapped: '0x35142c8c', pool: '0x16f0115b', insurance: '0x89cf3204',
};
export const DEMO = {
  demo: true, maxLeverage: 10000, maintBps: 1000, winFeeBps: 200, insuranceBps: 1000, maxProfitMult: 1, mintPerCollateral: 100, deadbandWad: 2e13,
  minMargin: 10000n, maxMarginPerPosition: 1000000000n, maxPriceAge: 30, minHold: 3, bountyBps: 200, bountyCap: 10000000n, maxTotalDeposits: 1000000000000n,
  maxLiabPoolBps: 10000, maxJumpBps: 300, jumpWindow: 60, maxPayoutPoolBps: 100, walletMaxMult: 10, mintDecayPool: 10000000000n, minNotional: 0n, maxNotional: 0n, maxWalletMargin: 0n,
  stakerLossBps: 100, stakerFeeBps: 0, stakerCap: 0n, cooldown: 0, finalized: false,
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
  let h = `<div class="ccard wide"><h3>Rules & FAQ ${R.demo ? '<span class="muted">(demo: documented launch placeholders, not live)</span>' : '<span class="up">(read live from the contracts)</span>'}</h3>`;
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
    ['Win fee', pct(R.winFeeBps)], ['Insurance share of losses', pct(R.insuranceBps)], ['Deadband (no-profit zone)', `${(Number(R.deadbandWad) / 1e14).toFixed(2)} bps`],
    ['Oracle-jump breaker', off(R.maxJumpBps, `opens blocked while price is > ${pct(R.maxJumpBps)} from the ${R.jumpWindow}s reference`)],
    ['Side utilisation cap', off(R.maxLiabPoolBps, `worst-case payout per side ≤ ${pct(R.maxLiabPoolBps)} of free house capital`)],
    ['Min hold', `${R.minHold}s`], ['Deposit cap (TVL)', `${f(R.maxTotalDeposits)} ${sym}`],
    ['PAPER10KX on liquidation', `${R.mintRateNow != null ? R.mintRateNow : R.mintPerCollateral} per 1 ${sym} margin now (base ${R.mintPerCollateral}; halves per doubling of the pool above ${f(R.mintDecayPool)})`],
    ['Stakers earn', `${pct(R.stakerLossBps)} of every trader loss + ${pct(R.stakerFeeBps)} of win fees${Number(R.stakerCap) ? ` + pool above ${f(R.stakerCap)}` : ''}; unstake cooldown ${R.cooldown ?? 0}s`],
  ];
  h += `<table class="tbl">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  const faq = [
    ['Can anyone change these rules?', 'No. Every setter only works before finalize(); finalize is one-way and the owner key is then renounced (owner == 0x0 above). There is no timelock because there is nothing left to schedule, and no proxy: the code can never be upgraded.'],
    ['Can the team withdraw the pool or my funds?', 'No. There is no owner withdrawal function at all. The pool only pays winners, queued wins and stakers. Your free balance is withdrawable any time.'],
    ['Can trading be paused?', 'Closes, liquidations, deposits, withdrawals, staking and claims can never be paused. The guardian can only halt NEW opens for 72 h, at most 3 times ever.'],
    ['Why is my trade a "request"?', 'To stop stale-price arbitrage, every open and close is filled at the first Pyth price published after your request (~1–3 s). Nobody, not you, not the filler, can pick the price. If it moved past your slippage guard, your margin is refunded. A close request cannot be cancelled.'],
    ['Which prices are used?', 'Fill: Pyth (aggregates Binance, OKX, Bybit and other first-party publishers). Sanity bound and second liquidation vote: Chainlink. Binance, Coinbase, Hyperliquid and Lighter are shown in the app and checked by keepers off-chain only; they never set a price on-chain.'],
    ['What if wins exceed the pool?', 'Unpaid wins join a first-in-first-out queue paid from future pool inflows. That is why a single position can win at most a small % of the pool.'],
    ['What is PAPER10KX?', 'A standard, freely transferable ERC-20 (with permit) minted when you get liquidated. Nobody can freeze it. Stake it to earn a share of house income in USDC.'],
    ['At 10000x, how far is liquidation?', '~0.009% adverse move. Most positions are liquidated quickly. Only risk what you can lose.'],
  ];
  h += `<div class="ccard wide"><h3>FAQ</h3>${faq.map(([q, a]) => `<details><summary><b>${q}</b></summary><p>${a}</p></details>`).join('')}</div>`;
  return h;
}
