// SIMULATED counterparty traffic ("bot traders"). Fake accounts trading fake money against the simulated house so the pool has live activity.
// Not real users, not real flow. Deterministic given an rng (unit-tested).
import * as V from './venue.js';

export const RATES = { off: 0, low: 1 / 30, normal: 1 / 15, hot: 1 / 3 }; // expected opens per second
const LEVS = [[5, 25], [10, 20], [25, 20], [50, 15], [100, 10], [500, 5], [1000, 3], [5000, 1.5], [10000, 0.5]];

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Bots {
  constructor(rng = Math.random, saved = null) {
    this.rng = rng; this.enabled = saved?.enabled ?? true; this.rate = saved?.rate ?? 'normal';
    this.meta = saved?.meta ?? {}; this.log = saved?.log ?? []; this.last = 0;
  }
  toJSON() { return { enabled: this.enabled, rate: this.rate, meta: this.meta, log: this.log.slice(0, 30) }; }
  pickLev() { let r = this.rng() * LEVS.reduce((a, b) => a + b[1], 0); for (const [l, w] of LEVS) { if ((r -= w) <= 0) return l; } return 10; }
  note(e) { this.log.unshift({ t: e.t, ...e }); if (this.log.length > 40) this.log.length = 40; }

  /** One scheduler step. Returns the venue events for the bot account. Safe to call every feed tick. */
  step(ctx, marks, rates, now) {
    const dt = this.last ? Math.min(5, (now - this.last) / 1000) : 0; this.last = now;
    const bs = ctx.accts.bots, syms = Object.keys(marks).filter((s) => marks[s] > 0);
    V.topUpBots(ctx);
    const evs = V.tick(ctx, 'bots', marks, rates, now);
    for (const e of evs) {
      if (e.type === 'liquidation') this.note({ t: now, kind: 'liq', sym: e.rec.sym, side: e.rec.side, lev: e.rec.lev, notional: e.rec.size * e.rec.entry, pnl: e.rec.pnl });
      else if (e.type === 'adl' && e.acct === 'bots') this.note({ t: now, kind: 'adl', sym: e.rec.sym, side: e.rec.side, lev: e.rec.lev, notional: e.rec.size * e.rec.entry, pnl: e.rec.pnl });
    }
    if (!syms.length) return evs;
    // close due positions
    for (const p of [...bs.positions]) {
      const due = this.meta[p.id]?.until ?? 0;
      if (!this.enabled || now >= due) {
        const rec = V.close(ctx, 'bots', p.id, marks[p.sym] > 0 ? marks[p.sym] : p.mark, now, 'close', marks);
        if (rec) { delete this.meta[p.id]; this.note({ t: now, kind: 'close', sym: rec.sym, side: rec.side, lev: rec.lev, notional: rec.size * rec.entry, pnl: rec.pnl }); }
      }
    }
    if (!this.enabled || !(dt > 0)) return evs;
    const lam = RATES[this.rate] ?? 0;
    let n = 0; for (let k = 0; k < 3; k++) if (this.rng() < (lam * dt) / 3 * 1.0) n++;
    for (let i = 0; i < n; i++) this.openOne(ctx, syms, marks, rates, now, false);
    if (this.rng() < dt / 900) this.openOne(ctx, syms, marks, rates, now, true); // occasional "whale" (~1 per 15 min)
    return evs;
  }
  openOne(ctx, syms, marks, rates, now, whale) {
    const sym = syms[Math.floor(this.rng() * syms.length)], side = this.rng() < 0.5 ? 'long' : 'short';
    const lev = whale ? 200 + Math.floor(this.rng() * 800) : this.pickLev();
    const med = whale ? 25000 : 600, notional = Math.min(whale ? 40000 : 15000, med * Math.exp((this.rng() - 0.5) * 2.4)); // lognormal-ish around the median
    const margin = Math.max(1, Math.round((notional / lev) * 100) / 100);
    const r = V.open(ctx, 'bots', { sym, side, margin, lev, price: marks[sym], now, fundingRate: 0 }, marks);
    if (r.position) {
      this.meta[r.position.id] = { until: now + (whale ? 60 : 15) * 1000 + this.rng() * (whale ? 240 : 225) * 1000, whale };
      this.note({ t: now, kind: whale ? 'whale' : 'open', sym, side, lev, notional: margin * lev, pnl: null });
    }
    return r;
  }
}
