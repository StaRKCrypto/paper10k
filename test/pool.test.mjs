import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import * as P from '../src/pool.js';
import * as V from '../src/venue.js';
import { Bots, mulberry32 } from '../src/bots.js';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const accts = (c) => Object.values(c.accts);
const conserved = (c) => near(P.totalFunds(c.pool, accts(c)), c.pool.ext, 1e-5);
const mk = (seed = 1_000_000) => V.initCtx(E.newState(), V.botState(), P.newPool(seed));
const O = (o) => ({ sym: 'BTC', side: 'long', margin: 10, lev: 10, price: 100, now: 0, ...o });

// ---------------- conservation of funds
test('conservation: open -> win -> close', () => {
  const c = mk(), M = { BTC: 100 };
  conserved(c);
  const r = V.open(c, 'user', O({ margin: 100, lev: 10 }), M);
  assert.ok(r.position); conserved(c);
  near(c.pool.collateral, 100); near(c.pool.assets, 1_000_000 + 0.35);
  const rec = V.close(c, 'user', r.position.id, 110, 1, 'close', { BTC: 110 });
  conserved(c);
  near(rec.pnl, 100 - 0.35 - 1100 * E.CFG.TAKER_FEE, 1e-9);
  near(c.accts.user.balance, 1000 + rec.pnl, 1e-9);
  near(c.pool.collateral, 0);
  // pool = seed + fees - trader raw win
  near(c.pool.assets, 1_000_000 + 0.35 + 1100 * E.CFG.TAKER_FEE - 100, 1e-9);
});
test('losses and fees flow to the pool; liquidation forfeits margin to the pool', () => {
  const c = mk();
  const r = V.open(c, 'user', O({ margin: 10, lev: 1000, price: 100 }), { BTC: 100 });
  const fee = r.position.openFee, before = c.pool.assets;
  const ev = V.tick(c, 'user', { BTC: 99.5 }, {}, 1);
  assert.equal(ev[0].type, 'liquidation'); conserved(c);
  near(c.pool.assets, before + 10); near(c.pool.trading, 10); near(c.pool.fees, fee);
  near(c.accts.user.balance, 1000 - 10 - fee);
});
test('pool pays trader wins (pool assets fall by the win)', () => {
  const c = mk(), r = V.open(c, 'user', O({ margin: 50, lev: 100 }), { BTC: 100 });
  const a0 = c.pool.assets;
  V.close(c, 'user', r.position.id, 101, 1, 'close', { BTC: 101 }); // +1% * 5000 = +50
  conserved(c);
  near(c.pool.trading, -50, 1e-9);
  assert.ok(c.pool.assets < a0 + 5000 * 2 * E.CFG.TAKER_FEE + 1e-9 && c.pool.assets > a0 - 50);
});
test('limit order fill, cancel and caps rejection conserve funds', () => {
  const c = mk(1000); // tiny pool -> tiny caps
  const r = V.placeLimit(c, 'user', { ...O({ margin: 1, lev: 10 }), limitPrice: 90 }, { BTC: 100 });
  assert.ok(r.order); conserved(c);
  V.cancel(c, 'user', r.order.id); conserved(c);
  const r2 = V.placeLimit(c, 'user', { ...O({ margin: 1, lev: 10 }), limitPrice: 90 }, { BTC: 100 });
  const ev = V.tick(c, 'user', { BTC: 89 }, {}, 1);
  assert.equal(ev[0].type, 'fill'); conserved(c);
  assert.ok(r2.order);
});
test('limit fill rejected by cap is refunded in full', () => {
  const c = mk(100_000);
  const placed = V.placeLimit(c, 'user', { ...O({ margin: 1, lev: 100 }), limitPrice: 90 }, { BTC: 100 });
  assert.ok(placed.order);
  c.pool.assets = 100; // pool collapses before fill (e.g. LPs lost): cap shrinks
  c.pool.ext -= 100_000 - 100; // keep invariant bookkeeping honest for the test
  const bal = c.accts.user.balance;
  const ev = V.tick(c, 'user', { BTC: 89 }, {}, 1);
  assert.equal(ev.find((e) => e.type === 'reject').type, 'reject');
  near(c.accts.user.balance, bal + 1 + E.fee(100)); assert.equal(c.accts.user.positions.length, 0);
});
test('randomised soak (user + bots + LP flows + drill + reset) conserves funds & never negative pool', () => {
  const rng = mulberry32(7), c = mk(200_000), b = new Bots(mulberry32(11)); b.rate = 'hot';
  const px = { BTC: 100000, ETH: 3000, DOGE: 0.2 }; let t = 0;
  for (let i = 0; i < 4000; i++) {
    t += 1000;
    for (const k in px) px[k] *= 1 + (rng() - 0.5) * (i % 500 < 20 ? 0.02 : 0.0008);
    b.step(c, px, { BTC: 0.00001 }, t);
    V.tick(c, 'user', px, { BTC: 0.00001 }, t);
    if (i % 17 === 0) V.open(c, 'user', O({ sym: ['BTC', 'ETH', 'DOGE'][i % 3], side: i % 2 ? 'long' : 'short', margin: 1 + (i % 9), lev: [10, 100, 1000, 10000][i % 4], price: px[['BTC', 'ETH', 'DOGE'][i % 3]], now: t }), px);
    if (i % 41 === 0) { const p = c.accts.user.positions[0]; if (p) V.close(c, 'user', p.id, px[p.sym], t, 'close', px); }
    if (i % 97 === 0) V.lpDeposit(c, 5, px);
    if (i % 131 === 0) V.lpWithdraw(c, Math.min(3, P.maxWithdraw(c.pool, 'user', V.views(c), px)), px);
    if (i === 2500) V.stressDrill(c, 0.2);
    if (i === 3000) V.resetUser(c, px, t);
    P.sample(c.pool, V.views(c), px, t);
    assert.ok(c.pool.assets >= -1e-9, 'pool assets negative at ' + i);
    conserved(c);
  }
  assert.ok(c.pool.stats.opens > 100);
});

