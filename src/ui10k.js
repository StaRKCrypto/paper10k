// 10kx UI shell: landing (ASCII canvas, ticker, live card), nav/view switching, mirrors. Original code, no external assets.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const body = document.body;
let raf = 0, mx = -1, my = -1;
const RAMP = ' .·:-=+*xX#%@';
const feed = () => window.__10kx?.feed;
const SYMS = ['BTC', 'ETH', 'SOL', 'HYPE', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'ARB', 'LTC'];
const fmt = (p) => p == null ? '—' : p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p >= 10 ? p.toFixed(2) : p.toFixed(4);

// ---------- views
function setView(v) { body.dataset.view = v; localStorage.setItem('10kx.seen', '1'); window.scrollTo(0, 0); if (v === 'landing') { $('#ascii') && startAscii(); } else stopAscii(); syncNav(); }
function syncNav() {
  const inChain = body.dataset.mode === 'chain';
  $$('#navLinks button').forEach((b) => b.classList.toggle('on', b.dataset.go === (inChain ? (window.__p10kStake ? 'stake' : 'chain') : 'trade') && body.dataset.view === 'app'));
  const pill = $('#netPill'); if (!pill) return;
  if (inChain) { const t = $('#chainpanel .cbanner'); const main = t?.classList.contains('main'); pill.textContent = main ? 'MAINNET' : 'Testnet'; pill.className = 'pill ' + (main ? 'main' : 'test'); } else { pill.textContent = 'Simulator'; pill.className = 'pill sim'; }
}
const chainBtn = (m) => $(`#chainbar button[data-m=${m}]`);
function go(what) {
  if (what !== 'chain' && body.dataset.mode === 'chain') chainBtn('sim')?.click();
  setView('app');
  window.__p10kStake = what === 'stake';
  if (what === 'stake') { chainBtn('chain')?.click(); setView('app'); window.dispatchEvent(new CustomEvent('p10k:tab', { detail: 'stake' })); }
  if (what === 'chain') { chainBtn('chain')?.click(); setView('app'); }
  else if (['pos', 'lp', 'board'].includes(what)) { $(`#tabs button[data-t=${what}]`)?.click(); setTimeout(() => $('#tabs').scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); }
  setTimeout(syncNav, 50);
}
$('#navLinks').addEventListener('click', (e) => { const b = e.target.closest('button[data-go]'); if (b) go(b.dataset.go); });
$('#goTrade').onclick = () => go('trade');
$('#goChain').onclick = () => go('chain');
$('#btnConnect').onclick = () => { go('chain'); setTimeout(() => $('#chainpanel [data-act=injected]')?.focus(), 400); };
$('#logo').onclick = (e) => { e.preventDefault(); if (body.dataset.mode === 'chain') chainBtn('sim')?.click(); setView('landing'); };
setInterval(syncNav, 700);
// deep links
const h = location.hash;
if (h === '#stake') go('stake'); else if (h === '#onchain') go('chain'); else if (h === '#trade' || localStorage.getItem('10kx.seen') === '1' && h !== '#home') setView('app'); else setView('landing');
// the on-chain toggle bar lives under the nav
const moveChain = () => { const c = $('#chainbar'), pn = $('#chainpanel'), slot = $('#chainbarSlot'); if (!c || !pn || !slot) return false; slot.replaceWith(c); c.after(pn); return true; };
if (!moveChain()) new MutationObserver((_, o) => { if (moveChain()) o.disconnect(); }).observe(body, { childList: true });

// ---------- mirrors into the ticket
setInterval(() => $$('[data-mirror]').forEach((el) => { const s = $('#' + el.dataset.mirror); if (s && el.textContent !== s.textContent) { el.textContent = s.textContent; el.className = s.className; } }), 500);

