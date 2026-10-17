import * as E from './engine.js';
import { Feed, MARKETS } from './feed.js';
import { Chart } from './chart.js';
import { renderCard } from './card.js';

const $ = (id) => document.getElementById(id);
const KEY = 'paper10k.v1', RUNS = 'paper10k.runs.v1', NAME = 'paper10k.name';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
let S = load(KEY, null); if (!S || S.v !== 1) S = E.newState();
let runs = load(RUNS, []);
let name = localStorage.getItem(NAME) || 'anon-' + Math.random().toString(36).slice(2, 6);
const save = () => localStorage.setItem(KEY, JSON.stringify(S));

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
  if (L >= 500) { r.className = 'risk on'; r.textContent = `☠ EXTREME RISK: at ${L}x a price move of just ${((1 - E.CFG.MAINT) / L * 100).toFixed(4)}% against you liquidates the whole margin. Normal tick noise can do this in seconds.`; }
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
  const r = otype === 'market' ? E.openMarket(S, o) : E.placeLimit(S, { ...o, limitPrice: +$('limitPx').value });
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
  if (tab === 'pos') {
    h = S.positions.length ? `<table><tr><th>Market</th><th>Side</th><th>Lev</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq. price</th><th>Margin</th><th>Funding</th><th>uPnL (ROE)</th><th></th></tr>` + S.positions.map((p) => {
      const m = marks[p.sym] ?? p.mark, u = E.upnl(p, m);
      return `<tr><td>${p.sym}</td><td class="${p.side === 'long' ? 'up' : 'dn'}">${p.side}</td><td>${p.lev}x</td><td>${p.size.toPrecision(4)}</td><td>${px(p.entry)}</td><td>${px(m)}</td><td class="dn">${px(E.posLiq(p))}</td><td>${usd(p.margin)}</td><td>${usd(p.funding, 4)}</td><td class="${cls(u)}">${usd(u)} (${(u / p.margin * 100).toFixed(1)}%)</td><td><button data-close="${p.id}">Close</button><button data-sharepos="${p.id}">📸</button></td></tr>`; }).join('') + '</table>' : '<div class="empty">No open positions. Open one from the ticket →</div>';
  } else if (tab === 'ord') {
    h = S.orders.length ? `<table><tr><th>Market</th><th>Side</th><th>Lev</th><th>Margin</th><th>Limit</th><th>Mark</th><th></th></tr>` + S.orders.map((o) => `<tr><td>${o.sym}</td><td class="${o.side === 'long' ? 'up' : 'dn'}">${o.side}</td><td>${o.lev}x</td><td>${usd(o.margin)}</td><td>${px(o.limitPrice)}</td><td>${px(marks[o.sym])}</td><td><button data-cancel="${o.id}">Cancel</button></td></tr>`).join('') + '</table>' : '<div class="empty">No open limit orders.</div>';
  } else if (tab === 'hist') {
    h = S.history.length ? `<table><tr><th>Closed</th><th>Market</th><th>Side</th><th>Lev</th><th>Entry</th><th>Exit</th><th>Fees</th><th>Funding</th><th>PnL</th><th>Reason</th><th></th></tr>` + S.history.slice(0, 100).map((r) => `<tr><td>${new Date(r.closedAt).toLocaleTimeString()}</td><td>${r.sym}</td><td class="${r.side === 'long' ? 'up' : 'dn'}">${r.side}</td><td>${r.lev}x</td><td>${px(r.entry)}</td><td>${px(r.exit)}</td><td>${usd(r.fees, 3)}</td><td>${usd(r.funding, 4)}</td><td class="${cls(r.pnl)}">${usd(r.pnl)}</td><td>${r.reason === 'liquidation' ? '💀 liquidated' : 'closed'}</td><td><button data-sharehist="${r.id}">📸</button></td></tr>`).join('') + '</table>' : '<div class="empty">No trades yet.</div>';
  } else {
    const eq = E.totalEquity(S, marks), cur = { name, equity: eq, trades: S.history.length, liq: S.liquidations, current: true };
    const rows = [...runs, cur].sort((a, b) => b.equity - a.equity);
    h = `<div class="board"><p class="muted" style="padding:8px 10px;margin:0">Local leaderboard (this browser only). Finished runs are saved when you reset. Your name: <input id="nameIn" value="${esc(name)}" maxlength="16"></p><table><tr><th>#</th><th>Name</th><th>Final equity</th><th>Return</th><th>Trades</th><th>Liquidations</th></tr>` + rows.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.current ? ' <span class="muted">(live run)</span>' : ''}</td><td>${usd(r.equity)}</td><td class="${cls(r.equity - 1000)}">${((r.equity / 1000 - 1) * 100).toFixed(1)}%</td><td>${r.trades}</td><td>${r.liq}</td></tr>`).join('') + '</table></div>';
  }
  const body = $('tabBody'); if (tab === 'board' && document.activeElement?.id === 'nameIn') return;
  body.innerHTML = h;
  const ni = $('nameIn'); if (ni) ni.onchange = () => { name = ni.value.trim() || name; localStorage.setItem(NAME, name); };
}
$('tabBody').onclick = (e) => {
  const t = e.target, mark = (s) => feed.price(s);
  if (t.dataset.close) { const p = S.positions.find((x) => x.id == t.dataset.close); const m = p && mark(p.sym); if (!m) return toast('Feed offline — cannot close at a fake price', true); const r = E.closePosition(S, p.id, m, Date.now()); save(); render(); toast(`Closed ${r.sym} ${r.side}: ${usd(r.pnl)}`, r.pnl < 0); showCard(cardForTrade(r), 'Trade closed'); }
  else if (t.dataset.cancel) { E.cancelOrder(S, +t.dataset.cancel); save(); render(); }
  else if (t.dataset.sharehist) { const r = S.history.find((x) => x.id == t.dataset.sharehist); showCard(cardForTrade(r), 'Share your trade', r.reason === 'liquidation'); }
  else if (t.dataset.sharepos) { const p = S.positions.find((x) => x.id == t.dataset.sharepos); const m = feed.price(p.sym) ?? p.mark, u = E.upnl(p, m); showCard({ title: p.sym + '-PERP', badge: `${p.side.toUpperCase()} ${p.lev}x (open)`, side: p.side, pnl: u, pct: u / p.margin * 100, ts: Date.now(), lines: [`Entry ${px(p.entry)}  Mark ${px(m)}`, `Margin ${usd(p.margin)} · Liq ${px(E.posLiq(p))}`] }, 'Open position'); }
};
$('btnShareAcct').onclick = () => { const eq = E.totalEquity(S, feed.marks()), pnl = eq - 1000; showCard({ title: name + "'s paper account", badge: '', pnl, pct: pnl / 10, ts: Date.now(), lines: [`Equity ${usd(eq)} (started $1,000.00)`, `${S.history.length} trades · ${S.liquidations} liquidations`] }, 'Account PnL'); };
$('btnBoard').onclick = () => { tab = 'board'; [...$('tabs').children].forEach((x) => x.classList.toggle('on', x.dataset.t === 'board')); renderTab(); $('tabs').scrollIntoView({ behavior: 'smooth' }); };
$('btnReset').onclick = () => {
  if (!confirm('Reset to $1,000 fake USD? Open positions are discarded; this run is saved to the local leaderboard.')) return;
  if (S.history.length || S.positions.length) { runs.push({ name, equity: E.totalEquity(S, feed.marks()), trades: S.history.length, liq: S.liquidations, ts: Date.now() }); runs = runs.sort((a, b) => b.equity - a.equity).slice(0, 50); localStorage.setItem(RUNS, JSON.stringify(runs)); }
  S = E.newState(); save(); render(); toast('Reset: $1,000 simulated balance');
};
$('heroClose').onclick = () => $('hero').classList.add('hide');

// ---------- render loop
function render() {
  const marks = feed.marks(), eq = E.totalEquity(S, marks), pnl = eq - E.CFG.START_BALANCE;
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
  renderMarkets(); renderTab(); updateTicket(); chart.draw();
}
let lastTick = 0, pending = false;
function onFeed() {
  const now = Date.now(); const pr = feed.price(sym); if (pr) chart.tick(pr, now);
  const marks = feed.marks();
  if (Object.keys(marks).length) {
    const ev = E.tick(S, marks, feed.rates(), now);
    if (ev.length) { save(); for (const e of ev) { if (e.type === 'fill') toast(`Limit filled: ${e.position.side} ${e.position.sym} ${e.position.lev}x @ ${px(e.position.entry)}`); else { const r = e.rec; toast(`💀 LIQUIDATED ${r.sym} ${r.side} ${r.lev}x — lost ${usd(r.margin)}`, true); showCard(cardForTrade(r), '💀 LIQUIDATED', true); } } }
  }
  if (now - lastTick > 250) { lastTick = now; render(); } else if (!pending) { pending = true; setTimeout(() => { pending = false; lastTick = Date.now(); render(); }, 260); }
}
feed.on(onFeed);
setLev(100); feed.start(); selectMarket('BTC'); render();
setInterval(save, 5000);
