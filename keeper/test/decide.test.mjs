import test from 'node:test'; import assert from 'node:assert/strict';
import { decide, isBusted } from '../src/decide.mjs';
const base = { blockNumber: 100, blockTs: 1000n, minBlocks: 2, ttl: 120, safetySecs: 20 };
const none = { blockNo: 0n, ts: 0n };
test('not busted, no mark -> none', () => assert.equal(decide({ ...base, busted: false, mark: none }), 'none'));
test('not busted, mark exists -> clear', () => assert.equal(decide({ ...base, busted: false, mark: { blockNo: 98n, ts: 990n } }), 'clear'));
test('busted, no mark -> mark', () => assert.equal(decide({ ...base, busted: true, mark: none }), 'mark'));
test('busted, mark 1 block old -> wait', () => assert.equal(decide({ ...base, busted: true, mark: { blockNo: 99n, ts: 999n } }), 'wait'));
test('busted, mark exactly 2 blocks old -> liquidate', () => assert.equal(decide({ ...base, busted: true, mark: { blockNo: 98n, ts: 998n } }), 'liquidate'));
test('busted, mark expired -> re-mark', () => assert.equal(decide({ ...base, busted: true, mark: { blockNo: 50n, ts: 800n } }), 'mark'));
test('busted, mark close to TTL -> wait_expiry (not safe to send)', () => assert.equal(decide({ ...base, busted: true, mark: { blockNo: 50n, ts: 890n } }), 'wait_expiry'));
test('busted, mark with 21s left -> liquidate', () => assert.equal(decide({ ...base, busted: true, mark: { blockNo: 50n, ts: 901n } }), 'liquidate'));
test('isBusted long/short boundaries', () => {
  assert.ok(isBusted(true, 100n, 100n)); assert.ok(!isBusted(true, 101n, 100n));
  assert.ok(isBusted(false, 100n, 100n)); assert.ok(!isBusted(false, 99n, 100n));
});
