// Off-chain reference prices (Binance, Coinbase, Hyperliquid, Lighter): free public endpoints, no keys.
// SECONDARY CHECK ONLY. These numbers never reach the contracts and never set a fill or liquidation price; they only make
// this keeper SKIP marking a liquidation (and alert) when the on-chain oracle disagrees with the venues. Anyone else may still
// liquidate on-chain, so this can protect users from a bad-oracle liquidation by *this* keeper but can never censor or rug.
// Fills are deterministic (unique Pyth price per request), so on divergence the filler only ALERTS: skipping a fill cannot change
// its price and would only hand the trader a refund option.
const SYM = { BTC: { binance: 'BTCUSDT', coinbase: 'BTC-USD', hl: 'BTC', lighter: 1 }, ETH: { binance: 'ETHUSDT', coinbase: 'ETH-USD', hl: 'ETH', lighter: 0 }, SOL: { binance: 'SOLUSDT', coinbase: 'SOL-USD', hl: 'SOL', lighter: 2 } };
export const MARKET_SYMBOL = { 0: 'BTC', 1: 'ETH', 2: 'SOL' };

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export const divergenceBps = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (Math.abs(a - b) / b) * 10_000 : Infinity);

/// verdict for an on-chain price vs the venue median. Needs >= minSources live venues, else 'unknown' (no veto, alert only).
export function judge(onchain, quotes, { maxBps = 50, minSources = 2 } = {}) {
  const live = Object.values(quotes).filter((x) => Number.isFinite(x) && x > 0);
  const med = median(live);
  if (live.length < minSources) return { verdict: 'unknown', median: med, sources: live.length, bps: NaN };
  const bps = divergenceBps(onchain, med);
  return { verdict: bps <= maxBps ? 'ok' : 'diverged', median: med, sources: live.length, bps };
}

async function j(fetchFn, url, init, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetchFn(url, { ...init, signal: ctl.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

export async function fetchRefs(symbol, { fetchFn = fetch, timeoutMs = 3000 } = {}) {
  const s = SYM[symbol]; if (!s) return {};
  const get = async (name, fn) => { try { return [name, await fn()]; } catch { return [name, NaN]; } };
  const out = await Promise.all([
    get('binance', async () => Number((await j(fetchFn, `https://data-api.binance.vision/api/v3/ticker/price?symbol=${s.binance}`, {}, timeoutMs)).price)),
    get('coinbase', async () => Number((await j(fetchFn, `https://api.exchange.coinbase.com/products/${s.coinbase}/ticker`, {}, timeoutMs)).price)),
    get('hyperliquid', async () => Number((await j(fetchFn, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"allMids"}' }, timeoutMs))[s.hl])),
    get('lighter', async () => {
      const d = await j(fetchFn, 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails', {}, timeoutMs);
      return Number(d.order_book_details.find((o) => o.market_id === s.lighter)?.last_trade_price);
    }),
  ]);
  return Object.fromEntries(out);
}
