// On-chain TESTNET mode UI. Self-contained: builds its own DOM, does not touch simulator state.
import { availableChains, chainById, loadDeployments, MARKETS, MAINNET_ENABLED, WC_PROJECT_ID } from './config.js';
import * as W from './wallet.js';
import { SEL, TOPIC_OPENED, enc, words, toBig, toAddr, parseUnits, fmtUnits } from './abi.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const WAD = 10n ** 18n;
let deployments = {}, mode = 'sim', timer = null, busy = false, wcUri = null;
const simbar = () => $('#simbar');
const SIM_TEXT = simbar()?.innerHTML;

const RISK = `<b>Read this.</b> Nearly all 10000x positions are liquidated within seconds: the margin is wiped by a <b>0.009%</b> adverse move,
smaller than ordinary price noise and oracle jitter. Treat leverage above ~100x as a lottery ticket you expect to lose. Wins are scaled down by a
haircut, capped at 100x margin, and may be <b>queued</b> if the house pool cannot pay immediately. Settlement uses an oracle price you cannot verify
at the moment you click.`;

function chain() { return chainById(W.state.chainId); }
function dep() { const c = chain(); return c && deployments[c.id] ? deployments[c.id] : null; }
function bannerFor(c) {
  if (c && !c.testnet) return `🚨 MAINNET — REAL FUNDS AT RISK. Unaudited by independent parties. You can lose everything you deposit.`;
  return `🧪 TESTNET — no real funds. Tokens here have no monetary value. PAPER10KX is a points token with no value.`;
}

function build() {
  const bar = document.createElement('div'); bar.id = 'chainbar';
  bar.innerHTML = `<div class="seg2"><button data-m="sim" class="on">Simulator</button><button data-m="chain">⛓ On-chain (testnet)</button></div>
    <span class="muted">Simulator = no wallet, fully local. On-chain = real contracts on a test network, worthless test tokens.</span>`;
  (simbar() || document.body).after(bar);
  const root = document.createElement('section'); root.id = 'chainpanel'; root.hidden = true; bar.after(root);
  bar.onclick = (e) => { const b = e.target.closest('button[data-m]'); if (b) setMode(b.dataset.m); };
  $('#chainpanel').addEventListener('click', onClick);
  if (location.hash === '#onchain') setMode('chain');
}

function setMode(m) {
  mode = m; const root = $('#chainpanel');
  for (const b of document.querySelectorAll('#chainbar button')) b.classList.toggle('on', b.dataset.m === m);
  root.hidden = m !== 'chain';
  for (const sel of ['#hero', '#terminal']) { const el = $(sel); if (el) el.style.display = m === 'chain' ? 'none' : ''; }
  if (simbar()) simbar().innerHTML = m === 'chain' ? esc(bannerFor(chain())) : SIM_TEXT;
  simbar()?.classList.toggle('testnet', m === 'chain');
  if (m === 'chain') { render(); refresh(); timer ??= setInterval(refresh, 8000); } else { clearInterval(timer); timer = null; }
}

function toast(msg, bad) { const t = $('#ctoasts') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'ctoasts' }); const d = document.createElement('div'); d.className = 'ctoast' + (bad ? ' bad' : ''); d.textContent = msg; t.append(d); setTimeout(() => d.remove(), 7000); }

