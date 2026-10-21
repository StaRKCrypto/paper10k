import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, divergenceBps, judge, fetchRefs } from '../src/refprice.mjs';

test('median ignores dead sources', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([NaN, 5, 0]), 5);
  assert.ok(Number.isNaN(median([])));
});
test('judge: ok / diverged / unknown', () => {
  assert.equal(judge(100_000, { a: 100_010, b: 99_990, c: 100_000 }).verdict, 'ok');
  assert.equal(judge(101_000, { a: 100_010, b: 99_990 }, { maxBps: 50 }).verdict, 'diverged');
  assert.equal(judge(100_000, { a: 100_000, b: NaN, c: NaN }).verdict, 'unknown'); // 1 live source => no veto
  assert.ok(Math.abs(divergenceBps(101, 100) - 100) < 1e-9);
});
test('fetchRefs tolerates failing venues (mocked fetch)', async () => {
  const fetchFn = async (url) => {
    if (url.includes('binance')) return { ok: true, json: async () => ({ price: '100000.5' }) };
    if (url.includes('hyperliquid')) return { ok: true, json: async () => ({ BTC: '100001' }) };
    if (url.includes('lighter')) return { ok: true, json: async () => ({ order_book_details: [{ market_id: 1, last_trade_price: '99999' }] }) };
    return { ok: false, status: 503 };
  };
  const q = await fetchRefs('BTC', { fetchFn });
  assert.equal(q.binance, 100000.5); assert.ok(Number.isNaN(q.coinbase)); assert.equal(q.lighter, 99999);
  assert.equal(judge(100_000, q).verdict, 'ok');
});
