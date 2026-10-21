// Seasons tab: renders the static seasons.json written by keeper/src/indexer.mjs. Off-chain, informational; PAPER10KX score has no cash value.
import { SEASONS_URL } from './config.js';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const num = (s, d) => { const b = BigInt(s); const neg = b < 0n; const a = neg ? -b : b; const i = a / 10n ** BigInt(d), f = (a % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, 2); return (neg ? '-' : '') + i.toLocaleString('en-US') + '.' + f; };
let cache = null, at = 0;
export async function loadSeasons() {
  if (cache && Date.now() - at < 60_000) return cache;
  try { const r = await fetch(SEASONS_URL, { cache: 'no-store' }); cache = r.ok ? await r.json() : { error: `no ${SEASONS_URL} published yet (run keeper/src/indexer.mjs)` }; }
  catch (e) { cache = { error: e.message }; }
  at = Date.now(); return cache;
}
export function seasonsHtml(j, me, dec = 6) {
  if (!j) return '<p class="muted">loading…</p>';
  if (j.error) return `<p class="muted">${esc(j.error)}</p>`;
  const now = Date.now() / 1000; let h = '';
  for (const [id, s] of Object.entries(j.seasons || {})) {
    const live = now >= s.season.start && now < s.season.end;
    h += `<h4>${esc(s.season.name)} ${live ? '<span class="up">● live</span>' : ''}</h4>`;
    const c = s.competitions || {};
    h += `<p class="fine">🏆 Top PnL: ${c.topPnl ? short(c.topPnl.addr) + ' ' + num(c.topPnl.value, dec) : '—'} · 💰 Biggest win: ${c.biggestWin ? short(c.biggestWin.addr) : '—'} · 💀 Most rekts: ${c.mostRekts ? short(c.mostRekts.addr) + ' ×' + c.mostRekts.value : '—'}</p>`;
    h += `<div class="tblwrap"><table class="tbl"><tr><th>#</th><th>Trader</th><th>Score</th><th>PnL</th><th>Trades</th><th>Rekts</th></tr>`;
    s.rows.slice(0, 50).forEach((r, i) => {
      h += `<tr class="${me && r.addr === me.toLowerCase() ? 'me' : ''}"><td>${i + 1}</td><td><code>${short(r.addr)}</code></td><td>${num(r.score, 18)}</td><td class="${BigInt(r.pnl) >= 0n ? 'up' : 'dn'}">${num(r.pnl, dec)}</td><td>${r.trades}</td><td>${r.rekts}</td></tr>`;
    });
    h += `</table></div>`;
  }
  return h + `<p class="fine">Computed off-chain from exchange events (updated ${j.generatedAt ? new Date(j.generatedAt * 1000).toLocaleString() : '—'}). Score = PAPER10KX earned in the season; it has <b>no cash value</b> and no prize is implied unless separately announced.</p>`;
}
