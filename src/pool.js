// Simulated House / LP pool. Pure accounting + risk math. No DOM, no network. SIMULATED FUNDS ONLY.
// See HOUSE.md. Funds model (all USD, simulated):
//   assets      LP-owned cash in the pool vault (what LPs own, before marking open trader PnL to market)
//   collateral  trader margin held in the vault (owned by traders, NOT LP money, not usable for payouts)
//   conservation: pool.assets + pool.collateral + sum(trader balance + reserved limit orders) == pool.ext
import * as E from './engine.js';

export const POOL_CFG = {
  SEED: 1_000_000,        // house seed liquidity (simulated)
  OI_CAP: 0.30,           // per-market, per-side open interest <= 30% of pool size
  NET_CAP: 0.25,          // total net exposure (sum over markets of |long OI - short OI|) <= 25% of pool size
  POS_CAP: 0.05,          // single position notional <= 5% of pool size ...
  LEV_TIERS: [[100, 1], [1000, 0.5], [10000, 0.2]], // ... times this factor by leverage tier (<=100x:1, <=1000x:.5, else .2)
  ADL_TOL: 0.10,          // ADL triggers when a hard cap is exceeded by >10% (pool shrank / price moved)
  LEVELS: { watch: { util: 0.65, dd: 0.05 }, stress: { util: 0.85, dd: 0.15 }, critical: { util: 1.0, dd: 0.30 } },
  STRESS_CAP_MULT: { ok: 1, watch: 1, stress: 0.5, critical: 0 }, // multiplier on caps for NEW risk-increasing opens
  HISTORY_MAX: 1500,
};

export function newPool(seed = POOL_CFG.SEED) {
  return { v: 1, assets: seed, collateral: 0, shares: { house: seed }, seed, ext: seed, peakSp: 1, haircutOn: true,
    fees: 0, trading: 0, funding: 0, volume: 0, lpNet: seed, stats: { opens: 0, closes: 0, liqs: 0, adl: 0, haircutPaid: 0, shortfall: 0 }, history: [] };
}
export const totalShares = (pool) => Object.values(pool.shares).reduce((a, b) => a + b, 0);

const markOf = (p, marks) => (marks && marks[p.sym] > 0 ? marks[p.sym] : p.mark > 0 ? p.mark : p.entry);
/** Position pnl as seen by the pool: isolated, so a trader's unrealized loss is capped at their margin. */
export function posPnl(p, marks) { return Math.max(-p.margin, E.upnl(p, markOf(p, marks)) - p.funding); }

/** NAV = assets - sum(trader unrealized pnl, loss floored at margin). Traders' unrealized wins are a liability of LPs. */
export function nav(pool, positions, marks) { let u = 0; for (const p of positions) u += posPnl(p, marks); return pool.assets - u; }
export const sharePrice = (pool, positions, marks) => { const t = totalShares(pool); return t > 0 ? Math.max(0, nav(pool, positions, marks)) / t : 1; };

/** Exposure of traders (pool is the opposite side). OI in USD at current mark. */
export function exposure(positions, marks) {
  const per = {};
  for (const p of positions) { const m = markOf(p, marks), n = p.size * m, e = (per[p.sym] ??= { long: 0, short: 0 }); e[p.side] += n; }
  let net = 0, maxSide = 0, gross = 0;
  for (const e of Object.values(per)) { net += Math.abs(e.long - e.short); maxSide = Math.max(maxSide, e.long, e.short); gross += e.long + e.short; }
  return { per, net, maxSide, gross };
}
export function levFactor(lev) { for (const [mx, f] of POOL_CFG.LEV_TIERS) if (lev <= mx) return f; return POOL_CFG.LEV_TIERS.at(-1)[1]; }
export function caps(size, mult = 1) {
  const s = Math.max(0, size) * mult;
  return { oi: s * POOL_CFG.OI_CAP, net: s * POOL_CFG.NET_CAP, pos: s * POOL_CFG.POS_CAP };
}
export const maxPositionNotional = (size, lev, mult = 1) => caps(size, mult).pos * levFactor(lev);

/** Full risk snapshot used by the UI, the open gate, ADL and haircuts. */
export function metrics(pool, positions, marks) {
  const N = nav(pool, positions, marks), t = totalShares(pool), sp = t > 0 ? Math.max(0, N) / t : 1;
  const ex = exposure(positions, marks), c = caps(N);
  const util = N <= 0 ? (ex.gross > 0 ? Infinity : 0) : Math.max(c.net ? ex.net / c.net : 0, c.oi ? ex.maxSide / c.oi : 0);
  const dd = Math.max(0, 1 - sp / Math.max(pool.peakSp, 1e-12));
  let winners = 0; for (const p of positions) winners += Math.max(0, posPnl(p, marks));
  const L = POOL_CFG.LEVELS;
  const level = N <= 0 || util > L.critical.util || dd >= L.critical.dd ? 'critical' : util >= L.stress.util || dd >= L.stress.dd ? 'stress' : util >= L.watch.util || dd >= L.watch.dd ? 'watch' : 'ok';
  const haircut = haircutFactor(pool, winners, level);
  return { nav: N, sp, exposure: ex, caps: c, util, dd, level, winners, haircut, tvl: N };
}

