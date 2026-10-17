import test from 'node:test'; import assert from 'node:assert/strict';
import { enc, SEL, parseUnits, fmtUnits, words, toBig, toAddr } from '../src/chain/abi.js';
test('encode open()', () => {
  const d = enc(SEL.open, 0, true, 10_000_000n, 10000, 100n * 10n ** 18n);
  assert.equal(d.length, 2 + 8 + 64 * 5); assert.ok(d.startsWith('0xadecf87b'));
  const w = words('0x' + d.slice(10)); assert.equal(toBig(w[1]), 1n); assert.equal(toBig(w[3]), 10000n);
});
test('address word', () => { const a = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; assert.equal(toAddr(words(enc(SEL.balanceOf, a).replace(SEL.balanceOf, '0x'))[0]), a.toLowerCase()); });
test('units', () => { assert.equal(parseUnits('1.5'), 1_500_000n); assert.equal(parseUnits('0.000001'), 1n); assert.equal(fmtUnits(1_234_567_890n), '1,234.56'); assert.throws(() => parseUnits('1e5')); });
test('negative rejected', () => assert.throws(() => enc(SEL.deposit, -1n)));
