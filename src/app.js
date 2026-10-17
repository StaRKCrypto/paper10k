import * as E from './engine.js';
import { Feed, MARKETS } from './feed.js';
import { Chart } from './chart.js';
import { renderCard } from './card.js';
import * as P from './pool.js';
import * as V from './venue.js';
import { Bots, RATES } from './bots.js';
import { drawLine } from './lpchart.js';

const $ = (id) => document.getElementById(id);
const KEY = 'paper10k.v1', RUNS = 'paper10k.runs.v1', NAME = 'paper10k.name';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const POOLKEY = 'paper10k.pool.v1';
let S = load(KEY, null); if (!S || S.v !== 1) S = E.newState();
// House / LP pool + simulated bot account persist together with the trader state. Migrates pre-pool saves (open margin becomes pool collateral).
let ctx = (() => {
  const sv = load(POOLKEY, null);
  if (sv?.pool?.v === 1 && sv.bots?.v === 1) { sv.pool.history ??= []; return { pool: sv.pool, accts: { user: S, bots: sv.bots } }; }
  const c = V.initCtx(S);
  for (const p of S.positions) { c.pool.collateral += p.margin; c.pool.ext += p.margin; }
  for (const o of S.orders) c.pool.ext += o.margin + E.fee(o.margin * o.lev);
  return c;
})();
const bots = new Bots(Math.random, load(POOLKEY, null)?.botCfg ?? null);
let lastMetrics = null, lastLevel = 'ok';
let runs = load(RUNS, []);
let name = localStorage.getItem(NAME) || 'anon-' + Math.random().toString(36).slice(2, 6);
const save = () => { localStorage.setItem(KEY, JSON.stringify(S)); localStorage.setItem(POOLKEY, JSON.stringify({ pool: ctx.pool, bots: ctx.accts.bots, botCfg: bots.toJSON() })); };
const lpVal = () => P.lpValue(ctx.pool, 'user', V.views(ctx), feed.marks());
const fullEquity = () => E.totalEquity(S, feed.marks()) + lpVal();