/** Payout haircut: when stressed (level >= stress) and enabled, winnings are paid pro-rata if the pool cannot cover all open winners. */
export function haircutFactor(pool, winnersTotal, level) {
  if (!pool.haircutOn || (level !== 'stress' && level !== 'critical') || winnersTotal <= 0) return 1;
  return Math.max(0, Math.min(1, pool.assets / winnersTotal));
}

/** Gate for NEW exposure. Returns an error string or null. `o`: {sym, side, notional, lev}. */
export function checkOpen(pool, positions, marks, o) {
  const m = metrics(pool, positions, marks), mult = POOL_CFG.STRESS_CAP_MULT[m.level];
  const pct = (x) => (x * 100).toFixed(0) + '%';
  if (m.nav <= 0) return 'House pool is empty — trading halted';
  const c = caps(m.nav, mult), per = m.exposure.per[o.sym] ?? { long: 0, short: 0 };
  const before = Math.abs(per.long - per.short);
  const after = Math.abs(per.long + (o.side === 'long' ? o.notional : 0) - per.short - (o.side === 'short' ? o.notional : 0));
  const reducesNet = after < before;
  if (mult === 0 && !reducesNet) return 'Pool stress (critical): new net-exposure-increasing positions are blocked';
  const posCap = caps(m.nav, mult).pos * levFactor(o.lev);
  if (o.notional > posCap + 1e-9) return `Max position size at ${o.lev}x is ${usdS(posCap)} notional (${pct(POOL_CFG.POS_CAP * levFactor(o.lev) * mult)} of pool)${mult < 1 ? ' — tightened: pool stressed' : ''}`;
  const sideOI = (per[o.side] ?? 0) + o.notional;
  if (sideOI > c.oi + 1e-9 && !reducesNet) return `${o.sym} ${o.side} open-interest cap reached (${usdS(c.oi)} per side)`;
  const net = m.exposure.net - before + after;
  if (net > c.net + 1e-9 && !reducesNet) return `Pool max net exposure reached (${usdS(c.net)})`;
  return null;
}
const usdS = (n) => '$' + Math.round(n).toLocaleString('en-US');

// ------------------------------------------------------------------ settlement (trader <-> pool)
/** Trader opened (or a limit order filled): fee -> pool, margin -> collateral. */
export function onOpen(pool, p) {
  pool.assets += p.openFee; pool.fees += p.openFee; pool.collateral += p.margin; pool.volume += p.size * p.entry; pool.stats.opens++;
}
/**
 * Trader closed (rec from engine.closePosition). Pool pays winners / keeps losers' margin.
 * Payout is limited by: (1) haircut factor on the winning part when stressed, (2) pool assets (pool can never go negative).
 * Returns {adjProceeds, delta, haircut, shortfall}: caller must debit trader balance by `delta` since the engine already credited rec.proceeds.
 */
export function onClose(pool, rec, h = 1) {
  const margin = rec.margin, win = Math.max(0, rec.proceeds - margin);
  let allowed = win * Math.max(0, Math.min(1, h)), haircut = win - allowed;
  const room = Math.max(0, pool.assets), shortfall = Math.max(0, allowed - room);
  allowed = Math.min(allowed, room);
  const adj = rec.proceeds - win + allowed; // proceeds after haircut / cap
  const closeFee = Math.min(rec.closeFee, adj);
  const delta = (rec.proceeds - rec.closeFee) - (adj - closeFee); // extra amount to take back from trader balance
  pool.collateral -= margin;
  pool.assets += margin - (adj - closeFee);
  pool.fees += closeFee; pool.trading += margin - adj; pool.funding += rec.funding;
  pool.volume += rec.size * rec.exit; pool.stats.closes++;
  if (rec.reason === 'liquidation') pool.stats.liqs++; if (rec.reason === 'adl') pool.stats.adl++;
  pool.stats.haircutPaid += haircut; pool.stats.shortfall += shortfall;
  rec.pnl = adj - margin - rec.openFee - closeFee; rec.fees = rec.openFee + closeFee; rec.closeFee = closeFee; rec.haircut = haircut + shortfall; rec.proceeds = adj;
  return { adjProceeds: adj, delta, haircut, shortfall };
}