let data = null; // last refresh
async function refresh() {
  const c = chain(), d = dep(); if (simbar() && mode === 'chain') simbar().innerHTML = esc(bannerFor(c));
  data = null;
  if (c && d) {
    try {
      const acct = W.state.account, r = (to, sel, ...a) => W.call(c, to, enc(sel, ...a));
      const [paused, pool, tm, tf, maxLev, minM, maxM, qt] = await Promise.all([
        r(d.exchange, SEL.paused), r(d.exchange, SEL.pool), r(d.exchange, SEL.totalMargin), r(d.exchange, SEL.totalFree),
        r(d.exchange, SEL.maxLeverage), r(d.exchange, SEL.minMargin), r(d.exchange, SEL.maxMarginPerPosition), r(d.exchange, SEL.queuedTotal)]);
      data = { paused: toBig(paused.slice(2)) === 1n, pool: toBig(pool.slice(2)), totalMargin: toBig(tm.slice(2)), totalFree: toBig(tf.slice(2)),
        maxLev: Number(toBig(maxLev.slice(2))), minM: toBig(minM.slice(2)), maxM: toBig(maxM.slice(2)), queued: toBig(qt.slice(2)), prices: {}, positions: [] };
      for (const m of MARKETS) {
        try { const [p, ts] = words(await r(d.oracle, SEL.getPrice, m.id)); data.prices[m.id] = { price: toBig(p), ts: Number(toBig(ts)) }; } catch { data.prices[m.id] = { price: 0n, ts: 0 }; }
      }
      if (acct) {
        const [usdc, free, px, queued] = await Promise.all([r(d.collateral, SEL.balanceOf, acct), r(d.exchange, SEL.free, acct), r(d.px, SEL.balanceOf, acct), r(d.exchange, SEL.queuedOf, acct)]);
        Object.assign(data, { usdc: toBig(usdc.slice(2)), free: toBig(free.slice(2)), pxBal: toBig(px.slice(2)), myQueued: toBig(queued.slice(2)) });
        const logs = await W.rpc(c, 'eth_getLogs', [{ address: d.exchange, topics: [TOPIC_OPENED, null, '0x' + acct.slice(2).toLowerCase().padStart(64, '0')], fromBlock: '0x' + (d.block || 0).toString(16), toBlock: 'latest' }]);
        for (const l of logs.slice(-40)) {
          const id = toBig(l.topics[1].slice(2)); const w = words(await r(d.exchange, SEL.positions, id));
          if (toAddr(w[0]) !== '0x' + '0'.repeat(40)) data.positions.push({ id, market: Number(toBig(w[1])), isLong: toBig(w[2]) === 1n, lev: Number(toBig(w[3])), margin: toBig(w[4]), notional: toBig(w[5]), entry: toBig(w[6]), openedAt: Number(toBig(w[7])), maint: Number(toBig(w[8])) });
        }
      }
    } catch (e) { data = { error: e.message }; }
  }
  render();
}

