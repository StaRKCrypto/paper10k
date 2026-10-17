import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('liq price long/short at 10x', () => {
  const size = E.sizeOf(100, 10, 50000);
  near(E.liqPrice('long', 50000, size, 100), 50000 * (1 - 0.9 / 10), 1e-6);
  near(E.liqPrice('short', 50000, size, 100), 50000 * (1 + 0.9 / 10), 1e-6);
});
test('10000x: ~0.009% move liquidates', () => {
  const entry = 100000, margin = 1, lev = 10000, size = E.sizeOf(margin, lev, entry);
  const liq = E.liqPrice('long', entry, size, margin);
  near((entry - liq) / entry * 100, 0.009, 1e-9);
  const p = { side: 'long', entry, size, margin, lev, funding: 0 };
  assert.equal(E.isLiquidated(p, entry * (1 - 0.00005)), false);
  assert.equal(E.isLiquidated(p, entry * (1 - 0.0001)), true);
});
test('1x long never liquidates before -90%', () => {
  const size = E.sizeOf(100, 1, 100);
  near(E.liqPrice('long', 100, size, 100), 10);
});
test('liq price consistent with equity threshold', () => {
  for (const side of ['long', 'short']) for (const lev of [2, 50, 1000, 10000]) {
    const entry = 3000, margin = 25, size = E.sizeOf(margin, lev, entry);
    const p = { side, entry, size, margin, lev, funding: 0 };
    const lp = E.liqPrice(side, entry, size, margin);
    near(E.equityOf(p, lp), margin * E.CFG.MAINT, 1e-6);
  }
});
test('funding shifts liq price toward entry', () => {
  const size = E.sizeOf(100, 10, 1000);
  assert.ok(E.liqPrice('long', 1000, size, 100, 5) > E.liqPrice('long', 1000, size, 100, 0));
  assert.ok(E.liqPrice('short', 1000, size, 100, 5) < E.liqPrice('short', 1000, size, 100, 0));
});
test('open/close accounting with fees', () => {
  const s = E.newState();
  const r = E.openMarket(s, { sym: 'BTC', side: 'long', margin: 100, lev: 10, price: 100, now: 0 });
  assert.ok(r.position);
  near(s.balance, 1000 - 100 - 1000 * E.CFG.TAKER_FEE);
  const rec = E.closePosition(s, r.position.id, 110, 1);
  // pnl raw = +100 (10% * 1000), fees = 0.35 + 1100*0.00035
  near(rec.pnl, 100 - 0.35 - 1100 * E.CFG.TAKER_FEE, 1e-9);
  near(s.balance, 1000 + rec.pnl, 1e-9);
});
test('short profits when price falls', () => {
  const s = E.newState();
  const r = E.openMarket(s, { sym: 'ETH', side: 'short', margin: 50, lev: 20, price: 2000, now: 0 });
  assert.ok(E.upnl(r.position, 1900) > 0);
  near(E.upnl(r.position, 1900), 50, 1e-9);
});
test('loss capped at margin; liquidation forfeits margin', () => {
  const s = E.newState();
  const r = E.openMarket(s, { sym: 'BTC', side: 'long', margin: 10, lev: 10000, price: 100000, now: 0 });
  const before = s.balance;
  const ev = E.tick(s, { BTC: 99990 }, {}, 1);
  assert.equal(ev[0].type, 'liquidation');
  near(s.balance, before); // margin already gone
  near(ev[0].rec.pnl, -10 - r.position.openFee);
  assert.equal(s.positions.length, 0);
  assert.equal(s.liquidations, 1);
});
test('no liquidation inside the band', () => {
  const s = E.newState();
  E.openMarket(s, { sym: 'BTC', side: 'short', margin: 10, lev: 10000, price: 100000, now: 0 });
  assert.equal(E.tick(s, { BTC: 100005 }, {}, 1).length, 0);
  assert.equal(E.tick(s, { BTC: 100009.5 }, {}, 2)[0].type, 'liquidation');
});
test('validation', () => {
  const s = E.newState();
  assert.ok(E.validate(s, { margin: 0.5, lev: 10 }));
  assert.ok(E.validate(s, { margin: 10, lev: 10001 }));
  assert.ok(E.validate(s, { margin: 1000, lev: 10 })); // fee does not fit
  assert.equal(E.validate(s, { margin: E.maxMargin(1000, 10), lev: 10 }), null);
  assert.equal(E.validate(s, { margin: 5, lev: 10000 }), null);
});
test('limit orders reserve, fill and cancel', () => {
  const s = E.newState();
  const { order } = E.placeLimit(s, { sym: 'BTC', side: 'long', margin: 100, lev: 10, limitPrice: 90, now: 0 });
  near(s.balance, 1000 - 100 - 0.35);
  assert.equal(E.tick(s, { BTC: 95 }, {}, 1).length, 0);
  const ev = E.tick(s, { BTC: 89 }, {}, 2);
  assert.equal(ev[0].type, 'fill');
  near(s.positions[0].entry, 90);
  const o2 = E.placeLimit(s, { sym: 'BTC', side: 'short', margin: 100, lev: 10, limitPrice: 200, now: 3 }).order;
  assert.ok(E.cancelOrder(s, o2.id));
  near(s.balance, 1000 - 100 - 0.35 - 0 , 1e-9);
});
test('funding: longs pay positive rate, shorts receive', () => {
  const mk = (side) => ({ side, size: 1, lastFundingAt: 0, funding: 0, fundingRate: 0.001 });
  const l = mk('long'), sh = mk('short');
  E.accrueFunding(l, 1000, 3600000); E.accrueFunding(sh, 1000, 3600000);
  near(l.funding, 1); near(sh.funding, -1);
});
test('total equity conserved on open', () => {
  const s = E.newState();
  E.openMarket(s, { sym: 'BTC', side: 'long', margin: 100, lev: 5, price: 100, now: 0 });
  near(E.totalEquity(s, { BTC: 100 }), 1000 - 500 * E.CFG.TAKER_FEE);
});