// ------------------------------------------------------------------ LP deposits / withdrawals
export function requiredReserve(pool, positions, marks) {
  const m = metrics(pool, positions, marks);
  return Math.max(m.exposure.net / POOL_CFG.NET_CAP, m.exposure.maxSide / POOL_CFG.OI_CAP, m.winners);
}
export function lpValue(pool, who, positions, marks) { return (pool.shares[who] ?? 0) * sharePrice(pool, positions, marks); }
/** Deposit `amount` from a trader account into the pool at current share price. Returns shares minted or {error}. */
export function deposit(pool, who, amount, positions, marks) {
  if (!(amount > 0)) return { error: 'Enter an amount > 0' };
  const N = nav(pool, positions, marks), t = totalShares(pool);
  if (t > 0 && N <= 0) return { error: 'Pool is insolvent — deposits disabled' };
  const sp = t > 0 ? N / t : 1, minted = amount / sp;
  pool.shares[who] = (pool.shares[who] ?? 0) + minted; pool.assets += amount; pool.lpNet += amount;
  return { shares: minted, price: sp };
}
export function maxWithdraw(pool, who, positions, marks) {
  const N = nav(pool, positions, marks), val = lpValue(pool, who, positions, marks);
  return Math.max(0, Math.min(val, N - requiredReserve(pool, positions, marks), pool.assets));
}
/** Withdraw `amount` USD (burns shares at current price). Limited by liquidity reserved for open exposure. */
export function withdraw(pool, who, amount, positions, marks) {
  if (!(amount > 0)) return { error: 'Enter an amount > 0' };
  const mx = maxWithdraw(pool, who, positions, marks);
  if (amount > mx + 1e-9) return { error: `Max withdrawable now is ${usdS(mx)} (rest is reserved for open trader exposure / your balance)` };
  const sp = sharePrice(pool, positions, marks), burn = Math.min(pool.shares[who] ?? 0, amount / sp);
  pool.shares[who] -= burn; pool.assets -= amount; pool.lpNet -= amount;
  return { shares: burn, price: sp, amount };
}

// ------------------------------------------------------------------ ADL
/**
 * Auto-deleverage plan. Returns position ids to close (at mark, fee-free) so that hard caps hold again.
 * Triggers only if a hard cap (multiplier 1) is exceeded by more than ADL_TOL. Ranked like perp-DEX ADL: highest (pnl% x leverage) first,
 * on the overweight side only. `positions` items need id.
 */
export function adlPlan(pool, positions, marks) {
  const N = nav(pool, positions, marks), ids = [];
  const live = [...positions];
  const breach = () => {
    const c = caps(N), ex = exposure(live, marks);
    for (const [sym, e] of Object.entries(ex.per)) for (const s of ['long', 'short']) if (e[s] > c.oi * (1 + POOL_CFG.ADL_TOL)) return { sym, side: s, kind: 'oi' };
    if (ex.net > c.net * (1 + POOL_CFG.ADL_TOL)) {
      let best = null; for (const [sym, e] of Object.entries(ex.per)) { const d = e.long - e.short; if (!best || Math.abs(d) > Math.abs(best.d)) best = { sym, d }; }
      if (best && best.d !== 0) return { sym: best.sym, side: best.d > 0 ? 'long' : 'short', kind: 'net' };
    }
    return null;
  };
  for (let i = 0; i < 500; i++) {
    const b = breach(); if (!b) break;
    const cand = live.filter((p) => p.sym === b.sym && p.side === b.side);
    if (!cand.length) break;
    cand.sort((a, c) => score(c, marks) - score(a, marks));
    const v = cand[0]; ids.push(v.id); live.splice(live.indexOf(v), 1);
  }
  return ids;
}
const score = (p, marks) => (posPnl(p, marks) / p.margin) * p.lev;

// ------------------------------------------------------------------ history / APR
export function sample(pool, positions, marks, now, force = false) {
  const m = metrics(pool, positions, marks), h = pool.history, last = h.at(-1);
  pool.peakSp = Math.max(pool.peakSp, m.sp);
  if (!force && last && now - last.t < 4000) return m;
  h.push({ t: now, nav: m.nav, sp: m.sp, fees: pool.fees, pnl: pool.fees + pool.trading, assets: pool.assets });
  if (h.length > POOL_CFG.HISTORY_MAX) h.splice(0, h.length - POOL_CFG.HISTORY_MAX);
  return m;
}
/** Fee APR estimate: fees earned over the last `windowMs` (needs >= 30 s of data), annualised, over average TVL. Simple, not compounded. */
export function feeApr(pool, windowMs = 30 * 60000) {
  const h = pool.history; if (h.length < 2) return null;
  const end = h.at(-1); let i = h.length - 1; while (i > 0 && end.t - h[i - 1].t <= windowMs) i--;
  const a = h[i], dt = end.t - a.t; if (dt < 30000) return null;
  let tvl = 0; for (let j = i; j < h.length; j++) tvl += h[j].nav; tvl /= h.length - i;
  if (!(tvl > 0)) return null;
  return { fee: ((end.fees - a.fees) / tvl) * (365 * 86400000 / dt), pnl: ((end.pnl - a.pnl) / tvl) * (365 * 86400000 / dt), windowMs: dt };
}

/** Total funds in the system (for the conservation invariant). accounts: engine states. Must equal pool.ext. */
export function totalFunds(pool, accounts) {
  let t = pool.assets + pool.collateral;
  for (const s of accounts) { t += s.balance; for (const o of s.orders) t += o.margin + E.fee(o.margin * o.lev); }
  return t;
}