const usd = (n, d = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const px = (p) => p == null ? '—' : p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(5);
const cls = (n) => (n >= 0 ? 'up' : 'dn');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const feed = new Feed();
const chart = new Chart($('chart'));
let sym = 'BTC', side = 'long', otype = 'market', tab = 'pos', tf = '1m';

// ---------- toasts / modal
function toast(msg, bad) { const d = document.createElement('div'); d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = msg; $('toasts').append(d); setTimeout(() => d.remove(), 5000); }
function showCard(data, title, liq) {
  $('mBody').innerHTML = `<h2>${esc(title)}</h2><p class="muted">Paper trading · simulated funds · not financial advice</p>`;
  $('modal').querySelector('.mbox').classList.toggle('liqd', !!liq);
  renderCard($('cardCv'), data); $('modal').hidden = false; $('mDl').onclick = () => { const a = document.createElement('a'); a.download = 'paper10k-pnl.png'; a.href = $('cardCv').toDataURL('image/png'); a.click(); };
}
const closeModal = () => { $('modal').hidden = true; };
$('mClose').onclick = $('mOk').onclick = closeModal;
const cardForTrade = (r) => ({ title: r.sym + '-PERP', badge: `${r.side.toUpperCase()} ${r.lev}x`, side: r.side, pnl: r.pnl, pct: r.reason === 'liquidation' ? -100 : (r.pnl / r.margin) * 100, liq: r.reason === 'liquidation', ts: r.closedAt,
  lines: [`Entry ${px(r.entry)}  →  ${r.reason === 'liquidation' ? 'Liq' : 'Exit'} ${px(r.exit)}`, `Margin ${usd(r.margin)} · Fees ${usd(r.fees)} · Funding ${usd(r.funding)}`] });

// ---------- ticket
const levFromSlider = (v) => Math.max(1, Math.min(10000, Math.round(10 ** (v / 250))));
const sliderFromLev = (l) => Math.round(Math.log10(l) * 250);
const lev = () => Math.max(1, Math.min(10000, Math.round(+$('levNum').value || 1)));
function setLev(l) { $('levNum').value = l; $('levRange').value = sliderFromLev(l); $('levTxt').textContent = l + 'x'; updateTicket(); }
function entryPrice() { return otype === 'limit' ? +$('limitPx').value || null : feed.price(sym); }
function updateTicket() {
  const L = lev(), m = +$('margin').value || 0, e = entryPrice();
  $('availTxt').textContent = 'avail ' + usd(S.balance);
  const n = m * L, rate = feed.rates()[sym] ?? E.CFG.DEFAULT_FUNDING_HR;
  $('qEntry').textContent = e ? px(e) : '—'; $('qNot').textContent = usd(n);
  if (e && m > 0) {
    const size = E.sizeOf(m, L, e), lp = E.liqPrice(side, e, size, m);
    $('qSize').textContent = size.toPrecision(4) + ' ' + sym; $('qLiq').textContent = px(Math.max(0, lp));
    $('qDist').textContent = ((1 - E.CFG.MAINT) / L * 100).toFixed(L >= 100 ? 4 : 2) + '%';
  } else { $('qSize').textContent = $('qLiq').textContent = $('qDist').textContent = '—'; }
  $('qFee').textContent = usd(E.fee(n), 4); $('qFund').textContent = (rate * 100).toFixed(5) + '% (' + (side === 'long' ? 'long pays' : 'short pays') + (rate >= 0 === (side === 'long') ? '' : ' → receives') + ')';
  const r = $('riskNote'); r.className = 'risk';
  const mk = feed.marks(), capErr = e && m > 0 ? P.checkOpen(ctx.pool, V.views(ctx), mk, { sym, side, notional: n, lev: L }) : null;
  const mx = P.maxPositionNotional(Math.max(0, lastMetrics?.nav ?? 0), L, P.POOL_CFG.STRESS_CAP_MULT[lastMetrics?.level ?? 'ok']);
  $('qPool').textContent = 'max ' + usd(mx, 0) + ' notional';
  if (capErr) { r.className = 'risk on'; r.textContent = '🏦 House limit: ' + capErr; }
  else if (L >= 500) { r.className = 'risk on'; r.textContent = `☠ EXTREME RISK: at ${L}x a price move of just ${((1 - E.CFG.MAINT) / L * 100).toFixed(4)}% against you liquidates the whole margin. Normal tick noise can do this in seconds.`; }
  else if (L >= 50) { r.className = 'risk on mid'; r.textContent = `High leverage: a ${((1 - E.CFG.MAINT) / L * 100).toFixed(2)}% adverse move liquidates you.`; }
  const sb = $('submit'), live = feed.price(sym) != null;
  sb.className = 'go ' + side; sb.disabled = !live;
  sb.textContent = !live ? 'Feed offline — trading paused' : (otype === 'limit' ? 'Place limit ' : side === 'long' ? 'Buy / Long ' : 'Sell / Short ') + (otype === 'limit' ? side : '');
}
$('levRange').oninput = (e) => setLev(levFromSlider(+e.target.value));
$('levNum').oninput = () => { $('levTxt').textContent = lev() + 'x'; $('levRange').value = sliderFromLev(lev()); updateTicket(); };
$('levChips').onclick = (e) => e.target.tagName === 'BUTTON' && setLev(+e.target.textContent);
$('pcts').onclick = (e) => { const p = +e.target.dataset.p; if (!p) return; $('margin').value = (Math.floor(E.maxMargin(S.balance, lev()) * (p / 100) * 100) / 100); updateTicket(); };
$('margin').oninput = $('limitPx').oninput = updateTicket;
$('sideSeg').onclick = (e) => { if (!e.target.dataset.s) return; side = e.target.dataset.s; [...$('sideSeg').children].forEach((b) => b.classList.toggle('on', b === e.target)); updateTicket(); };
$('typeSeg').onclick = (e) => { if (!e.target.dataset.o) return; otype = e.target.dataset.o; [...$('typeSeg').children].forEach((b) => b.classList.toggle('on', b === e.target)); $('limitRow').hidden = otype !== 'limit'; if (otype === 'limit') $('limitPx').value = feed.price(sym) ?? ''; updateTicket(); };
$('submit').onclick = () => {
  const m = +$('margin').value, L = lev(), mark = feed.price(sym);
  if (mark == null) return toast('Feed offline — cannot trade', true);
  const o = { sym, side, margin: m, lev: L, price: mark, now: Date.now(), fundingRate: feed.rates()[sym] };
  const r = otype === 'market' ? V.open(ctx, 'user', o, feed.marks()) : V.placeLimit(ctx, 'user', { ...o, limitPrice: +$('limitPx').value }, feed.marks());
  if (r.error) return toast(r.error, true);
  toast(r.position ? `Opened ${side} ${sym} ${L}x @ ${px(mark)}` : `Limit ${side} ${sym} ${L}x @ ${px(+$('limitPx').value)} placed`);
  save(); render();
};

// ---------- markets & tabs
function renderMarkets() {
  $('mlist').innerHTML = MARKETS.map((s) => { const p = feed.q[s].mid, c = feed.change24(s);
    return `<div class="mrow ${s === sym ? 'on' : ''}" data-s="${s}"><div><b>${s}</b><small class="${c == null ? 'muted' : cls(c)}">${c == null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%'}</small></div><div class="pr">${px(p)}</div></div>`; }).join('');
}
$('mlist').onclick = (e) => { const r = e.target.closest('.mrow'); if (r) selectMarket(r.dataset.s); };
async function selectMarket(s) {
  sym = s; if (otype === 'limit') $('limitPx').value = feed.price(s) ?? '';
  const my = ++loadSeq; chart.set([], tf); const c = await feed.candles(s, tf); if (my === loadSeq) chart.set(c, tf); render();
}
let loadSeq = 0;
$('tfs').onclick = async (e) => { if (!e.target.dataset.tf) return; tf = e.target.dataset.tf; [...$('tfs').children].forEach((b) => b.classList.toggle('on', b === e.target)); const my = ++loadSeq; const c = await feed.candles(sym, tf); if (my === loadSeq) chart.set(c, tf); };
$('tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; [...$('tabs').children].forEach((x) => x.classList.toggle('on', x === b)); renderTab(); };

function renderTab() {
  const marks = feed.marks(); let h = '';
  const bodyEl = $('tabBody'); bodyEl.classList.toggle('lp', tab === 'lp');
  if (tab === 'lp') return renderLP();
  bodyEl.dataset.view = tab;
  if (tab === 'pos') {
    h = S.positions.length ? `<table><tr><th>Market</th><th>Side</th><th>Lev</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq. price</th><th>Margin</th><th>Funding</th><th>uPnL (ROE)</th><th></th></tr>` + S.positions.map((p) => {
      const m = marks[p.sym] ?? p.mark, u = E.upnl(p, m);
      return `<tr><td>${p.sym}</td><td class="${p.side === 'long' ? 'up' : 'dn'}">${p.side}</td><td>${p.lev}x</td><td>${p.size.toPrecision(4)}</td><td>${px(p.entry)}</td><td>${px(m)}</td><td class="dn">${px(E.posLiq(p))}</td><td>${usd(p.margin)}</td><td>${usd(p.funding, 4)}</td><td class="${cls(u)}">${usd(u)} (${(u / p.margin * 100).toFixed(1)}%)</td><td><button data-close="${p.id}">Close</button><button data-sharepos="${p.id}">📸</button></td></tr>`; }).join('') + '</table>' : '<div class="empty">No open positions. Open one from the ticket →</div>';
  } else if (tab === 'ord') {
    h = S.orders.length ? `<table><tr><th>Market</th><th>Side</th><th>Lev</th><th>Margin</th><th>Limit</th><th>Mark</th><th></th></tr>` + S.orders.map((o) => `<tr><td>${o.sym}</td><td class="${o.side === 'long' ? 'up' : 'dn'}">${o.side}</td><td>${o.lev}x</td><td>${usd(o.margin)}</td><td>${px(o.limitPrice)}</td><td>${px(marks[o.sym])}</td><td><button data-cancel="${o.id}">Cancel</button></td></tr>`).join('') + '</table>' : '<div class="empty">No open limit orders.</div>';
  } else if (tab === 'hist') {
    h = S.history.length ? `<table><tr><th>Closed</th><th>Market</th><th>Side</th><th>Lev</th><th>Entry</th><th>Exit</th><th>Fees</th><th>Funding</th><th>PnL</th><th>Reason</th><th></th></tr>` + S.history.slice(0, 100).map((r) => `<tr><td>${new Date(r.closedAt).toLocaleTimeString()}</td><td>${r.sym}</td><td class="${r.side === 'long' ? 'up' : 'dn'}">${r.side}</td><td>${r.lev}x</td><td>${px(r.entry)}</td><td>${px(r.exit)}</td><td>${usd(r.fees, 3)}</td><td>${usd(r.funding, 4)}</td><td class="${cls(r.pnl)}">${usd(r.pnl)}</td><td>${r.reason === 'liquidation' ? '💀 liquidated' : r.reason === 'adl' ? '⚖ auto-deleveraged' : 'closed'}${r.haircut > 0.005 ? ' · haircut ' + usd(r.haircut) : ''}</td><td><button data-sharehist="${r.id}">📸</button></td></tr>`).join('') + '</table>' : '<div class="empty">No trades yet.</div>';
  } else {
    const eq = fullEquity(), cur = { name, equity: eq, trades: S.history.length, liq: S.liquidations, current: true };
    const rows = [...runs, cur].sort((a, b) => b.equity - a.equity);
    h = `<div class="board"><p class="muted" style="padding:8px 10px;margin:0">Local leaderboard (this browser only). Finished runs are saved when you reset. Your name: <input id="nameIn" value="${esc(name)}" maxlength="16"></p><table><tr><th>#</th><th>Name</th><th>Final equity</th><th>Return</th><th>Trades</th><th>Liquidations</th></tr>` + rows.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.current ? ' <span class="muted">(live run)</span>' : ''}</td><td>${usd(r.equity)}</td><td class="${cls(r.equity - 1000)}">${((r.equity / 1000 - 1) * 100).toFixed(1)}%</td><td>${r.trades}</td><td>${r.liq}</td></tr>`).join('') + '</table></div>';
  }
  const body = $('tabBody'); if (tab === 'board' && document.activeElement?.id === 'nameIn') return;
  body.innerHTML = h;
  const ni = $('nameIn'); if (ni) ni.onchange = () => { name = ni.value.trim() || name; localStorage.setItem(NAME, name); };
}
$('tabBody').onclick = (e) => {
  const t = e.target, mark = (s) => feed.price(s);
  if (t.dataset.close) { const p = S.positions.find((x) => x.id == t.dataset.close); const m = p && mark(p.sym); if (!m) return toast('Feed offline — cannot close at a fake price', true); const r = V.close(ctx, 'user', p.id, m, Date.now(), 'close', feed.marks()); save(); render(); toast(`Closed ${r.sym} ${r.side}: ${usd(r.pnl)}${r.haircut > 0.005 ? ` (house haircut/cap ${usd(r.haircut)})` : ''}`, r.pnl < 0); showCard(cardForTrade(r), 'Trade closed'); }
  else if (t.dataset.cancel) { E.cancelOrder(S, +t.dataset.cancel); save(); render(); }
  else if (t.dataset.sharehist) { const r = S.history.find((x) => x.id == t.dataset.sharehist); showCard(cardForTrade(r), 'Share your trade', r.reason === 'liquidation'); }
  else if (t.dataset.sharepos) { const p = S.positions.find((x) => x.id == t.dataset.sharepos); const m = feed.price(p.sym) ?? p.mark, u = E.upnl(p, m); showCard({ title: p.sym + '-PERP', badge: `${p.side.toUpperCase()} ${p.lev}x (open)`, side: p.side, pnl: u, pct: u / p.margin * 100, ts: Date.now(), lines: [`Entry ${px(p.entry)}  Mark ${px(m)}`, `Margin ${usd(p.margin)} · Liq ${px(E.posLiq(p))}`] }, 'Open position'); }
};
$('btnShareAcct').onclick = () => { const eq = fullEquity(), pnl = eq - 1000; showCard({ title: name + "'s paper account", badge: '', pnl, pct: pnl / 10, ts: Date.now(), lines: [`Equity ${usd(eq)} (started $1,000.00)`, `${S.history.length} trades · ${S.liquidations} liquidations`] }, 'Account PnL'); };
$('btnBoard').onclick = () => { tab = 'board'; [...$('tabs').children].forEach((x) => x.classList.toggle('on', x.dataset.t === 'board')); renderTab(); $('tabs').scrollIntoView({ behavior: 'smooth' }); };
$('btnReset').onclick = () => {
  if (!confirm('Reset to $1,000 fake USD? Open positions are discarded; this run is saved to the local leaderboard.')) return;
  if (S.history.length || S.positions.length) { runs.push({ name, equity: fullEquity(), trades: S.history.length, liq: S.liquidations, ts: Date.now() }); runs = runs.sort((a, b) => b.equity - a.equity).slice(0, 50); localStorage.setItem(RUNS, JSON.stringify(runs)); }
  S = V.resetUser(ctx, feed.marks(), Date.now()); save(); render(); toast('Reset: $1,000 simulated balance' + (ctx.pool.shares.user > 1e-9 ? ' (your LP position is kept)' : ''));
};
$('heroClose').onclick = () => $('hero').classList.add('hide');


// ---------- house banner + LP tab
const LEVEL_TXT = {
  watch: (m) => `🏦 House pool WATCH — utilization ${(m.util * 100).toFixed(0)}%, drawdown ${(m.dd * 100).toFixed(1)}%. Limits are close.`,
  stress: (m) => `🏦 HOUSE POOL STRESSED — utilization ${(m.util * 100).toFixed(0)}%, drawdown ${(m.dd * 100).toFixed(1)}%. New-position caps halved${ctx.pool.haircutOn ? `; winning payouts haircut to ${(m.haircut * 100).toFixed(0)}% if the pool can't cover all winners` : ''}. Auto-deleverage armed.`,
  critical: (m) => `🚨 HOUSE POOL CRITICAL — ${m.nav <= 0 ? 'pool is empty' : 'limits breached'}. New net-exposure positions blocked; positions are being AUTO-DELEVERAGED at mark.`,
};
function renderBanner() {
  const m = lastMetrics, el = $('poolbar'); if (!m || m.level === 'ok') { el.hidden = true; return; }
  el.hidden = false; el.className = 'lvl-' + m.level; el.textContent = LEVEL_TXT[m.level](m) + (ctx.pool.stats.adl ? ` (ADL events so far: ${ctx.pool.stats.adl})` : '');
}
let lpMetric = 'nav';
const pct1 = (x) => (x * 100).toFixed(1) + '%';
function buildLP() {
  $('tabBody').innerHTML = `<div class="lp">
  <div class="lpnote">🧪 <b>SIMULATED house pool.</b> Seeded with ${usd(P.POOL_CFG.SEED, 0)} of fake money. Traders trade <i>against</i> it at the Hyperliquid mid with zero impact. Deposits/withdrawals move fake funds between your Available balance and the pool. Read HOUSE.md for the economics.</div>
  <div class="lpgrid">
    <div class="card"><label>Pool TVL (NAV)</label><b id="lpTvl">—</b><small id="lpTvlSub"></small></div>
    <div class="card"><label>Share price</label><b id="lpSp">—</b><small id="lpSpSub"></small></div>
    <div class="card"><label>Utilization</label><b id="lpUtil">—</b><div class="bar"><i id="lpBar"></i></div><small id="lpUtilSub"></small></div>
    <div class="card"><label>Cumulative PnL (realised)</label><b id="lpPnl">—</b><small id="lpPnlSub"></small></div>
    <div class="card"><label>Fee APR (est.)</label><b id="lpApr">—</b><small id="lpAprSub"></small></div>
    <div class="card"><label>Pool status</label><b id="lpLvl">—</b><small id="lpLvlSub"></small></div>
  </div>
  <div class="lpcols">
   <div class="lpleft">
    <div class="lphead"><span>Pool history</span><div class="seg small" id="lpSeg"><button data-m="nav" class="on">TVL</button><button data-m="sp">Share price</button><button data-m="pnl">Cum. PnL</button></div></div>
    <canvas id="lpChart"></canvas>
    <div class="tw"><table id="lpOi"></table></div>
   </div>
   <div class="lpright">
    <div class="card"><label>Your LP position (simulated)</label>
      <dl class="quote"><dt>Shares</dt><dd id="myShares">—</dd><dt>Value</dt><dd id="myVal">—</dd><dt>PnL vs deposited</dt><dd id="myPnl">—</dd><dt>Available to deposit</dt><dd id="myAvail">—</dd><dt>Max withdrawable now</dt><dd id="myMax">—</dd></dl>
      <input id="lpAmt" type="number" min="0" step="any" placeholder="amount (USD, simulated)" value="100">
      <div class="chips"><button id="lpDep" class="go long">Deposit</button><button id="lpWd" class="ghost">Withdraw</button><button id="lpAll" class="ghost">Max out</button></div>
      <p class="fine" id="lpMsg"></p></div>
    <div class="card"><label>Risk controls</label>
      <label class="chk"><input type="checkbox" id="lpHair"> Payout haircut when pool is stressed</label>
      <p class="fine">Caps: per-market per-side OI ≤ ${pct1(P.POOL_CFG.OI_CAP)} of pool · net exposure ≤ ${pct1(P.POOL_CFG.NET_CAP)} · position ≤ ${pct1(P.POOL_CFG.POS_CAP)} × leverage tier (≤100x 1 · ≤1000x ½ · 10000x ⅕). Stress halves them; auto-deleverage past +${pct1(P.POOL_CFG.ADL_TOL)}.</p>
      <button id="lpDrill" class="ghost">🧪 Stress drill: simulate a whale win (−20% of pool)</button></div>
    <div class="card"><label>🤖 Simulated bot traders <span class="simtag">SIMULATED · NOT REAL USERS</span></label>
      <label class="chk"><input type="checkbox" id="botOn"> Enabled</label> <select id="botRate"><option value="low">low</option><option value="normal">normal</option><option value="hot">hot</option></select>
      <p class="fine">Fake accounts with fake money trade randomly (mostly 5–100x, some up to 10000x) so the pool shows activity. Their flow is random, not representative of real traders.</p>
      <div id="botLog" class="botlog"></div></div>
   </div>
  </div></div>`;
  const body = $('tabBody');
  $('lpSeg').onclick = (e) => { if (!e.target.dataset.m) return; lpMetric = e.target.dataset.m; [...$('lpSeg').children].forEach((b) => b.classList.toggle('on', b === e.target)); renderLP(); };
  const msg = (t, bad) => { const m = $('lpMsg'); m.textContent = t; m.style.color = bad ? '#ff9aa9' : '#7ee0b5'; };
  $('lpDep').onclick = () => { const r = V.lpDeposit(ctx, +$('lpAmt').value, feed.marks()); if (r.error) return msg(r.error, true); save(); msg(`Deposited ${usd(+$('lpAmt').value)} (simulated) at share price ${r.price.toFixed(6)}`); render(); };
  $('lpWd').onclick = () => { const r = V.lpWithdraw(ctx, +$('lpAmt').value, feed.marks()); if (r.error) return msg(r.error, true); save(); msg(`Withdrew ${usd(+$('lpAmt').value)} (simulated)`); render(); };
  $('lpAll').onclick = () => { const mx = P.maxWithdraw(ctx.pool, 'user', V.views(ctx), feed.marks()); if (mx <= 0) return msg('Nothing withdrawable right now', true); const r = V.lpWithdraw(ctx, Math.floor(mx * 100) / 100, feed.marks()); if (r.error) return msg(r.error, true); save(); msg('Withdrew ' + usd(Math.floor(mx * 100) / 100)); render(); };
  $('lpHair').onchange = (e) => { ctx.pool.haircutOn = e.target.checked; save(); };
  $('lpDrill').onclick = () => { const a = V.stressDrill(ctx, 0.2); P.sample(ctx.pool, V.views(ctx), feed.marks(), Date.now(), true); save(); toast(`Stress drill: a simulated whale won ${usd(a, 0)} from the pool`, true); render(); };
  $('botOn').onchange = (e) => { bots.enabled = e.target.checked; save(); };
  $('botRate').onchange = (e) => { bots.rate = e.target.value; save(); };
  body.dataset.view = 'lp';
  $('lpHair').checked = ctx.pool.haircutOn; $('botOn').checked = bots.enabled; $('botRate').value = bots.rate;
}
function renderLP() {
  if ($('tabBody').dataset.view !== 'lp') buildLP();
  const marks = feed.marks(), views = V.views(ctx), m = lastMetrics ?? P.metrics(ctx.pool, views, marks), pool = ctx.pool, set = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
  set('lpTvl', usd(m.nav, 0)); set('lpTvlSub', `assets ${usd(pool.assets, 0)} · trader margin held ${usd(pool.collateral, 0)}`);
  set('lpSp', m.sp.toFixed(6)); set('lpSpSub', `peak ${pool.peakSp.toFixed(6)} · drawdown ${pct1(m.dd)}`);
  set('lpUtil', isFinite(m.util) ? pct1(m.util) : '∞'); $('lpBar').style.width = Math.min(100, m.util * 100) + '%'; $('lpBar').className = 'lvl-' + m.level;
  set('lpUtilSub', `net ${usd(m.exposure.net, 0)} / ${usd(m.caps.net, 0)} cap`);
  const cum = pool.fees + pool.trading; set('lpPnl', usd(cum, 2)); $('lpPnl').className = cls(cum); set('lpPnlSub', `fees ${usd(pool.fees, 2)} · trader PnL taken ${usd(pool.trading, 2)} · ${pool.stats.opens} opens`);
  const apr = P.feeApr(pool); set('lpApr', apr ? (apr.fee * 100).toFixed(1) + '%' : '—'); set('lpAprSub', apr ? `last ${Math.max(1, Math.round(apr.windowMs / 60000))} min, annualised, fees only (incl. PnL ${(apr.pnl * 100).toFixed(0)}%) — volatile, bot-driven` : 'needs ~30 s of history');
  set('lpLvl', m.level.toUpperCase()); $('lpLvl').className = 'lvl-t-' + m.level; set('lpLvlSub', `haircut ${ctx.pool.haircutOn ? (m.haircut >= 1 ? 'armed (paying 100%)' : 'ACTIVE ' + pct1(m.haircut)) : 'off'} · liq ${pool.stats.liqs} · ADL ${pool.stats.adl}`);
  const sh = pool.shares.user ?? 0, val = lpVal(), cost = pool.cost?.user ?? 0;
  set('myShares', sh.toFixed(4)); set('myVal', usd(val)); set('myPnl', usd(val - cost) + (cost > 0 ? ` (${((val / cost - 1) * 100).toFixed(2)}%)` : '')); set('myAvail', usd(S.balance)); set('myMax', usd(P.maxWithdraw(pool, 'user', views, marks)));
  const pts = pool.history.map((h) => ({ t: h.t, v: lpMetric === 'nav' ? h.nav : lpMetric === 'sp' ? h.sp : h.pnl }));
  drawLine($('lpChart'), pts, { fmt: lpMetric === 'sp' ? (v) => v.toFixed(5) : (v) => usd(v, lpMetric === 'nav' ? 0 : 2), baseline: lpMetric === 'nav' ? null : lpMetric === 'sp' ? 1 : 0, color: lpMetric === 'pnl' && cum < 0 ? '#ff4d6a' : '#21e6a1' });
  const rows = Object.entries(m.exposure.per).sort((a, b) => b[1].long + b[1].short - a[1].long - a[1].short);
  const oi = `<tr><th>Market</th><th>Trader long OI</th><th>Trader short OI</th><th>Pool net (opposite)</th><th>Side cap</th></tr>` + (rows.length ? rows.map(([s, e]) => { const net = e.long - e.short; return `<tr><td>${s}</td><td>${usd(e.long, 0)}</td><td>${usd(e.short, 0)}</td><td class="${cls(net)}">pool is ${net >= 0 ? 'short' : 'long'} ${usd(Math.abs(net), 0)}</td><td>${usd(m.caps.oi, 0)}</td></tr>`; }).join('') : `<tr><td colspan="5" class="empty">No open interest yet.</td></tr>`);
  if ($('lpOi').innerHTML !== oi) $('lpOi').innerHTML = oi;
  const lg = bots.log.slice(0, 12).map((e) => `<div><span class="simtag">BOT</span> ${new Date(e.t).toLocaleTimeString()} ${e.kind === 'liq' ? '💀 liq' : e.kind === 'close' ? 'closed' : e.kind === 'adl' ? '⚖ ADL' : e.kind === 'whale' ? '🐋 opened' : 'opened'} <b class="${e.side === 'long' ? 'up' : 'dn'}">${e.side}</b> ${e.sym} ${e.lev}x ${usd(e.notional, 0)}${e.pnl != null ? ` <span class="${cls(e.pnl)}">${usd(e.pnl)}</span>` : ''}</div>`).join('');
  const out = bots.enabled ? (lg || '<div class="muted">waiting for first simulated bot trade…</div>') : '<div class="muted">Bots disabled — no simulated flow.</div>';
  if ($('botLog').innerHTML !== out) $('botLog').innerHTML = out;
}

// ---------- render loop
function render() {
  lastMetrics = P.metrics(ctx.pool, V.views(ctx), feed.marks());
  const marks = feed.marks(), eq = fullEquity(), pnl = eq - E.CFG.START_BALANCE;
  $('hEquity').textContent = usd(eq); $('hBal').textContent = usd(S.balance); const hp = $('hPnl'); hp.textContent = usd(pnl); hp.className = cls(pnl);
  const st = feed.status, pill = $('feedPill');
  pill.className = 'pill ' + st; pill.textContent = st === 'hl' ? '● live · Hyperliquid' : st === 'binance' ? '● fallback · Binance' : st === 'offline' ? '● feed offline' : 'connecting…';
  const off = $('offline'); off.hidden = st !== 'offline' && st !== 'binance';
  off.style.background = st === 'binance' ? '#8a5a00' : ''; off.textContent = st === 'offline' ? '⛔ FEED OFFLINE — no live price source reachable. Prices are NOT being simulated; trading, liquidation checks and limit fills are paused until the feed returns.' : st === 'binance' ? '⚠ Hyperliquid unreachable — using Binance public prices as fallback.' : '';
  const p = feed.price(sym), c = feed.change24(sym);
  $('mSym').textContent = sym + '-PERP'; $('mPrice').textContent = px(p); const ch = $('mChg'); ch.textContent = c == null ? '24h —' : '24h ' + (c >= 0 ? '+' : '') + c.toFixed(2) + '%'; ch.className = 'chg ' + (c == null ? '' : cls(c));
  const f = feed.rates()[sym]; $('mFund').textContent = f != null ? `funding ${(f * 100).toFixed(5)}%/h` : '';
  $('nPos').textContent = S.positions.length; $('nOrd').textContent = S.orders.length;
  chart.lines = [...S.positions.filter((x) => x.sym === sym).flatMap((x) => [{ price: x.entry, color: '#5ab8ff', label: `${x.side} ${x.lev}x entry` }, { price: E.posLiq(x), color: '#ff4d6a', label: 'LIQ' }]), ...S.orders.filter((o) => o.sym === sym).map((o) => ({ price: o.limitPrice, color: '#ffb020', label: 'limit' }))];
  renderBanner(); renderMarkets(); renderTab(); updateTicket(); chart.draw();
}
let lastTick = 0, pending = false;
function onFeed() {
  const now = Date.now(); const pr = feed.price(sym); if (pr) chart.tick(pr, now);
  const marks = feed.marks();
  if (Object.keys(marks).length) {
    const ev = V.tick(ctx, 'user', marks, feed.rates(), now);
    S = ctx.accts.user;
    bots.step(ctx, marks, feed.rates(), now);
    lastMetrics = P.sample(ctx.pool, V.views(ctx), marks, now);
    if (lastMetrics.level !== lastLevel) { if (lastMetrics.level === 'stress' || lastMetrics.level === 'critical') toast(`🏦 House pool ${lastMetrics.level.toUpperCase()}: caps tightened${ctx.pool.haircutOn ? ', payout haircut armed' : ''}`, true); lastLevel = lastMetrics.level; }
    const mine = ev.filter((e) => e.acct === 'user' || e.acct === undefined);
    if (mine.length) {
      save();
      for (const e of mine) {
        if (e.type === 'fill') toast(`Limit filled: ${e.position.side} ${e.position.sym} ${e.position.lev}x @ ${px(e.position.entry)}`);
        else if (e.type === 'reject') toast(`Limit order rejected by house limits: ${e.reason} (refunded)`, true);
        else if (e.type === 'adl') { toast(`⚖ AUTO-DELEVERAGED ${e.rec.sym} ${e.rec.side} ${e.rec.lev}x at mark — pool risk limit (${usd(e.rec.pnl)})`, true); }
        else if (e.type === 'liquidation') { const r = e.rec; toast(`💀 LIQUIDATED ${r.sym} ${r.side} ${r.lev}x — lost ${usd(r.margin)}`, true); showCard(cardForTrade(r), '💀 LIQUIDATED', true); }
      }
    }
  }
  if (now - lastTick > 250) { lastTick = now; render(); } else if (!pending) { pending = true; setTimeout(() => { pending = false; lastTick = Date.now(); render(); }, 260); }
}
feed.on(onFeed);
setLev(100); feed.start(); selectMarket('BTC'); render();
setInterval(save, 5000);
window.addEventListener('beforeunload', save);
