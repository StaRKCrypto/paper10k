// On-chain TESTNET mode UI. Self-contained: builds its own DOM, does not touch simulator state.
import { availableChains, chainById, loadDeployments, MARKETS, MAINNET_ENABLED, WC_PROJECT_ID } from './config.js';
import * as W from './wallet.js';
import { SEL, TOPIC_OPENED, TOPIC_CLOSED, TOPIC_LIQUIDATED, enc, words, toBig, toAddr, parseUnits as pu, fmtUnits as fu } from './abi.js';
import { friendly } from './errors.js';
import { share } from './share.js';
import { loadSeasons, seasonsHtml } from './seasons.js';
import { refQuotes, divBps } from './refprice.js';
import { loadRules, rulesHtml } from './rules.js';
import { loadStake, stakeHtml, SS } from './stake.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const WAD = 10n ** 18n;
let deployments = {}, mode = 'sim', timer = null, busy = false, wcUri = null, tab = 'trade', seasons = null, rules = null, stakeD = null;
let DEC = 6; // collateral decimals, read on-chain per deployment (USDC = 6)
const parseUnits = (v, d = DEC) => pu(v, d), fmtUnits = (b, d = DEC, dp = 2) => fu(b, d, dp);
const sym = () => (chain()?.testnet ? 'tUSDC' : 'USDC');
const ZERO = '0x' + '0'.repeat(40);
const topicAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const simbar = () => $('#simbar');
const SIM_TEXT = simbar()?.innerHTML;

const RISK = `<b>Read this.</b> Nearly all 10000x positions are liquidated within seconds: the margin is wiped by a <b>0.009%</b> adverse move,
smaller than ordinary price noise and oracle jitter. Treat leverage above ~100x as a lottery ticket you expect to lose. Wins are scaled down by a
haircut, capped at 100x margin, and may be <b>queued</b> if the house pool cannot pay immediately. Settlement uses an oracle price you cannot verify
at the moment you click.`;

function chain() { return chainById(W.state.chainId); }
function dep() { const c = chain(); return c && deployments[c.id] ? deployments[c.id] : null; }
function bannerFor(c) {
  if (c && !c.testnet) return `🚨 MAINNET — REAL FUNDS AT RISK. You can lose everything you deposit. PAPER10KX and badges have no cash value.`;
  return `🧪 TESTNET — no real funds. Tokens here have no monetary value. PAPER10KX is a points token with no value.`;
}

function build() {
  const bar = document.createElement('div'); bar.id = 'chainbar';
  bar.innerHTML = `<div class="seg2"><button data-m="sim" class="on">Simulator</button><button data-m="chain">⛓ On-chain${MAINNET_ENABLED ? '' : ' (testnet)'}</button></div>
    <span class="muted">Simulator = no wallet, fully local. On-chain = real contracts${MAINNET_ENABLED ? '' : ' on a test network, worthless test tokens'}.</span>`;
  (simbar() || document.body).after(bar);
  const root = document.createElement('section'); root.id = 'chainpanel'; root.hidden = true; bar.after(root);
  bar.onclick = (e) => { const b = e.target.closest('button[data-m]'); if (b) setMode(b.dataset.m); };
  $('#chainpanel').addEventListener('click', onClick);
  if (location.hash === '#onchain') setMode('chain');
}

function setMode(m) {
  mode = m; const root = $('#chainpanel'); if (m === 'chain') document.body.dataset.view = 'app'; document.body.dataset.mode = m;
  for (const b of document.querySelectorAll('#chainbar button')) b.classList.toggle('on', b.dataset.m === m);
  root.hidden = m !== 'chain';
  for (const sel of ['#terminal']) { const el = $(sel); if (el) el.style.display = m === 'chain' ? 'none' : ''; }
  if (simbar()) simbar().innerHTML = m === 'chain' ? esc(bannerFor(chain())) : SIM_TEXT;
  simbar()?.classList.toggle('testnet', m === 'chain');
  if (m === 'chain') { render(); refresh(); timer ??= setInterval(refresh, 8000); } else { clearInterval(timer); timer = null; }
}

function toast(msg, bad) { if (bad && typeof msg !== 'string') msg = friendly(msg); const t = $('#ctoasts') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'ctoasts' }); const d = document.createElement('div'); d.className = 'ctoast' + (bad ? ' bad' : ''); d.textContent = msg; t.append(d); setTimeout(() => d.remove(), 7000); }

