// Real price feed: Hyperliquid public API (WS allMids + REST metaAndAssetCtxs), Binance futures public REST fallback.
// Never fabricates prices: if both sources fail, status becomes 'offline' and trading is disabled by the app.
export const MARKETS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'ARB', 'LTC'];
const HL = 'https://api.hyperliquid.xyz/info';
const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const BN = 'https://fapi.binance.com';

export class Feed {
  constructor() {
    this.q = {};            // sym -> {mid, prev, funding}
    this.status = 'connecting'; // 'hl' | 'binance' | 'offline' | 'connecting'
    this.lastHL = 0; this.lastBN = 0;
    this.listeners = new Set();
    for (const s of MARKETS) this.q[s] = { mid: null, prev: null, funding: null };
  }
  on(fn) { this.listeners.add(fn); }
  emit() { for (const f of this.listeners) f(); }
  start() {
    this.pollHL(); setInterval(() => this.pollHL(), 15000);
    this.connectWS();
    setInterval(() => this.watchdog(), 3000);
    setTimeout(() => this.watchdog(), 6000);
  }
  setStatus() {
    const now = Date.now();
    let st;
    if (now - this.lastHL < 12000) st = 'hl';
    else if (now - this.lastBN < 12000) st = 'binance';
    else st = this.lastHL || this.lastBN ? 'offline' : (now - this.t0 > 15000 ? 'offline' : 'connecting');
    if (st !== this.status) { this.status = st; this.emit(); }
  }
  get t0() { return this._t0 ??= Date.now(); }
  async pollHL() {
    try {
      const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
      if (!r.ok) throw new Error(r.status);
      const [meta, ctxs] = await r.json();
      meta.universe.forEach((u, i) => {
        const q = this.q[u.name]; if (!q) return;
        const c = ctxs[i];
        const mid = Number(c.midPx ?? c.markPx);
        if (mid > 0) q.mid = mid;
        q.prev = Number(c.prevDayPx); q.funding = Number(c.funding); q.src = 'hl';
      });
      this.lastHL = Date.now(); this.setStatus(); this.emit();
    } catch (e) { this.setStatus(); }
  }
  connectWS() {
    try {
      const ws = new WebSocket(HL_WS); this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.channel !== 'allMids') return;
        const mids = m.data.mids; let any = false;
        for (const s of MARKETS) { const v = Number(mids[s]); if (v > 0) { this.q[s].mid = v; this.q[s].src = 'hl'; any = true; } }
        if (any) { this.lastHL = Date.now(); this.setStatus(); this.emit(); }
      };
      ws.onclose = () => setTimeout(() => this.connectWS(), 3000);
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch { setTimeout(() => this.connectWS(), 5000); }
  }
  async watchdog() {
    this.setStatus();
    if (Date.now() - this.lastHL > 8000) await this.pollBinance();
  }
  async pollBinance() {
    try {
      const r = await fetch(BN + '/fapi/v1/ticker/24hr');
      if (!r.ok) throw new Error(r.status);
      const arr = await r.json(); const by = {};
      for (const t of arr) by[t.symbol] = t;
      for (const s of MARKETS) {
        const t = by[s + 'USDT']; if (!t) continue;
        const q = this.q[s]; q.mid = Number(t.lastPrice); q.prev = Number(t.openPrice); q.src = 'binance';
      }
      this.lastBN = Date.now(); this.setStatus(); this.emit();
    } catch { this.setStatus(); }
  }
  price(s) { return this.status === 'offline' ? null : this.q[s]?.mid ?? null; }
  /** price usable for sim: only when a live source is fresh */
  marks() { const o = {}; if (this.status === 'hl' || this.status === 'binance') for (const s of MARKETS) if (this.q[s].mid > 0) o[s] = this.q[s].mid; return o; }
  rates() { const o = {}; for (const s of MARKETS) if (this.q[s].funding != null && this.q[s].src === 'hl') o[s] = this.q[s].funding; return o; }
  change24(s) { const q = this.q[s]; return q.mid && q.prev ? (q.mid / q.prev - 1) * 100 : null; }

  async candles(sym, interval, n = 240) {
    const ms = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 }[interval];
    const start = Date.now() - ms * n;
    try {
      const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: sym, interval, startTime: start } }) });
      if (!r.ok) throw 0;
      const a = await r.json();
      if (a.length) return a.map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));
    } catch {}
    try {
      const r = await fetch(`${BN}/fapi/v1/klines?symbol=${sym}USDT&interval=${interval}&limit=${n}`);
      const a = await r.json();
      return a.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    } catch { return []; }
  }
}
