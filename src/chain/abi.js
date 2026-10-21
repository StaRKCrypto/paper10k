// Minimal ABI helpers for static types (uint, address, bool) only — no library needed.
export const SEL = {
  deposit: '0xb6b55f25', withdraw: '0x2e1a7d4d', open: '0xadecf87b', close: '0x0aebeb4e', liquidate: '0x415f1240', free: '0xc9b5bb17',
  pool: '0x16f0115b', totalMargin: '0xeaa674d1', totalFree: '0x333e44e6', positions: '0x99fbab88', paused: '0x5c975abb',
  processQueue: '0xdc900765', queuedOf: '0xb7106b1c', queuedTotal: '0xe20cfe1c', currentParams: '0xa50bd4ca', bustPriceOf: '0x8a8c6842', insurance: '0x89cf3204', faucet: '0xde5f72fd', balanceOf: '0x70a08231', approve: '0x095ea7b3', allowance: '0xdd62ed3e',
  markets: '0xece91e35', limits: '0x860aefcf', walletMargin: '0xe9c772f8', setOperator: '0x558a7297', isOperator: '0xb6363cf2', rektCount: '0x3fb9154e', decimals: '0x313ce567',
  tPlace: '0x4017e328', tCancel: '0x40e58ee5', tOrders: '0xa85c38ef', bClaim: '0x00e93d31', bEligible: '0xe1227718', bOwnerOf: '0x6352211e', bTokenIdOf: '0xfb480954',
  getPrice: '0xda26663a', previewClose: '0x39599487', emergencyCancel: '0xdd75cd9b', ops: '0xe70abe92',
  requestOpen: '0x2edf4d37', requestClose: '0x3807825b', finalized: '0xb3f05b97',
};
export const TOPIC_OPENED = '0x4644161e119a512266544afb02a59378a86830eeae4174f3757d67e92267aab2';
export const TOPIC_CLOSED = '0xe035112851ea07415af2ee3812e7c5452d37ab06dd3ea70233c32a5a5a8f3eb4';
export const TOPIC_LIQUIDATED = '0x22600a0aa3d39e677ae2697808c1828d8dec8a7b140cd5b367ea68783b19015a';
const word = (v) => {
  if (typeof v === 'boolean') v = v ? 1n : 0n;
  if (typeof v === 'string' && v.startsWith('0x')) return v.slice(2).toLowerCase().padStart(64, '0');
  const b = BigInt(v); if (b < 0n) throw new Error('negative');
  return b.toString(16).padStart(64, '0');
};
export const enc = (sel, ...args) => sel + args.map(word).join('');
export const words = (hex) => (hex.slice(2).match(/.{64}/g) || []);
export const toBig = (w) => BigInt('0x' + w);
export const toAddr = (w) => '0x' + w.slice(24);
export const parseUnits = (s, d = 6) => {
  const [i, f = ''] = String(s).trim().split('.');
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error('bad number');
  return BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0');
};
export const fmtUnits = (b, d = 6, dp = 2) => {
  const neg = b < 0n; if (neg) b = -b;
  const s = b.toString().padStart(d + 1, '0');
  const int = s.slice(0, -d), frac = s.slice(-d).slice(0, dp);
  return (neg ? '-' : '') + BigInt(int).toLocaleString('en-US') + (dp ? '.' + frac : '');
};