let data = null; // last refresh
async function refresh() {
  const c = chain(), d = dep(); if (simbar() && mode === 'chain') simbar().innerHTML = esc(bannerFor(c));
  data = null;
  if (c && d) {
    try {
      const acct = W.state.account, r = (to, sel, ...a) => W.call(c, to, enc(sel, ...a));
      const [paused, pool, tm, tf, cp, qt, ins] = await Promise.all([
        r(d.exchange, SEL.paused), r(d.exchange, SEL.pool), r(d.exchange, SEL.totalMargin), r(d.exchange, SEL.totalFree),
        r(d.exchange, SEL.currentParams), r(d.exchange, SEL.queuedTotal), r(d.exchange, SEL.insurance)]);
      const cw = words(cp), maxLev = '0x' + cw[0], minM = '0x' + cw[9], maxM = '0x' + cw[10];
      try { DEC = Number(toBig((await r(d.collateral, SEL.decimals)).slice(2))); } catch { DEC = 6; }
      let lim = null; try { const lw = words(await r(d.exchange, SEL.limits)); lim = { minNotional: toBig(lw[0]), maxNotional: toBig(lw[1]), maxWallet: toBig(lw[2]), liabBps: Number(toBig(lw[3])), jumpBps: Number(toBig(lw[4])) }; } catch { /* pre-limits build */ }
      data = { paused: toBig(paused.slice(2)) === 1n, pool: toBig(pool.slice(2)), totalMargin: toBig(tm.slice(2)), totalFree: toBig(tf.slice(2)),
        maxLev: Number(toBig(maxLev.slice(2))), minM: toBig(minM.slice(2)), maxM: toBig(maxM.slice(2)), queued: toBig(qt.slice(2)), insurance: toBig(ins.slice(2)), prices: {}, refs: {}, positions: [], lim, mkts: {}, results: [] };
      try { data.finalized = toBig((await r(d.exchange, SEL.finalized)).slice(2)) === 1n; } catch { data.finalized = false; }
      for (const m of MARKETS) {
        try { const [p, ts] = words(await r(d.oracle, SEL.getPrice, m.id)); data.prices[m.id] = { price: toBig(p), ts: Number(toBig(ts)) }; } catch { data.prices[m.id] = { price: 0n, ts: 0 }; }
        try { data.refs[m.id] = await refQuotes(m.sym); } catch { data.refs[m.id] = null; }
        try { const mw = words(await r(d.exchange, SEL.markets, m.id)); data.mkts[m.id] = { listed: toBig(mw[0]) === 1n, open: toBig(mw[1]) === 1n, capL: toBig(mw[2]), capS: toBig(mw[3]), oiL: toBig(mw[4]), oiS: toBig(mw[5]) }; } catch { data.mkts[m.id] = null; }
      }
      if (acct) {
        const [usdc, free, px, queued] = await Promise.all([r(d.collateral, SEL.balanceOf, acct), r(d.exchange, SEL.free, acct), r(d.px, SEL.balanceOf, acct), r(d.exchange, SEL.queuedOf, acct)]);
        Object.assign(data, { usdc: toBig(usdc.slice(2)), free: toBig(free.slice(2)), pxBal: toBig(px.slice(2)), myQueued: toBig(queued.slice(2)) });
        try { data.walletMargin = toBig((await r(d.exchange, SEL.walletMargin, acct)).slice(2)); data.rekts = Number(toBig((await r(d.exchange, SEL.rektCount, acct)).slice(2))); } catch { /* older build */ }
        if (d.triggers) { try { data.isOp = toBig((await r(d.exchange, SEL.isOperator, acct, d.triggers)).slice(2)) === 1n; } catch { data.isOp = false; } }
        if (d.badges && data.rekts) { data.badges = []; for (let t = 0; t < 4; t++) { const el = toBig((await r(d.badges, SEL.bEligible, acct, t)).slice(2)) === 1n; let owned = false; try { const tid = (await r(d.badges, SEL.bTokenIdOf, acct, t)); owned = toAddr(words(await r(d.badges, SEL.bOwnerOf, tid))[0]) === acct.toLowerCase(); } catch { /* not minted */ } data.badges.push({ t, el, owned }); } }
        const range = { fromBlock: '0x' + (d.block || 0).toString(16), toBlock: 'latest' };
        const logs = await W.rpc(c, 'eth_getLogs', [{ address: d.exchange, topics: [TOPIC_OPENED, null, topicAddr(acct)], ...range }]);
        const opened = new Map(logs.map((l) => { const w = words(l.data); return [toBig(l.topics[1].slice(2)), { market: Number(toBig(w[0])), isLong: toBig(w[1]) === 1n, margin: toBig(w[2]), lev: Number(toBig(w[5])), block: l.blockNumber }]; }));
        try {
          const [cl, lq] = await Promise.all([W.rpc(c, 'eth_getLogs', [{ address: d.exchange, topics: [TOPIC_CLOSED, null, topicAddr(acct)], ...range }]), W.rpc(c, 'eth_getLogs', [{ address: d.exchange, topics: [TOPIC_LIQUIDATED, null, topicAddr(acct)], ...range }])]);
          const res = [];
          for (const l of cl) { const id = toBig(l.topics[1].slice(2)), w = words(l.data), o = opened.get(id); if (o) res.push({ id, ...o, pnl: toBig(w[2]) + toBig(w[3]) - toBig(w[4]), liq: false, block: Number(l.blockNumber) }); }
          for (const l of lq) { const id = toBig(l.topics[1].slice(2)), w = words(l.data), o = opened.get(id); if (o) res.push({ id, ...o, pnl: -toBig(w[1]), liq: true, block: Number(l.blockNumber) }); }
          data.results = res.sort((a, b) => b.block - a.block).slice(0, 10);
        } catch { /* log range limits on public RPCs: results are best effort */ }
        for (const l of logs.slice(-40)) {
          const id = toBig(l.topics[1].slice(2)); const w = words(await r(d.exchange, SEL.positions, id));
          // positions(): [owner, market, leverage, pv, isLong, margin, notional, entry, openedAt, openedBlock]
          if (toAddr(w[0]) !== '0x' + '0'.repeat(40)) {
            const bustPx = toBig((await r(d.exchange, SEL.bustPriceOf, id)).slice(2)); // contract computes it with the params version snapshotted at open
            const pos = { id, market: Number(toBig(w[1])), lev: Number(toBig(w[2])), isLong: toBig(w[4]) === 1n, margin: toBig(w[5]), notional: toBig(w[6]), entry: toBig(w[7]), openedAt: Number(toBig(w[8])), bust: bustPx };
            if (d.triggers) { try { const ow = words(await r(d.triggers, SEL.tOrders, id)); if (toAddr(ow[2]) !== ZERO) pos.order = { tp: toBig(ow[0]), sl: toBig(ow[1]) }; } catch { /* none */ } }
            data.positions.push(pos);
          }
        }
      }
    } catch (e) { data = { error: friendly(e) }; }
  }
  render();
}

