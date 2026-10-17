#!/usr/bin/env node
// Read-only measurement against public HyperEVM testnet RPC (no key, no tx): block cadence, oraclePx update cadence, BBO spread, mid-vs-oraclePx deviation.
// usage: node measure-998.mjs [seconds] [rpc]
const RPC = process.argv[3] || 'https://rpc.hyperliquid-testnet.xyz/evm', SECS = Number(process.argv[2] || 90);
const call = async (m, p) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json()).result;
const pre = (a, i) => call('eth_call', [{ to: a, data: '0x' + i.toString(16).padStart(64, '0') }, 'latest']);
const OPX = '0x0000000000000000000000000000000000000807', BBO = '0x000000000000000000000000000000000000080e';
const mk = [['BTC', 0, 5], ['ETH', 1, 4]];
const blocks = [], t0 = Date.now(), ch = {}, rows = [];
let lastN = -1, lat = [];
while (Date.now() - t0 < SECS * 1000) {
  const s = Date.now(); const b = await call('eth_getBlockByNumber', ['latest', false]); lat.push(Date.now() - s);
  const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16);
  if (n !== lastN) { blocks.push([n, ts]); lastN = n; }
  for (const [nm, i, sz] of mk) {
    const o = BigInt(await pre(OPX, i)), r = await pre(BBO, i), bid = BigInt('0x' + r.slice(2, 66)), ask = BigInt('0x' + r.slice(66, 130));
    const k = nm; if (ch[k] === undefined) ch[k] = { last: o, times: [], changes: 0 };
    if (o !== ch[k].last) { ch[k].changes++; ch[k].times.push(Date.now() / 1000); ch[k].last = o; }
    const sc = 10 ** (6 - sz); rows.push({ nm, n, ts, opx: Number(o) / sc, bid: Number(bid) / sc, ask: Number(ask) / sc });
  }
  await new Promise((r) => setTimeout(r, 700));
}
const dn = blocks.at(-1)[0] - blocks[0][0], dt = blocks.at(-1)[1] - blocks[0][1];
const out = { rpc: RPC, window_s: SECS, blocks_seen: blocks.length, block_span: dn, chain_seconds: dt, avg_block_time_s: +(dt / dn).toFixed(3), blocks_per_s_wall: +(dn / ((Date.now() - t0) / 1000)).toFixed(2), rpc_latency_ms_avg: Math.round(lat.reduce((a, b) => a + b) / lat.length), markets: {} };
for (const [nm] of mk) {
  const r = rows.filter((x) => x.nm === nm), sp = r.map((x) => (x.ask - x.bid) * 2e4 / (x.ask + x.bid)), dv = r.map((x) => Math.abs((x.ask + x.bid) / 2 - x.opx) * 1e4 / x.opx);
  const t = ch[nm].times, gaps = t.slice(1).map((v, i) => v - t[i]);
  const st = (a) => a.length ? { min: +Math.min(...a).toFixed(1), avg: +(a.reduce((x, y) => x + y) / a.length).toFixed(1), max: +Math.max(...a).toFixed(1) } : null;
  out.markets[nm] = { samples: r.length, oraclePx_changes: ch[nm].changes, oraclePx_update_gap_s: gaps.length ? { avg: +(gaps.reduce((x, y) => x + y) / gaps.length).toFixed(2), max: +Math.max(...gaps).toFixed(2) } : null, spread_bps: st(sp), mid_vs_oraclePx_bps: st(dv), sample: r.at(-1) };
}
console.log(JSON.stringify(out, null, 1));