// ---------- ticker (own animation, reads shared feed)
const track = $('#tickTrack');
function tickHtml() { const f = feed(); return SYMS.map((s) => { const p = f?.price?.(s); if (p == null) return ''; const q = f.q?.[s]; const chg = q?.prev ? (p / q.prev - 1) * 100 : null; return `<span><b>${s}</b> ${fmt(p)}${chg == null ? '' : ` <i class="${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</i>`}</span>`; }).join(''); }
let lastTick = '';
function updTicker() { const t = tickHtml() || '<span><b>10kx</b> waiting for live prices…</span>'; if (t !== lastTick) { lastTick = t; track.innerHTML = t + t; } }
setInterval(updTicker, 1500); updTicker();

// ---------- landing live card
const hist = [];
function updCard() {
  const f = feed(); const p = f?.price?.('BTC'); if (p == null) return;
  hist.push(p); if (hist.length > 120) hist.shift();
  $('#lcPx').textContent = '$' + fmt(p);
  const q = f.q?.BTC; if (q?.prev) { const c = (p / q.prev - 1) * 100; const el = $('#lcChg'); el.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%'; el.className = 'chg ' + (c >= 0 ? 'up' : 'dn'); }
  $('#lcLiq').textContent = '$' + fmt(p * (1 - 0.9 / 10000)) + '  (−0.009%)';
  const cv = $('#lcChart'), r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d;
  const x = cv.getContext('2d'); x.scale(d, d); const W = r.width, H = r.height;
  const lo = Math.min(...hist) * 0.99998, hi = Math.max(...hist) * 1.00002, Y = (v) => H - 14 - ((v - lo) / (hi - lo || 1)) * (H - 28);
  const liq = p * (1 - 0.9 / 10000); x.strokeStyle = '#ff5d73'; x.setLineDash([4, 4]); x.beginPath(); const ly = Math.min(H - 4, Math.max(4, Y(Math.max(liq, lo)))); x.moveTo(0, ly); x.lineTo(W, ly); x.stroke(); x.setLineDash([]);
  x.strokeStyle = '#d4ff3a'; x.lineWidth = 1.6; x.beginPath(); hist.forEach((v, i) => { const px = (i / Math.max(1, hist.length - 1)) * W; i ? x.lineTo(px, Y(v)) : x.moveTo(px, Y(v)); }); x.stroke();
}
setInterval(updCard, 1000);

// ---------- ASCII canvas: original density-field renderer (waves + drifting "candles" + pointer ripple)
function startAscii() {
  const cv = $('#ascii'); if (!cv || raf) return;
  const x = cv.getContext('2d'); const cw = 9, ch = 15;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size() { const r = cv.parentElement.getBoundingClientRect(); const d = Math.min(devicePixelRatio || 1, 2); cv.width = r.width * d; cv.height = r.height * d; cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px'; x.setTransform(d, 0, 0, d, 0, 0); x.font = `${ch - 2}px ui-monospace,Menlo,Consolas,monospace`; x.textBaseline = 'top'; return [r.width, r.height]; }
  let [W, H] = size(); addEventListener('resize', () => { [W, H] = size(); });
  cv.parentElement.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
  const t0 = performance.now();
  const frame = (now) => {
    const t = (now - t0) / 1000; x.clearRect(0, 0, W, H);
    const cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);
    // synthetic "price path" ridge that scrolls left
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const u = i / cols, v = j / rows;
      const path = 0.5 + 0.18 * Math.sin(u * 9 + t * 0.6) + 0.1 * Math.sin(u * 23 - t * 1.3) + 0.05 * Math.sin(u * 61 + t * 2.1);
      const d = Math.abs(v - path);
      let k = Math.exp(-d * d * 260) * 0.95;                       // bright ridge
      k += (v > path ? 0.18 : 0.06) * (0.5 + 0.5 * Math.sin(u * 40 + v * 18 - t * 0.8)); // fill below / haze above
      if (mx >= 0) { const dx = i * cw - mx, dy = j * ch - my; k += 0.5 * Math.exp(-(dx * dx + dy * dy) / 9000); }
      k *= 0.7 + 0.3 * Math.min(1, u * 2.4);                      // fade towards the left so copy stays readable
      const idx = Math.max(0, Math.min(RAMP.length - 1, Math.floor(k * RAMP.length)));
      if (idx < 1) continue;
      const hot = k > 0.8;
      x.fillStyle = hot ? 'rgba(212,255,58,.85)' : `rgba(150,170,140,${0.1 + k * 0.5})`;
      x.fillText(RAMP[idx], i * cw, j * ch);
    }
    raf = reduce ? 0 : requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}
function stopAscii() { if (raf) cancelAnimationFrame(raf); raf = 0; }
if (body.dataset.view === 'landing') startAscii();
syncNav();