const bust = (p) => p.bust;
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
    const wcOn = W.appKitAvailable();
    const icon = (p) => (p.icon && /^data:image\/(svg\+xml|png|webp|jpeg);/.test(p.icon) ? `<img src="${esc(p.icon)}" alt="" width="22" height="22">` : `<span class="wi">${esc((p.name || '?')[0])}</span>`);
    h += `<p class="wsub">Connect a wallet to trade on-chain with test tokens.</p>`;
    if (wcOn) h += `<button class="go" data-act="appkit">Connect wallet</button><p class="fine">MetaMask, Rabby, Coinbase / Base Account, Phantom, OKX, Brave, Trust, Safe and 300+ more.</p>`;
    h += `<div class="wlist">${inj.length ? `<div class="wlabel">${wcOn ? 'Or use a browser wallet' : 'Browser wallets'}</div>` + inj.map((p, i) => `<button class="wrow" data-act="injected" data-i="${i}">${icon(p)}<span>${esc(p.name)}</span><em>Detected</em></button>`).join('')
      : `<div class="wempty"><b>No browser wallet found</b><p>Install a wallet extension such as MetaMask, Rabby, Coinbase Wallet, Phantom, OKX or Brave Wallet, or open this page in your mobile wallet\u2019s built-in browser.</p></div>`}</div>`;
    if (wcOn) {
      h += `<button class="ghost wcbtn" data-act="wc">Scan a QR code (WalletConnect)</button>`;
      if (wcUri) h += `<div class="wcbox"><div id="wcqr"></div><div class="chips">${W.wcDeepLinks(wcUri).map(([n, u]) => `<a class="ghost sm" href="${esc(u)}">${esc(n)}</a>`).join('')}</div><textarea readonly rows="3">${esc(wcUri)}</textarea><p class="fine">Scan with a mobile wallet or tap your wallet on a phone.</p></div>`;
    }
  } else {
    h += `<p><b>${esc(s.name)}</b> ${s.ens ? `<b class="up">${esc(s.ens)}</b> ` : ''}<code title="${esc(s.account)}">${short(s.account)}</code> <button class="ghost sm" data-act="disc">Disconnect</button>${s.kind === 'appkit' ? ' <button class="ghost sm" data-act="appkit">Wallet</button>' : ''}</p>`;
    if (c) h += `<p class="fine">${W.gaslessReady(c.id) ? '<b class="up">⛽ Gasless: trades are sponsored by the paymaster</b>' : W.batchReady(c.id) ? 'Batched transactions supported (approve + deposit in one step). You pay gas.' : `You pay gas in ${esc(c.currency.symbol)}.`}</p>`;
    h += `<p>Network: <b class="${c ? 'up' : 'dn'}">${c ? esc(c.name) : 'unsupported chain ' + s.chainId}</b></p>`;
    if (!c) h += `<div class="cbanner main">Wrong network (chain ${esc(s.chainId)}). Trading is disabled until you switch:</div>`;
    h += all.filter((x) => x.testnet || MAINNET_ENABLED).map((x) => `<button class="ghost sm" data-act="switch" data-id="${x.id}">${c && c.id === x.id ? '✓ ' : ''}${esc(x.short)}</button>`).join(' ');
    h += s.signedIn ? `<p class="up">✓ Signed in (local session)</p>` : `<button class="go long" data-act="sign">Sign in with wallet</button><p class="fine">Signs a free message; no gas, no transaction.</p>`;
  }
  h += `</div>`;
  // --- tabs
  h += `</div><div class="seg2 ctabs">${[['trade', 'Trade'], ['stake', '💰 Stake'], ['seasons', '🏆 Seasons'], ['badges', '💀 Badges'], ['rules', '📜 Rules & FAQ']].map(([k, n]) => `<button data-act="tab" data-t="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div><div class="cgrid">`;
  if (tab === 'seasons') { h += `<div class="ccard wide"><h3>Seasons & competitions</h3>${seasonsHtml(seasons, s.account, DEC)}</div></div>`; return finish(root, h, keep); }
  if (tab === 'stake') { h += stakeHtml(c && d ? stakeD : null, { sym: sym(), account: s.account, explorer: c?.explorer }) + `</div>`; return finish(root, h, keep); }
  if (tab === 'rules') { h += rulesHtml(c && d ? rules : null, { fmt: (v) => fmtUnits(v), explorer: c?.explorer, sym: sym() }) + `</div>`; return finish(root, h, keep); }
  if (tab === 'badges') { h += badgesHtml(d) + `</div>`; return finish(root, h, keep); }
  // --- balances / pool
  h += `<div class="ccard"><h3>Protocol (${c ? esc(c.short) : '—'})</h3>`;
  if (!c) h += `<p class="muted">Connect a wallet and pick a test network.</p>`;
  else if (!d) h += `<p class="muted">PAPER10K isn’t live on ${esc(c.name)} yet. Try the simulator, or read the Rules and Blog meanwhile.</p>`;
  else if (!data) h += `<p class="muted">loading…</p>`;
  else if (data.error) h += `<p class="dn">RPC error: ${esc(data.error)}</p>`;
  else {
    h += `<dl class="quote"><dt>Status</dt><dd class="${data.paused ? 'dn' : 'up'}">${data.paused ? 'PAUSED (withdrawals still work)' : 'live'}</dd>${MARKETS.map((m) => { const k = data.mkts[m.id]; return `<dt>${m.sym}-PERP</dt><dd class="${k?.open ? 'up' : 'dn'}">${!k || !k.listed ? 'not listed' : k.open ? 'open' : 'closed to new positions'}</dd>`; }).join('')}<dt>House pool</dt><dd>${fmtUnits(data.pool)} ${sym()}</dd><dt>Open margin</dt><dd>${fmtUnits(data.totalMargin)}</dd><dt>Queued wins owed</dt><dd class="${data.queued ? 'dn' : ''}">${fmtUnits(data.queued)}</dd><dt>Max leverage</dt><dd>${data.maxLev}x</dd></dl>`;
    if (data.lim && (data.lim.minNotional || data.lim.maxNotional || data.lim.maxWallet || data.lim.jumpBps || data.lim.liabBps)) { const L = data.lim; h += `<p class="fine">Launch limits: notional ${L.minNotional ? '≥ ' + fmtUnits(L.minNotional, DEC, 0) : 'no min'}${L.maxNotional ? ' · ≤ ' + fmtUnits(L.maxNotional, DEC, 0) : ''}${L.maxWallet ? ' · ≤ ' + fmtUnits(L.maxWallet, DEC, 0) + ' ' + sym() + ' open margin per wallet' : ''}${L.jumpBps ? ` · circuit breaker ${L.jumpBps / 100}%` : ''}</p>`; }
    if (s.account) h += `<dl class="quote"><dt>Wallet ${sym()}</dt><dd>${fmtUnits(data.usdc ?? 0n)}</dd><dt>Trading balance</dt><dd>${fmtUnits(data.free ?? 0n)}</dd><dt>PAPER10KX (no value)</dt><dd>${fmtUnits(data.pxBal ?? 0n, 18, 2)}</dd><dt>Your queued wins</dt><dd>${fmtUnits(data.myQueued ?? 0n)}</dd></dl>`;
    h += `<p class="fine">Contracts: <code>${short(d.exchange)}</code> exch · <code>${short(d.oracle)}</code> oracle</p>`;
  }
  h += `</div>`;
  // --- funds + trade
  if (s.account && c && d && data && !data.error) {
    h += `<div class="ccard"><h3>Funds</h3>${c.testnet ? `<button class="ghost" data-act="faucet">Get 10,000 free test tUSDC</button>` : ''}
      <label class="f">Amount (${sym()})<input id="cAmt" type="number" min="0" step="any" inputmode="decimal" value="${c.testnet ? 100 : 10}"></label>
      <div class="chips"><button data-act="deposit">Deposit</button><button data-act="withdraw">Withdraw</button></div>
      <p class="fine">Withdraw always works for your free balance, even when paused. ${W.gaslessReady(c.id) ? 'Gas is sponsored.' : `Gas needs ${esc(c.currency.symbol)} on ${esc(c.name)}.`} Approval is for the exact amount only.</p></div>`;
    const m0 = keep.cMkt ?? '0';
    h += `<div class="ccard"><h3>Open position</h3><div class="risk on">${RISK}</div>
      <label class="f">Market<select id="cMkt">${MARKETS.map((m) => `<option value="${m.id}" ${String(m.id) === m0 ? 'selected' : ''}>${m.sym}-PERP</option>`).join('')}</select></label>
      <div class="seg" id="cSide"><button data-act="side" data-s="long" class="${(keep.cSideV ?? 'long') === 'long' ? 'on long' : ''}">Long</button><button data-act="side" data-s="short" class="${keep.cSideV === 'short' ? 'on short' : ''}">Short</button></div><input id="cSideV" type="hidden" value="${keep.cSideV ?? 'long'}">
      <label class="f">Margin (${sym()}) <small>min ${fmtUnits(data.minM)} · max ${fmtUnits(data.maxM)}</small><input id="cMargin" type="number" step="any" inputmode="decimal" value="10"></label>
      <label class="f">Leverage <b id="cLevT">100x</b><input id="cLev" type="number" min="1" max="${data.maxLev}" value="100"></label>
      <div class="chips" id="cLevChips">${[1, 10, 100, 1000, 10000].map((n) => `<button data-act="lev" data-n="${n}">${n}</button>`).join('')}</div>
      <p id="cQuote" class="fine"></p>
      ${openBlocker() ? `<p class="dn">${esc(openBlocker())}</p>` : ''}
      <button class="go long" data-act="open" ${openBlocker() ? 'disabled' : ''}>Open on-chain position</button></div>`;
  }
  h += `</div>`;
  if (data && data.positions?.length) {
    h += `<div class="ccard wide"><h3>Your positions</h3><div class="tblwrap"><table class="tbl"><tr><th>ID</th><th>Mkt</th><th>Side</th><th>Lev</th><th>Margin</th><th>Entry</th><th>Bust</th><th>Mark</th><th>TP / SL</th><th></th></tr>`;
    for (const p of data.positions) {
      const pr = data.prices[p.market]?.price ?? 0n, b = bust(p), dead = pr && (p.isLong ? pr <= b : pr >= b);
      h += `<tr><td>#${p.id}</td><td>${MARKETS.find((m) => m.id === p.market)?.sym ?? p.market}</td><td class="${p.isLong ? 'up' : 'dn'}">${p.isLong ? 'LONG' : 'SHORT'}</td><td>${p.lev}x</td><td>${fmtUnits(p.margin)}</td><td>${usd(fmtPx(p.entry))}</td><td>${usd(fmtPx(b))}</td><td>${pr ? usd(fmtPx(pr)) : '—'}</td>
        <td>${d.triggers ? (p.order ? `${p.order.tp ? usd(fmtPx(p.order.tp)) : '—'} / ${p.order.sl ? usd(fmtPx(p.order.sl)) : '—'} <button class="ghost sm" data-act="tpcancel" data-id="${p.id}">✕</button>` : `<button class="ghost sm" data-act="tpsl" data-id="${p.id}">Set</button>`) : '—'}</td>
        <td><button class="ghost sm" data-act="close" data-id="${p.id}">${dead ? 'Close (past bust)' : 'Close'}</button></td></tr>`;
    }
    h += `</table></div><p class="fine">TP/SL is executed by a keeper through the TriggerOrders contract, which you approve as a close-only operator (it can never open, withdraw or move funds). Positions already past bust show a liquidation button; anyone (a keeper bot or you) can trigger it, which mints PAPER10KX to the trader. If a position was already settled it disappears on refresh.</p></div>`;
  }
  if (data?.results?.length) {
    h += `<div class="ccard wide"><h3>Recent results</h3><div class="tblwrap"><table class="tbl"><tr><th>ID</th><th>Mkt</th><th>Lev</th><th>Result</th><th>Share</th></tr>`;
    for (const r of data.results) h += `<tr><td>#${r.id}</td><td>${MARKETS.find((m) => m.id === r.market)?.sym ?? r.market} ${r.isLong ? 'L' : 'S'}</td><td>${r.lev}x</td><td class="${r.pnl >= 0n ? 'up' : 'dn'}">${r.liq ? '💀 REKT ' : ''}${fmtUnits(r.pnl)}</td>
      <td class="chips"><button class="ghost sm" data-act="share" data-how="native" data-id="${r.id}">Share</button><button class="ghost sm" data-act="share" data-how="farcaster" data-id="${r.id}">Farcaster</button><button class="ghost sm" data-act="share" data-how="x" data-id="${r.id}">X</button><button class="ghost sm" data-act="share" data-how="png" data-id="${r.id}">PNG</button></td></tr>`;
    h += `</table></div></div>`;
  }
  h += `<p class="fine ctrust">No trackers · no analytics · reads go straight to the public RPC of the selected test network. Prices on test networks are pushed by a signed-price relayer (<code>tools/price-relayer.mjs</code>); if no relayer is running, prices go stale and trading reverts by design.${MAINNET_ENABLED ? '' : ' Mainnet is disabled in this build.'}</p>`;
  finish(root, h, keep);
}