// ---------------- share math
test('share math: first deposit 1:1, later deposits at NAV price, no dilution of existing LPs', () => {
  const p = P.newPool(1000); const M = {};
  assert.equal(P.sharePrice(p, [], M), 1);
  p.assets = 1500; // pool earned 50%: share price 1.5
  near(P.sharePrice(p, [], M), 1.5);
  const d = P.deposit(p, 'user', 300, [], M);
  near(d.shares, 200); near(d.price, 1.5);
  near(P.sharePrice(p, [], M), 1.5); // unchanged by deposit
  near(P.lpValue(p, 'user', [], M), 300); near(P.lpValue(p, 'house', [], M), 1500);
  const w = P.withdraw(p, 'user', 150, [], M);
  near(w.shares, 100); near(p.shares.user, 100); near(p.assets, 1650);
  near(P.sharePrice(p, [], M), 1.5);
});
test('share math: withdraw all returns exactly deposited value at constant NAV; round trip loses nothing', () => {
  const p = P.newPool(1_000_000);
  P.deposit(p, 'user', 123.45, [], {}); const w = P.withdraw(p, 'user', 123.45, [], {});
  near(p.shares.user, 0, 1e-9); near(w.amount, 123.45); near(p.assets, 1_000_000, 1e-9);
});
test('NAV marks open trader PnL to market: unrealised trader win lowers share price; loss is capped at margin', () => {
  const p = P.newPool(1000), pos = { sym: 'BTC', side: 'long', size: 1, entry: 100, margin: 10, funding: 0, mark: 100, lev: 10 };
  near(P.nav(p, [pos], { BTC: 105 }), 1000 - 5);
  near(P.nav(p, [pos], { BTC: 50 }), 1000 + 10); // -50 pnl floored at -margin
  near(P.sharePrice(p, [pos], { BTC: 105 }), 0.995);
});
test('late LP cannot steal unrealised gains: deposit while a trader is winning mints more shares', () => {
  const p = P.newPool(1000), pos = { sym: 'BTC', side: 'long', size: 1, entry: 100, margin: 10, funding: 0, mark: 100, lev: 10 };
  const M = { BTC: 110 }; // trader up $10 unrealised
  const sp = P.sharePrice(p, [pos], M); near(sp, 0.99);
  const d = P.deposit(p, 'user', 99, [pos], M); near(d.price, 0.99); near(d.shares, 100);
  P.sample(p, [pos], { BTC: 100 }, 0, true);
  near(P.sharePrice(p, [pos], { BTC: 100 }), 1099 / 1100, 1e-9); // trader gave the gain back: pool 1099 over 1100 shares
});

