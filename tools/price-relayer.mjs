#!/usr/bin/env node
// Signed-price relayer for the TESTNET SignedPriceOracle. Pulls Hyperliquid mids (public, no key), signs EIP-712 Price,
// and submits updatePrice(). The key (RELAYER_KEY env) must be the oracle's `signer` and hold a little testnet gas.
// NEVER use a key that holds real funds. Usage:
//   RELAYER_KEY=0x.. ORACLE=0x.. RPC=https://... CHAIN_ID=998 node tools/price-relayer.mjs [--interval 5] [--fixed BTC=100000,ETH=3500]
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const env = process.env;
for (const k of ['RELAYER_KEY', 'ORACLE', 'RPC', 'CHAIN_ID']) if (!env[k]) { console.error('missing env ' + k); process.exit(1); }
const args = process.argv.slice(2); const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const interval = +arg('--interval', 5) * 1000; const fixed = arg('--fixed', null);
const chain = defineChain({ id: +env.CHAIN_ID, name: 'x', nativeCurrency: { name: 'e', symbol: 'e', decimals: 18 }, rpcUrls: { default: { http: [env.RPC] } } });
const account = privateKeyToAccount(env.RELAYER_KEY);
const wc = createWalletClient({ account, chain, transport: http(env.RPC) }), pc = createPublicClient({ chain, transport: http(env.RPC) });
const abi = parseAbi(['function updatePrice(uint32 market,uint256 price,uint64 ts,bytes sig)']);
const MARKETS = { BTC: 0, ETH: 1 };
const types = { Price: [{ name: 'market', type: 'uint32' }, { name: 'price', type: 'uint256' }, { name: 'timestamp', type: 'uint64' }] };
async function prices() {
  if (fixed) return Object.fromEntries(fixed.split(',').map((x) => x.split('=')).map(([k, v]) => [k, +v]));
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) });
  const m = await r.json(); return { BTC: +m.BTC, ETH: +m.ETH };
}
async function tick() {
  const p = await prices();
  for (const [sym, id] of Object.entries(MARKETS)) {
    if (!p[sym]) continue;
    const price = BigInt(Math.round(p[sym] * 1e6)) * 10n ** 12n; const ts = BigInt((await pc.getBlock()).timestamp);
    const signature = await account.signTypedData({ domain: { name: 'Paper10kOracle', version: '1', chainId: +env.CHAIN_ID, verifyingContract: env.ORACLE }, types, primaryType: 'Price', message: { market: id, price, timestamp: ts } });
    try { const h = await wc.writeContract({ address: env.ORACLE, abi, functionName: 'updatePrice', args: [id, price, ts, signature] }); console.log(new Date().toISOString(), sym, p[sym], h); }
    catch (e) { console.error(sym, 'update failed:', e.shortMessage || e.message); }
  }
}
await tick(); setInterval(() => tick().catch((e) => console.error(e.message)), interval);
