// CT schizo layer: original characters (src/chars.js) reacting to what you do. Pure decoration; no trading logic here.
const $ = (s, r = document) => r.querySelector(s);
const K = ['girl', 'punk', 'cat', 'peng', 'ape'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const LINES = {
  open: [['ser, you are so early', 'position opened. touch grass later.'], ['send it', 'conviction: maximum. plan: none.'], ['aping in', 'nfa. dyor. gl.']],
  win: [['WAGMI', 'closed green. screenshot it before it fades.'], ['up only (for now)', 'you are the exit liquidity of nobody.'], ['gigabrain play', 'the chart obeyed. this time.']],
  loss: [['it\u2019s just a dip', 'closed red. cope accordingly.'], ['few understand', 'neither did the market.']],
  rekt: [['NGMI', 'liquidated. the house says thanks.'], ['rekt, ser', 'margin gone in record time. again?'], ['have fun staying poor', 'jk. reset and run it back.']],
};
const STK = { open: ['stk y', 'aped'], win: ['stk g', 'wagmi'], loss: ['stk', 'cope'], rekt: ['stk pk', 'ngmi'] };
const FACE = { open: 'shock', win: 'happy', loss: 'sad', rekt: 'dead' };
const POSE = { open: 'p-pump', win: 'p-both', loss: 'p-shrug', rekt: 'p-slump' };
let el, tm;
function react(kind) {
  if (!window.charFig) return;
  const [t, s] = pick(LINES[kind]), k = pick(K);
  if (!el) { el = document.createElement('div'); el.className = 'react'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.className = 'react ' + (kind === 'win' ? 'win' : kind === 'rekt' || kind === 'loss' ? 'rekt' : '');
  el.innerHTML = `${window.charFig(k, POSE[kind])}<div><b>${t}</b><span>${s}</span></div><i class="${STK[kind][0]}">${STK[kind][1]}</i>`;
  el.querySelector('.ch').dataset.face = FACE[kind];
  requestAnimationFrame(() => el.classList.add('on')); clearTimeout(tm); tm = setTimeout(() => el.classList.remove('on'), 3200);
  mascotSay(kind);
}
function classify(txt) {
  if (/liquidat|💀/i.test(txt)) return 'rekt';
  if (/^closed/i.test(txt)) return /-\$|\$-|−/.test(txt) ? 'loss' : 'win';
  if (/^opened|order placed|limit filled/i.test(txt)) return 'open';
  return null;
}
function watch(sel) {
  const box = $(sel); if (!box || box.dataset.w) return; box.dataset.w = 1;
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { const k = n.nodeType === 1 && classify(n.textContent.trim()); if (k) react(k); } }).observe(box, { childList: true });
}
// ticket mascot that comments on your leverage
let mk = 'girl';
function mascot() {
  const t = $('#ticket'); if (!t || $('.mascot', t) || !window.charFig) return;
  const d = document.createElement('div'); d.className = 'mascot';
  d.innerHTML = `${window.charFig(mk)}<p><b>mi_lady</b> is watching your sizing.</p>`; t.prepend(d);
  const lev = $('#levNum'); const upd = () => { const L = +lev.value || 1; const ch = $('.ch', d);
    ch.dataset.face = L >= 5000 ? 'shock' : L >= 500 ? 'cope' : 'idle';
    $('p', d).innerHTML = L >= 5000 ? `<b>${L}x?</b> ser this is a casino. godspeed.` : L >= 500 ? `<b>${L}x</b>: liquidation is ~${(90 / L).toFixed(3)}% away. bold.` : L >= 50 ? `<b>${L}x</b>: spicy but survivable. maybe.` : `<b>${L}x</b>: responsible degen mode.`; };
  ['input', 'change'].forEach((e) => { lev.addEventListener(e, upd); $('#levRange')?.addEventListener(e, () => setTimeout(upd)); });
  $('#levChips')?.addEventListener('click', () => setTimeout(upd)); upd();
}
function mascotSay(kind) {
  const ch = $('.mascot .ch'); if (!ch) return; ch.dataset.face = FACE[kind];
  $('.mascot p').innerHTML = { open: '<b>gm.</b> position live. don\u2019t blink.', win: '<b>wagmi.</b> told you. (I didn\u2019t.)', loss: '<b>it\u2019s fine.</b> we\u2019re early.', rekt: '<b>rip.</b> pour one out for that margin.' }[kind];
}
function crew() {
  const c = $('.land-card'); if (!c || $('.crew', c) || !window.charFig) return;
  const d = document.createElement('div'); d.className = 'crew'; d.innerHTML = K.map((k) => window.charFig(k)).join(''); c.append(d);
  const faces = ['idle', 'happy', 'shock', 'cope'];
  setInterval(() => { const f = d.children[Math.floor(Math.random() * d.children.length)]; if (f) f.dataset.face = pick(faces); }, 1800);
}
function boot() { watch('#toasts'); mascot(); crew(); const t = setInterval(() => { watch('#ctoasts'); }, 1500); setTimeout(() => clearInterval(t), 600000); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
window.__react = react;