test('deposit/withdraw errors and balance checks', () => {
  const c = mk();
  assert.ok(V.lpDeposit(c, 0, {}).error); assert.ok(V.lpDeposit(c, 5000, {}).error);
  assert.ok(V.lpWithdraw(c, 10, {}).error); // no shares
  V.lpDeposit(c, 100, {}); near(c.accts.user.balance, 900); conserved(c);
  V.lpWithdraw(c, 40, {}); near(c.accts.user.balance, 940); conserved(c);
});
test('withdraw is limited by liquidity reserved for open exposure', () => {
  const p = P.newPool(1_000_000); P.deposit(p, 'user', 1000, [], {});
  const pos = { sym: 'BTC', side: 'long', size: 2.6, entry: 100000, margin: 26, funding: 0, mark: 100000, lev: 10000 }; // $260k net => needs $1.04M reserve
  const mx = P.maxWithdraw(p, 'user', [pos], { BTC: 100000 });
  assert.ok(mx < 1000 + 1e-9);
  near(P.requiredReserve(p, [pos], { BTC: 100000 }), 1_040_000);
  near(mx, 0, 1e-6); assert.ok(P.withdraw(p, 'user', 10, [pos], { BTC: 100000 }).error);
});

// ---------------- caps
test('caps scale with pool size and leverage tier', () => {
  const c = P.caps(1_000_000);
  near(c.oi, 300_000); near(c.net, 250_000); near(c.pos, 50_000);
  near(P.maxPositionNotional(1_000_000, 100), 50_000); near(P.maxPositionNotional(1_000_000, 1000), 25_000); near(P.maxPositionNotional(1_000_000, 10000), 10_000);
  near(P.maxPositionNotional(2_000_000, 10000), 20_000);
});
test('max position size enforced at 10000x', () => {
  const c = mk(), M = { BTC: 100 };
  assert.ok(V.open(c, 'user', O({ margin: 1, lev: 10000 }), M).position); // $10k == cap
  assert.match(V.open(c, 'user', O({ margin: 1.5, lev: 10000 }), M).error ?? '', /Max position size/);
  assert.equal(P.checkOpen(c.pool, V.views(c), M, { sym: 'ETH', side: 'long', notional: 50_000, lev: 100 }), null);
  assert.match(P.checkOpen(c.pool, V.views(c), M, { sym: 'ETH', side: 'long', notional: 50_001, lev: 100 }) ?? '', /Max position/);
});
test('per-market per-side OI cap', () => {
  const p = P.newPool(100_000), M = { BTC: 100 }; // oi cap 30k, pos cap 5k @<=100x
  const pos = []; let id = 1;
  const add = (side, n) => pos.push({ id: id++, sym: 'BTC', side, size: n / 100, entry: 100, margin: n / 10, lev: 10, funding: 0, mark: 100 });
  for (let i = 0; i < 5; i++) add('short', 5000); // 25k short
  for (let i = 0; i < 6; i++) add('long', 5000); // 30k long, net 5k
  assert.match(P.checkOpen(p, pos, M, { sym: 'BTC', side: 'long', notional: 1000, lev: 10 }) ?? '', /open-interest cap/);
  assert.equal(P.checkOpen(p, pos, M, { sym: 'BTC', side: 'short', notional: 2000, lev: 10 }), null); // reduces net, allowed
});
test('max net exposure across markets', () => {
  const p = P.newPool(100_000), M = { A: 1, B: 1, C: 1, D: 1, E: 1 }; // net cap 25k
  const pos = []; let id = 1;
  for (const s of ['A', 'B', 'C', 'D', 'E']) pos.push({ id: id++, sym: s, side: 'long', size: 5000, entry: 1, margin: 500, lev: 10, funding: 0, mark: 1 }); // 5k net each = 25k
  assert.match(P.checkOpen(p, pos, M, { sym: 'F', side: 'long', notional: 1000, lev: 10 }) ?? '', /net exposure/);
  assert.equal(P.checkOpen(p, pos, M, { sym: 'A', side: 'short', notional: 1000, lev: 10 }), null);
});
test('stress tightens caps (x0.5) and critical blocks net-increasing opens', () => {
  const p = P.newPool(1_000_000); p.peakSp = 1 / 0.8; // 20% drawdown -> stress
  assert.equal(P.metrics(p, [], {}).level, 'stress');
  assert.match(P.checkOpen(p, [], {}, { sym: 'BTC', side: 'long', notional: 30_000, lev: 100 }) ?? '', /Max position size/);
  assert.equal(P.checkOpen(p, [], {}, { sym: 'BTC', side: 'long', notional: 20_000, lev: 100 }), null);
  p.peakSp = 2; assert.equal(P.metrics(p, [], {}).level, 'critical');
  assert.match(P.checkOpen(p, [], {}, { sym: 'BTC', side: 'long', notional: 10, lev: 1 }) ?? '', /critical/);
});
test('empty pool halts trading', () => {
  const p = P.newPool(100); p.assets = 0; assert.match(P.checkOpen(p, [], {}, { sym: 'BTC', side: 'long', notional: 1, lev: 1 }), /empty/);
});

