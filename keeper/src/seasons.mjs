// Pure season / leaderboard / competition math over decoded exchange events. No I/O. PAPER10KX is a SCORE only (no cash value).
// events: [{ name: 'Opened'|'Closed'|'Liquidated', ts: <unix s>, args: {...bigints/addresses} }]
// seasons: [{ id, name, start, end }] (unix seconds, end exclusive)
const lc = (a) => String(a).toLowerCase();

export function seasonOf(ts, seasons) { return seasons.find((s) => ts >= s.start && ts < s.end) || null; }

function blank(addr) {
  return { addr, trades: 0, volume: 0n, pnl: 0n, wins: 0, losses: 0, rekts: 0, score: 0n, bestWin: 0n };
}

/** @returns {{ [seasonId]: { season, rows: Row[], competitions: {...} } }} rows sorted by score desc then pnl desc */
export function computeSeasons(events, seasons, { minHoldTrades = 1 } = {}) {
  const out = {};
  for (const s of seasons) out[s.id] = { season: s, by: new Map() };
  for (const e of events) {
    const s = seasonOf(Number(e.ts), seasons); if (!s) continue;
    const by = out[s.id].by; const u = lc(e.args.user);
    const r = by.get(u) ?? blank(u); by.set(u, r);
    if (e.name === 'Opened') { r.trades++; r.volume += BigInt(e.args.notional); }
    else if (e.name === 'Closed') {
      const win = BigInt(e.args.profitPaid) + BigInt(e.args.profitQueued), loss = BigInt(e.args.loss);
      r.pnl += win - loss; if (win > 0n) { r.wins++; if (win > r.bestWin) r.bestWin = win; } else if (loss > 0n) r.losses++;
    } else if (e.name === 'Liquidated') {
      r.rekts++; r.losses++; r.pnl -= BigInt(e.args.margin); r.score += BigInt(e.args.minted);
    }
  }
  const res = {};
  for (const [id, { season, by }] of Object.entries(out)) {
    const rows = [...by.values()].filter((r) => r.trades >= minHoldTrades);
    rows.sort((a, b) => (b.score === a.score ? (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0) : b.score > a.score ? 1 : -1));
    const top = (key) => { const c = [...rows].sort((a, b) => (b[key] > a[key] ? 1 : b[key] < a[key] ? -1 : 0))[0]; return c && c[key] > 0 ? { addr: c.addr, value: c[key] } : null; };
    res[id] = { season, rows, competitions: { topPnl: top('pnl'), biggestWin: top('bestWin'), mostRekts: top('rekts'), topVolume: top('volume') } };
  }
  return res;
}

/** JSON-safe (bigint -> decimal string) */
export const toJSON = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
