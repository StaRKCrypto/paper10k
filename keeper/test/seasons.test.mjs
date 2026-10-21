import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSeasons, seasonOf } from '../src/seasons.mjs';

const S = [{ id: 's1', name: 'S1', start: 100, end: 200 }, { id: 's2', name: 'S2', start: 200, end: 300 }];
const A = '0xAAaa000000000000000000000000000000000001', B = '0xbbbb000000000000000000000000000000000002';
const ev = [
  { name: 'Opened', ts: 110, args: { user: A, notional: 100_000n } },
  { name: 'Closed', ts: 120, args: { user: A, profitPaid: 50n, profitQueued: 10n, loss: 0n } },
  { name: 'Opened', ts: 130, args: { user: B, notional: 200_000n } },
  { name: 'Liquidated', ts: 140, args: { user: B, margin: 20n, minted: 2000n } },
  { name: 'Opened', ts: 250, args: { user: A, notional: 1n } },
  { name: 'Liquidated', ts: 99, args: { user: A, margin: 1n, minted: 9n } }, // outside any season
];

test('season boundaries are [start, end)', () => {
  assert.equal(seasonOf(100, S).id, 's1'); assert.equal(seasonOf(200, S).id, 's2'); assert.equal(seasonOf(300, S), null);
});
test('leaderboard: score = PAPER10KX minted, pnl, rekts, competitions', () => {
  const r = computeSeasons(ev, S);
  const s1 = r.s1.rows;
  assert.equal(s1[0].addr, B.toLowerCase()); assert.equal(s1[0].score, 2000n); assert.equal(s1[0].rekts, 1); assert.equal(s1[0].pnl, -20n);
  assert.equal(s1[1].pnl, 60n); assert.equal(s1[1].bestWin, 60n);
  assert.equal(r.s1.competitions.topPnl.addr, A.toLowerCase());
  assert.equal(r.s1.competitions.mostRekts.addr, B.toLowerCase());
  assert.equal(r.s1.competitions.topVolume.value, 200_000n);
  assert.equal(r.s2.rows.length, 1); assert.equal(r.s2.rows[0].score, 0n);
});
test('fuzz: totals are conserved across random events', () => {
  for (let k = 0; k < 200; k++) {
    const evs = []; let minted = 0n;
    for (let i = 0; i < 30; i++) {
      const u = Math.random() < 0.5 ? A : B, ts = 100 + Math.floor(Math.random() * 200);
      const t = Math.floor(Math.random() * 3);
      if (t === 0) evs.push({ name: 'Opened', ts, args: { user: u, notional: BigInt(i + 1) } });
      else if (t === 1) evs.push({ name: 'Closed', ts, args: { user: u, profitPaid: BigInt(i), profitQueued: 0n, loss: BigInt(i % 3) } });
      else { const m = BigInt(i + 1); minted += m; evs.push({ name: 'Liquidated', ts, args: { user: u, margin: 1n, minted: m } }); }
    }
    const r = computeSeasons(evs, S, { minHoldTrades: 0 });
    const tot = Object.values(r).flatMap((x) => x.rows).reduce((a, x) => a + x.score, 0n);
    assert.equal(tot, minted);
  }
});