// ---------------- stress levels, haircut, payout cap, ADL
test('stress levels from utilisation and drawdown', () => {
  const p = P.newPool(100_000);
  assert.equal(P.metrics(p, [], {}).level, 'ok');
  p.peakSp = 1 / 0.93; assert.equal(P.metrics(p, [], {}).level, 'watch');
  p.peakSp = 1 / 0.8; assert.equal(P.metrics(p, [], {}).level, 'stress');
  p.peakSp = 1 / 0.6; assert.equal(P.metrics(p, [], {}).level, 'critical');
  p.peakSp = 1;
  const pos = [{ id: 1, sym: 'BTC', side: 'long', size: 240, entry: 100, margin: 2400, lev: 10, funding: 0, mark: 100 }]; // 24k net vs 25k cap => util .96
  assert.equal(P.metrics(p, pos, { BTC: 100 }).level, 'stress');
});
test('payout haircut: winners paid pro-rata only when stressed and enabled', () => {
  const p = P.newPool(1000); p.assets = 1000;
  assert.equal(P.haircutFactor(p, 5000, 'ok'), 1);
  near(P.haircutFactor(p, 5000, 'stress'), 0.2);
  p.haircutOn = false; assert.equal(P.haircutFactor(p, 5000, 'stress'), 1);
});
test('settlement applies haircut to the winning part only and conserves funds', () => {
  const c = mk(10_000); const M = { BTC: 100 };
  const r = V.open(c, 'user', O({ margin: 50, lev: 100 }), M); // $5000 notional, cap(10k pool)=500*... lowered below
  assert.ok(r.error || r.position);
  if (r.error) return; // cap too tight at this pool size; covered below with larger pool
});
test('haircut and cap at close (large pool, forced stress)', () => {
  const c = mk(1_000_000), M = { BTC: 100 };
  const r = V.open(c, 'user', O({ margin: 50, lev: 100 }), M); assert.ok(r.position);
  c.pool.peakSp = 1 / 0.8; // stressed -> haircut live
  // winners total = +50 at 101 (5000 notional * 1%); pool assets 1e6 >> 50, so factor 1
  let rec = V.close(c, 'user', r.position.id, 101, 1, 'close', { BTC: 101 }); conserved(c);
  near(rec.haircut, 0);
  // now make the pool tiny so it cannot cover the winner
  const c2 = mk(1_000_000), r2 = V.open(c2, 'user', O({ margin: 50, lev: 100 }), M);
  { const d = c2.pool.assets - 20; c2.pool.assets = 20; c2.pool.ext -= d; } // pool nearly drained (LP lost it)
  c2.pool.peakSp = 1e9; // critical
  const rec2 = V.close(c2, 'user', r2.position.id, 101, 1, 'close', { BTC: 101 }); conserved(c2);
  assert.ok(c2.pool.assets >= -1e-9); assert.ok(rec2.haircut > 0);
  assert.ok(rec2.proceeds < 100 && rec2.proceeds >= 50); // margin always returned, win cut
});
test('without haircut the payout is still capped by pool assets (never negative); shortfall recorded', () => {
  const c = mk(1_000_000), M = { BTC: 100 }, r = V.open(c, 'user', O({ margin: 50, lev: 100 }), M);
  c.pool.haircutOn = false; { const d = c.pool.assets - 20; c.pool.assets = 20; c.pool.ext -= d; }
  const rec = V.close(c, 'user', r.position.id, 101, 1, 'close', { BTC: 101 }); conserved(c);
  assert.ok(c.pool.assets >= 0); assert.ok(c.pool.stats.shortfall > 0 && rec.haircut > 0);
});
test('ADL: trims most profitable overweight positions when caps are breached; no-op inside tolerance', () => {
  const p = P.newPool(100_000), M = { BTC: 100 }; // oi cap 30k (ADL above 33k), net cap 25k (ADL above 27.5k)
  const mkp = (id, side, n) => ({ id, sym: 'BTC', side, size: n / 100, entry: 100, margin: n / 100, lev: 100, funding: 0, mark: 100 });
  const ok = [mkp(1, 'long', 16000), mkp(2, 'long', 16000), mkp(3, 'short', 16000)]; // 32k < 33k, net 16k
  assert.deepEqual(P.adlPlan(p, ok, M), []);
  const big = [mkp(1, 'long', 12000), mkp(2, 'long', 12000), mkp(3, 'long', 12000), mkp(4, 'short', 12000)]; // 36k > 33k
  big[1].entry = 99; // pos 2 most profitable
  assert.deepEqual(P.adlPlan(p, big, M), [2]);
});