function finish(root, h, keep) {
  root.innerHTML = h;
  for (const [k, v] of Object.entries(keep)) { const el = root.querySelector('#' + k); if (el && v !== '') el.value = v; }
  if (wcUri && $('#wcqr')) { const q = window.__P10K_WC?.qrcode(0, 'M'); if (q) { q.addData(wcUri); q.make(); $('#wcqr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2 }); } }
  quote();
}

/** reason new positions cannot be opened right now (null = ok) */
function openBlocker() {
  if (!data || data.error) return 'No data';
  if (data.paused) return 'Exchange is paused: new positions are disabled. You can still withdraw your free balance.';
  const mk = +($('#cMkt')?.value ?? 0), k = data.mkts[mk];
  if (k && !k.open) return 'This market is closed to new positions.';
  const pr = data.prices[mk], ref = data.refs?.[mk];
  // after finalize fills use a fresh Pyth update fetched by the filler, so a stale STORED price does not block; the venue median must exist
  if (data.finalized ? !(ref?.median > 0) && !pr?.price : !pr?.price) return 'No usable price right now (oracle and reference venues unavailable).';
  const dv = pr?.price && ref?.median ? divBps(fmtPx(pr.price), ref.median) : NaN;
  if (!data.finalized && dv > 50) return `On-chain oracle is ${dv.toFixed(0)} bps away from the Binance/Coinbase/Hyperliquid/Lighter median: opening is blocked in the app until they agree.`;
  return null;
}
/** client-side pre-flight of the on-chain risk limits so users see why before signing */
function preflight(margin, lev) {
  const L = data.lim, n = margin * BigInt(lev);
  if (margin < data.minM || margin > data.maxM) return `Margin must be between ${fmtUnits(data.minM)} and ${fmtUnits(data.maxM)} ${sym()}.`;
  if (lev < 1 || lev > data.maxLev) return `Leverage must be 1–${data.maxLev}x.`;
  if ((data.free ?? 0n) < margin) return 'Insufficient trading balance: deposit first.';
  if (L) {
    if (n < L.minNotional) return `Notional ${fmtUnits(n, DEC, 0)} is below the minimum ${fmtUnits(L.minNotional, DEC, 0)} ${sym()}: raise margin or leverage.`;
    if (L.maxNotional && n > L.maxNotional) return `Notional ${fmtUnits(n, DEC, 0)} is above the maximum ${fmtUnits(L.maxNotional, DEC, 0)} ${sym()}.`;
    if (L.maxWallet && (data.walletMargin ?? 0n) + margin > L.maxWallet) return `Per-wallet open-margin cap is ${fmtUnits(L.maxWallet)} ${sym()} (you have ${fmtUnits(data.walletMargin ?? 0n)} open).`;
  }
  return null;
}
const BADGE = ['First rekt', 'Rekt x10', 'Rekt x100', 'Rekt x1000'];
function badgesHtml(d) {
  if (!W.state.account || !d) return `<div class="ccard"><h3>Rekt badges</h3><p class="muted">Connect a wallet on a network with PAPER10K deployed.</p></div>`;
  if (!d.badges) return `<div class="ccard"><h3>Rekt badges</h3><p class="muted">Badges contract not deployed on this network yet.</p></div>`;
  let h = `<div class="ccard"><h3>Rekt badges (soulbound, no value)</h3><p>Liquidations: <b>${data?.rekts ?? 0}</b></p>`;
  for (let t = 0; t < 4; t++) { const b = data?.badges?.[t]; h += `<p>${BADGE[t]}: ${b?.owned ? '<b class="up">✓ owned</b>' : b?.el ? `<button class="go long sm" data-act="claim" data-t="${t}">Claim</button>` : '<span class="muted">locked</span>'}</p>`; }
  return h + `<p class="fine">Anyone can mint a badge to your address once the exchange's on-chain rekt counter reaches the tier. Not transferable.</p></div>`;
}

function refLine(mk, pr) {
  const r = data.refs?.[mk]; if (!r || !(r.median > 0)) return ' · <span class="muted">reference venues unavailable</span>';
  const f = (x) => (Number.isFinite(x) && x > 0 ? usd(x) : '—'), dv = pr ? divBps(fmtPx(pr), r.median) : NaN;
  return `<br><span class="fine">Venues (display only): Binance ${f(r.binance)} · Coinbase ${f(r.coinbase)} · Hyperliquid ${f(r.hyperliquid)} · Lighter ${f(r.lighter)} · median <b>${f(r.median)}</b>${Number.isFinite(dv) ? ` · oracle vs median <b class="${dv > 50 ? 'dn' : 'up'}">${dv.toFixed(1)} bps</b>${dv > 50 ? ' ⚠ diverged' : ''}` : ''}</span>`;
}
function quote() {
  const el = $('#cQuote'); if (!el || !data) return;
  const lev = +$('#cLev').value || 1, m = +$('#cMargin').value || 0, mk = +$('#cMkt').value, side = $('#cSideV').value;
  $('#cLevT').textContent = lev + 'x';
  const pr = data.prices[mk]?.price ?? 0n, age = pr ? Math.floor(Date.now() / 1000) - data.prices[mk].ts : null;
  const dist = (0.9 / lev * 100);
  el.innerHTML = `Notional <b>${usd(m * lev)}</b> · liquidated by a <b class="dn">${dist < 0.1 ? dist.toFixed(4) : dist.toFixed(2)}%</b> adverse move · oracle price ${pr ? usd(fmtPx(pr)) + ` (${age}s old)` : '<span class="muted">no fresh stored price</span>'}${refLine(mk, pr)}${lev >= 1000 ? `<br><b class="dn">⚠ ${lev}x: you will almost certainly lose this margin.</b>` : ''}`;
}

async function tx(label, to, data_) { return txs(label, [{ to, data: data_ }]); }
/** one or more calls; batched (and gasless if a paymaster is configured and the wallet supports it), else sequential */
async function txs(label, calls) {
  if (busy) return toast('Another transaction is still pending…', true); busy = true;
  try {
    const c = chain(); if (!c) throw new Error('Switch to a supported network first.');
    toast(label + ': confirm in wallet' + (W.gaslessReady(c.id) ? ' (gas sponsored)' : '') + '…');
    const h = await W.sendCalls(calls, c.id); if (h) { toast(label + ': submitted ' + short(h)); await W.waitReceipt(c, h); } toast(label + ': confirmed ✓');
  } catch (e) { toast(label + ' failed: ' + friendly(e), true); }
  busy = false; refresh();
}

function loadStakeNow() { const c = chain(), d = dep(); if (c && d) loadStake(W.rpc, c, d, W.state.account).then((x) => { stakeD = x; render(); }).catch(() => { stakeD = null; render(); }); }
function setTab(t) { tab = t; if (tab === 'seasons') loadSeasons().then((j) => { seasons = j; render(); }); if (tab === 'stake') loadStakeNow(); if (tab === 'rules') { const c = chain(), d = dep(); if (c && d) loadRules((to, data_) => W.call(c, to, data_), d).then((x) => { rules = x; render(); }).catch(() => { rules = null; render(); }); } render(); }
window.addEventListener('p10k:tab', (e) => setTab(e.detail));
async function onClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return; const a = b.dataset.act, c = chain(), d = dep();
  try {
    if (a === 'appkit') { await W.openAppKit(); return; }
    else if (a === 'tab') { setTab(b.dataset.t); return; }
    else if (a === 'sMax') { $('#sAmt').value = fu(stakeD?.wallet ?? 0n, 18, 6); return; }
    else if (a === 'sStake' || a === 'sUnstake') { const amt = pu($('#sAmt').value || '0', 18); if (amt <= 0n) return toast('enter an amount', true);
      if (a === 'sUnstake') { if (amt > (stakeD?.staked ?? 0n)) return toast('more than you have staked', true); return tx('Unstake', stakeD.staking, enc(SS.unstake, amt)).then(loadStakeNow); }
      if (amt > (stakeD?.wallet ?? 0n)) return toast('more PAPER10KX than in your wallet', true);
      const calls = []; if ((stakeD.allowance ?? 0n) < amt) calls.push({ to: d.px, data: enc(SS.approve, stakeD.staking, amt) }); calls.push({ to: stakeD.staking, data: enc(SS.stake, amt) });
      return txs(calls.length > 1 ? 'Approve + stake' : 'Stake', calls).then(loadStakeNow); }
    else if (a === 'sClaim') return tx('Claim rewards', stakeD.staking, SS.claim).then(loadStakeNow);
    else if (a === 'sWithdraw') return tx('Withdraw unstaked', stakeD.staking, SS.withdrawUnstaked).then(loadStakeNow);
    else if (a === 'injected') { await W.connectInjected(W.injectedProviders()[+b.dataset.i]); }
    else if (a === 'wc') { wcUri = null; await W.connectWalletConnect((u) => { wcUri = u; render(); }, availableChains()[0].id).then(() => { wcUri = null; }); }
    else if (a === 'disc') { await W.disconnect(); }
    else if (a === 'switch') { await W.switchChain(+b.dataset.id); }
    else if (a === 'sign') { await W.signIn(); }
    else if (a === 'side') { $('#cSideV').value = b.dataset.s; for (const x of $('#cSide').children) x.className = x.dataset.s === b.dataset.s ? 'on ' + x.dataset.s : ''; quote(); return; }
    else if (a === 'lev') { $('#cLev').value = b.dataset.n; quote(); return; }
    else if (a === 'faucet') return tx('Faucet', d.collateral, SEL.faucet);
    else if (a === 'deposit') {
      const amt = parseUnits($('#cAmt').value);
      if (amt <= 0n) return toast('enter an amount', true);
      if (amt > (data.usdc ?? 0n)) return toast(`You only have ${fmtUnits(data.usdc ?? 0n)} ${sym()} in your wallet.`, true);
      const allow = toBig((await W.call(c, d.collateral, enc(SEL.allowance, W.state.account, d.exchange))).slice(2));
      const calls = []; if (allow < amt) calls.push({ to: d.collateral, data: enc(SEL.approve, d.exchange, amt) }); // exact amount, never unlimited
      calls.push({ to: d.exchange, data: enc(SEL.deposit, amt) });
      return txs(calls.length > 1 ? 'Approve + deposit' : 'Deposit', calls);
    }
    else if (a === 'withdraw') { const amt = parseUnits($('#cAmt').value); if (amt <= 0n || amt > (data.free ?? 0n)) return toast(`Enter an amount up to your trading balance (${fmtUnits(data.free ?? 0n)}).`, true); return tx('Withdraw', d.exchange, enc(SEL.withdraw, amt)); }
    else if (a === 'open') {
      const mk = +$('#cMkt').value, isLong = $('#cSideV').value === 'long', margin = parseUnits($('#cMargin').value), lev = Math.round(+$('#cLev').value);
      const pr = data?.prices[mk]?.price; const blk = openBlocker(); if (blk) return toast(blk, true);
      const pf = preflight(margin, lev); if (pf) return toast(pf, true);
      // slippage anchor: the venue median when available (the stored on-chain price may be stale; fills use a fresh one)
      const ref = data.refs?.[mk]?.median, anchor = ref > 0 ? pu(ref.toFixed(8), 18) : pr;
      if (!anchor) return toast('No price to anchor the slippage guard.', true);
      const worst = isLong ? anchor * 10010n / 10000n : anchor * 9990n / 10000n; // 10 bps slippage guard (a miss refunds the margin)
      if (data.finalized) { const ok = await tx('Open request', d.exchange, enc(SEL.requestOpen, mk, isLong, margin, lev, worst)); toast('Order placed: a keeper fills it at the first Pyth price published after your request (~1–3 s). If the price moved past your guard, the margin is refunded.'); return ok; }
      return tx('Open', d.exchange, enc(SEL.open, mk, isLong, margin, lev, worst));
    }
    else if (a === 'close') {
      const p = data.positions.find((x) => String(x.id) === b.dataset.id), pr = data.prices[p.market].price;
      // v4: liquidation is a permissionless 2-step (markLiquidatable, >=2 blocks, liquidate) priced by a multi-source oracle. The owner's own
      // close() is always available and the contract decides: hard-bust if the multi-source price agrees, else the (capped) realised loss.
      if (data.finalized) { const ok = await tx('Close request', d.exchange, enc(SEL.requestClose, p.id)); toast('Close requested: filled at the first Pyth price after your request. It cannot be cancelled.'); return ok; }
      return tx('Close', d.exchange, enc(SEL.close, p.id));
    }
    else if (a === 'tpsl') {
      const p = data.positions.find((x) => String(x.id) === b.dataset.id); const e = fmtPx(p.entry);
      const tp = prompt(`Take-profit price (USD), entry ${e}. ${p.isLong ? 'Above' : 'Below'} entry. Empty = none`, ''); if (tp === null) return;
      const sl = prompt(`Stop-loss price (USD), bust ${fmtPx(p.bust)}. ${p.isLong ? 'Below' : 'Above'} entry. Empty = none`, ''); if (sl === null) return;
      const w = (v) => (v && +v > 0 ? pu(v, 18) : 0n), tpw = w(tp), slw = w(sl);
      if (!tpw && !slw) return toast('Enter a take-profit or a stop-loss.', true);
      if (p.isLong ? ((tpw && tpw <= p.entry) || (slw && slw >= p.entry)) : ((tpw && tpw >= p.entry) || (slw && slw <= p.entry))) return toast('Take-profit must be on the profit side of entry, stop-loss on the loss side.', true);
      const calls = []; if (!data.isOp) calls.push({ to: d.exchange, data: enc(SEL.setOperator, d.triggers, true) });
      calls.push({ to: d.triggers, data: enc(SEL.tPlace, p.id, tpw, slw) });
      return txs(calls.length > 1 ? 'Approve trigger + set TP/SL' : 'Set TP/SL', calls);
    }
    else if (a === 'tpcancel') return tx('Cancel TP/SL', d.triggers, enc(SEL.tCancel, BigInt(b.dataset.id)));
    else if (a === 'claim') return tx('Claim badge', d.badges, enc(SEL.bClaim, W.state.account, +b.dataset.t));
    else if (a === 'share') {
      const r = data.results.find((x) => String(x.id) === b.dataset.id);
      await share({ id: String(r.id), market: r.market, sym: MARKETS.find((m) => m.id === r.market)?.sym ?? String(r.market), isLong: r.isLong, lev: r.lev,
        margin: Number(r.margin) / 10 ** DEC, pnl: Number(r.pnl) / 10 ** DEC, liq: r.liq, ts: Math.floor(Date.now() / 1000), chainName: c.name }, b.dataset.how);
      return;
    }
    render(); refresh();
  } catch (err) { toast(err?.message || String(err), true); }
}

document.addEventListener('input', (e) => { if (e.target.closest?.('#chainpanel')) quote(); });
W.onChange(() => { if (mode === 'chain') { setMode('chain'); } });
(async () => { deployments = await loadDeployments(); build(); })();