const bust = (p) => { const d = p.entry * BigInt(10000 - p.maint) / (10000n * BigInt(p.lev)); return p.isLong ? p.entry - d : p.entry + d; };
const fmtPx = (b) => Number(b / 10n ** 12n) / 1e6;
const usd = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function render() {
  if (mode !== 'chain') return;
  const root = $('#chainpanel'), s = W.state, c = chain(), d = dep(), all = availableChains();
  // preserve inputs across re-render
  const keep = Object.fromEntries([...root.querySelectorAll('input,select')].map((i) => [i.id, i.value]));
  const inj = W.injectedProviders();
  let h = `<div class="cbanner ${c && !c.testnet ? 'main' : ''}">${esc(bannerFor(c))}</div><div class="cgrid">`;
  // --- wallet card
  h += `<div class="ccard"><h3>Wallet</h3>`;
  if (!s.account) {
    h += inj.length ? inj.map((p, i) => `<button class="go long" data-act="injected" data-i="${i}">Connect ${esc(p.name)}</button>`).join('') : `<p class="muted">No injected wallet found (install any EIP-1193 wallet such as MetaMask, Rabby, Frame).</p>`;
    h += `<button class="ghost" data-act="wc">Connect with WalletConnect</button>`;
    if (!WC_PROJECT_ID) h += `<p class="fine">WalletConnect is not configured on this deployment (needs a free projectId in <code>src/chain/config.js</code>). Injected wallets work without it.</p>`;
    if (wcUri) h += `<div class="wcbox"><div id="wcqr"></div><textarea readonly rows="3">${esc(wcUri)}</textarea><p class="fine">Scan with a mobile wallet or paste the URI. This contacts the WalletConnect relay.</p></div>`;
  } else {
    h += `<p><b>${esc(s.name)}</b> <code>${short(s.account)}</code> <button class="ghost sm" data-act="disc">Disconnect</button></p>`;
    h += `<p>Network: <b class="${c ? 'up' : 'dn'}">${c ? esc(c.name) : 'unsupported chain ' + s.chainId}</b></p>`;
    if (!c) h += `<p class="dn">Wrong network. Switch to a supported test network:</p>`;
    h += all.filter((x) => x.testnet || MAINNET_ENABLED).map((x) => `<button class="ghost sm" data-act="switch" data-id="${x.id}">${c && c.id === x.id ? '✓ ' : ''}${esc(x.short)}</button>`).join(' ');
    h += s.signedIn ? `<p class="up">✓ Signed in (local session)</p>` : `<button class="go long" data-act="sign">Sign in with wallet</button><p class="fine">Signs a free message; no gas, no transaction.</p>`;
  }
  h += `</div>`;
  // --- balances / pool
  h += `<div class="ccard"><h3>Protocol (${c ? esc(c.short) : '—'})</h3>`;
  if (!c) h += `<p class="muted">Connect a wallet and pick a test network.</p>`;
  else if (!d) h += `<p class="muted">No contracts deployed on ${esc(c.name)} yet. Deploy with <code>contracts/script/Deploy.s.sol</code> and add the addresses to <code>deployments.json</code> (see README → Testnet).</p>${c.faucet ? `<p class="fine">Gas faucet: <a href="${esc(c.faucet)}" target="_blank" rel="noopener">${esc(c.faucet)}</a></p>` : ''}`;
  else if (!data) h += `<p class="muted">loading…</p>`;
  else if (data.error) h += `<p class="dn">RPC error: ${esc(data.error)}</p>`;
  else {
    h += `<dl class="quote"><dt>Status</dt><dd class="${data.paused ? 'dn' : 'up'}">${data.paused ? 'PAUSED' : 'live'}</dd><dt>House pool</dt><dd>${fmtUnits(data.pool)} tUSDC</dd><dt>Open margin</dt><dd>${fmtUnits(data.totalMargin)}</dd><dt>Queued wins owed</dt><dd class="${data.queued ? 'dn' : ''}">${fmtUnits(data.queued)}</dd><dt>Max leverage</dt><dd>${data.maxLev}x</dd></dl>`;
    if (s.account) h += `<dl class="quote"><dt>Wallet tUSDC</dt><dd>${fmtUnits(data.usdc ?? 0n)}</dd><dt>Trading balance</dt><dd>${fmtUnits(data.free ?? 0n)}</dd><dt>PAPER10KX (no value)</dt><dd>${fmtUnits(data.pxBal ?? 0n, 18, 2)}</dd><dt>Your queued wins</dt><dd>${fmtUnits(data.myQueued ?? 0n)}</dd></dl>`;
    h += `<p class="fine">Contracts: <code>${short(d.exchange)}</code> exch · <code>${short(d.oracle)}</code> oracle</p>`;
  }
  h += `</div>`;
  // --- funds + trade
  if (s.account && c && d && data && !data.error) {
    h += `<div class="ccard"><h3>Funds</h3><button class="ghost" data-act="faucet">Get 10,000 free test tUSDC</button>
      <label class="f">Amount (tUSDC)<input id="cAmt" type="number" min="0" step="any" value="100"></label>
      <div class="chips"><button data-act="deposit">Deposit</button><button data-act="withdraw">Withdraw</button></div>
      <p class="fine">Withdraw always works for your free balance, even when paused. Gas needs testnet ${esc(c.currency.symbol)}.</p></div>`;
    const m0 = keep.cMkt ?? '0';
    h += `<div class="ccard"><h3>Open position</h3><div class="risk on">${RISK}</div>
      <label class="f">Market<select id="cMkt">${MARKETS.map((m) => `<option value="${m.id}" ${String(m.id) === m0 ? 'selected' : ''}>${m.sym}-PERP</option>`).join('')}</select></label>
      <div class="seg" id="cSide"><button data-act="side" data-s="long" class="${(keep.cSideV ?? 'long') === 'long' ? 'on long' : ''}">Long</button><button data-act="side" data-s="short" class="${keep.cSideV === 'short' ? 'on short' : ''}">Short</button></div><input id="cSideV" type="hidden" value="${keep.cSideV ?? 'long'}">
      <label class="f">Margin (tUSDC) <small>min ${fmtUnits(data.minM)} · max ${fmtUnits(data.maxM)}</small><input id="cMargin" type="number" step="any" value="10"></label>
      <label class="f">Leverage <b id="cLevT">100x</b><input id="cLev" type="number" min="1" max="${data.maxLev}" value="100"></label>
      <div class="chips" id="cLevChips">${[1, 10, 100, 1000, 10000].map((n) => `<button data-act="lev" data-n="${n}">${n}</button>`).join('')}</div>
      <p id="cQuote" class="fine"></p>
      <button class="go long" data-act="open">Open on-chain position</button></div>`;
  }
  h += `</div>`;
  if (data && data.positions?.length) {
    h += `<div class="ccard wide"><h3>Your positions</h3><table class="tbl"><tr><th>ID</th><th>Mkt</th><th>Side</th><th>Lev</th><th>Margin</th><th>Entry</th><th>Bust</th><th>Mark</th><th></th></tr>`;
    for (const p of data.positions) {
      const pr = data.prices[p.market]?.price ?? 0n, b = bust(p), dead = pr && (p.isLong ? pr <= b : pr >= b);
      h += `<tr><td>#${p.id}</td><td>${MARKETS.find((m) => m.id === p.market)?.sym ?? p.market}</td><td class="${p.isLong ? 'up' : 'dn'}">${p.isLong ? 'LONG' : 'SHORT'}</td><td>${p.lev}x</td><td>${fmtUnits(p.margin)}</td><td>${usd(fmtPx(p.entry))}</td><td>${usd(fmtPx(b))}</td><td>${pr ? usd(fmtPx(pr)) : '—'}</td>
        <td><button class="ghost sm" data-act="close" data-id="${p.id}">${dead ? 'Liquidate (anyone)' : 'Close'}</button></td></tr>`;
    }
    h += `</table><p class="fine">Positions already past bust show a liquidation button; anyone (a keeper bot or you) can trigger it, which mints PAPER10KX to the trader. If a position was already settled it disappears on refresh.</p></div>`;
  }
  h += `<p class="fine ctrust">No trackers · no analytics · reads go straight to the public RPC of the selected test network. Prices on test networks are pushed by a signed-price relayer (<code>tools/price-relayer.mjs</code>); if no relayer is running, prices go stale and trading reverts by design.${MAINNET_ENABLED ? '' : ' Mainnet is disabled in this build.'}</p>`;
  root.innerHTML = h;
  for (const [k, v] of Object.entries(keep)) { const el = root.querySelector('#' + k); if (el && v !== '') el.value = v; }
  if (wcUri && $('#wcqr')) { const q = window.__P10K_WC?.qrcode(0, 'M'); if (q) { q.addData(wcUri); q.make(); $('#wcqr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2 }); } }
  quote();
}

function quote() {
  const el = $('#cQuote'); if (!el || !data) return;
  const lev = +$('#cLev').value || 1, m = +$('#cMargin').value || 0, mk = +$('#cMkt').value, side = $('#cSideV').value;
  $('#cLevT').textContent = lev + 'x';
  const pr = data.prices[mk]?.price ?? 0n, age = pr ? Math.floor(Date.now() / 1000) - data.prices[mk].ts : null;
  const dist = (0.9 / lev * 100);
  el.innerHTML = `Notional <b>${usd(m * lev)}</b> · liquidated by a <b class="dn">${dist < 0.1 ? dist.toFixed(4) : dist.toFixed(2)}%</b> adverse move · oracle price ${pr ? usd(fmtPx(pr)) + ` (${age}s old)` : '<span class="dn">none (relayer offline)</span>'}${lev >= 1000 ? `<br><b class="dn">⚠ ${lev}x: you will almost certainly lose this margin.</b>` : ''}`;
}

async function tx(label, to, data_) {
  if (busy) return toast('Another transaction is still pending…', true); busy = true;
  try {
    const c = chain(); toast(label + ': confirm in wallet…');
    const h = await W.sendTx(to, data_); toast(label + ': submitted ' + short(h)); await W.waitReceipt(c, h); toast(label + ': confirmed ✓');
  } catch (e) { toast(label + ' failed: ' + (e?.message || e), true); }
  busy = false; refresh();
}

async function onClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return; const a = b.dataset.act, c = chain(), d = dep();
  try {
    if (a === 'injected') { await W.connectInjected(W.injectedProviders()[+b.dataset.i]); }
    else if (a === 'wc') { wcUri = null; await W.connectWalletConnect((u) => { wcUri = u; render(); }, 998).then(() => { wcUri = null; }); }
    else if (a === 'disc') { await W.disconnect(); }
    else if (a === 'switch') { await W.switchChain(+b.dataset.id); }
    else if (a === 'sign') { await W.signIn(); }
    else if (a === 'side') { $('#cSideV').value = b.dataset.s; for (const x of $('#cSide').children) x.className = x.dataset.s === b.dataset.s ? 'on ' + x.dataset.s : ''; quote(); return; }
    else if (a === 'lev') { $('#cLev').value = b.dataset.n; quote(); return; }
    else if (a === 'faucet') return tx('Faucet', d.collateral, SEL.faucet);
    else if (a === 'deposit') {
      const amt = parseUnits($('#cAmt').value);
      if (amt <= 0n) return toast('enter an amount', true);
      const allow = toBig((await W.call(c, d.collateral, enc(SEL.allowance, W.state.account, d.exchange))).slice(2));
      if (allow < amt) await tx('Approve', d.collateral, enc(SEL.approve, d.exchange, amt));
      return tx('Deposit', d.exchange, enc(SEL.deposit, amt));
    }
    else if (a === 'withdraw') return tx('Withdraw', d.exchange, enc(SEL.withdraw, parseUnits($('#cAmt').value)));
    else if (a === 'open') {
      const mk = +$('#cMkt').value, isLong = $('#cSideV').value === 'long', margin = parseUnits($('#cMargin').value), lev = Math.round(+$('#cLev').value);
      const pr = data?.prices[mk]?.price; if (!pr) return toast('no oracle price — relayer offline', true);
      const worst = isLong ? pr * 10005n / 10000n : pr * 9995n / 10000n; // 5 bps slippage guard
      return tx('Open', d.exchange, enc(SEL.open, mk, isLong, margin, lev, worst));
    }
    else if (a === 'close') {
      const p = data.positions.find((x) => String(x.id) === b.dataset.id), pr = data.prices[p.market].price;
      const dead = p.isLong ? pr <= bust(p) : pr >= bust(p);
      return tx(dead ? 'Liquidate' : 'Close', d.exchange, enc(dead ? SEL.liquidate : SEL.close, p.id));
    }
    render(); refresh();
  } catch (err) { toast(err?.message || String(err), true); }
}

document.addEventListener('input', (e) => { if (e.target.closest?.('#chainpanel')) quote(); });
W.onChange(() => { if (mode === 'chain') { setMode('chain'); } });
(async () => { deployments = await loadDeployments(); build(); })();