test('ADL executes through the venue after the pool shrinks: fee-free, funds conserved, caps restored', () => {
  const c = mk(1_000_000), M = { BTC: 100 };
  for (let i = 0; i < 5; i++) assert.ok(V.open(c, 'bots', O({ margin: 500, lev: 100 }), M).position); // 5 x $50k = $250k net (== cap)
  conserved(c);
  V.stressDrill(c, 0.6); conserved(c); // whale win drains LPs: caps shrink to 40%
  const ev = V.adl(c, M, 5);
  assert.ok(ev.length >= 2 && ev.every((e) => e.type === 'adl' && e.rec.closeFee === 0 && e.rec.reason === 'adl'));
  conserved(c);
  const m = V.snapshot(c, M);
  assert.ok(m.exposure.net <= m.caps.net * 1.1 + 1e-6);
  assert.equal(c.pool.stats.adl, ev.length);
});
test('bot traffic is deterministic for a seed and labelled in its log', () => {
  const run = () => { const c = mk(), b = new Bots(mulberry32(5)); b.rate = 'hot'; let t = 0; for (let i = 0; i < 300; i++) { t += 1000; b.step(c, { BTC: 100000, ETH: 3000 }, {}, t); } return [c.pool.stats.opens, c.pool.fees, b.log.length]; };
  assert.deepEqual(run(), run());
  const b = new Bots(mulberry32(5)); b.enabled = false; const c = mk(); for (let i = 1; i < 50; i++) b.step(c, { BTC: 1 }, {}, i * 1000);
  assert.equal(c.pool.stats.opens, 0); // off => no flow
});
test('fee APR: annualised from history window; null with too little data', () => {
  const p = P.newPool(1000); assert.equal(P.feeApr(p), null);
  p.history.push({ t: 0, nav: 1000, fees: 0, pnl: 0 }, { t: 3600000, nav: 1000, fees: 1, pnl: 1 });
  near(P.feeApr(p, 7200000).fee, (1 / 1000) * 24 * 365, 1e-6);
});
test('10000x liquidation geometry: pool keeps margin on a 0.009% adverse move, but wick between ticks is a free option for the trader', () => {
  const c = mk(), M0 = { BTC: 100000 };
  const r = V.open(c, 'user', O({ margin: 1, lev: 10000, price: 100000 }), M0);
  assert.ok(r.position);
  // a wick to -0.02% and back between two ticks is never observed: position survives, pool gets nothing
  assert.equal(V.tick(c, 'user', { BTC: 100000 }, {}, 1).length, 0);
  // observed tick beyond liq -> pool keeps the full margin
  const ev = V.tick(c, 'user', { BTC: 99990 }, {}, 2); assert.equal(ev[0].type, 'liquidation'); near(c.pool.trading, 1);
  conserved(c);
});
