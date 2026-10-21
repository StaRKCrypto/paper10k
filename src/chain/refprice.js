// Browser copy of keeper/src/refprice.mjs: off-chain venue prices for display + warnings only. Never sent on-chain as a price.
const SYM = { BTC: ['BTCUSDT', 'BTC-USD', 'BTC', 1], ETH: ['ETHUSDT', 'ETH-USD', 'ETH', 0], SOL: ['SOLUSDT', 'SOL-USD', 'SOL', 2] };
const tmo = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
const j = async (u, i = {}) => { const r = await fetch(u, { ...i, signal: tmo(3000) }); if (!r.ok) throw 0; return r.json(); };
export function median(xs) { const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b); if (!v.length) return NaN; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
let hlCache = { t: 0, p: null }, lgCache = { t: 0, p: null };
export async function refQuotes(sym) {
  const s = SYM[sym]; if (!s) return {};
  const g = async (f) => { try { return Number(await f()); } catch { return NaN; } };
  const now = Date.now();
  const [binance, coinbase, hyperliquid, lighter] = await Promise.all([
    g(async () => (await j(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s[0]}`)).price),
    g(async () => (await j(`https://api.exchange.coinbase.com/products/${s[1]}/ticker`)).price),
    g(async () => { if (now - hlCache.t > 2000) hlCache = { t: now, p: j('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"allMids"}' }) }; return (await hlCache.p)[s[2]]; }),
    g(async () => { if (now - lgCache.t > 2000) lgCache = { t: now, p: j('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails') }; return (await lgCache.p).order_book_details.find((o) => o.market_id === s[3])?.last_trade_price; }),
  ]);
  const q = { binance, coinbase, hyperliquid, lighter };
  const live = Object.values(q).filter((x) => Number.isFinite(x) && x > 0);
  return { ...q, median: median(live), sources: live.length };
}
export const divBps = (a, b) => (a > 0 && b > 0 ? Math.abs(a - b) / b * 10_000 : NaN);
