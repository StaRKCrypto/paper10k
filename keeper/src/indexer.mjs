// Season indexer: reads Opened/Closed/Liquidated logs and writes a static leaderboard JSON for the UI (seasons.json next to index.html).
// Read-only: never needs a key. Env: RPC_URL, EXCHANGE, FROM_BLOCK, LOG_CHUNK, SEASONS_FILE (input config), OUT (output path).
import { createPublicClient, http, parseAbi } from 'viem';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { computeSeasons, toJSON } from './seasons.mjs';

const abi = parseAbi([
  'event Opened(uint256 indexed id, address indexed user, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 entry, uint32 leverage)',
  'event Closed(uint256 indexed id, address indexed user, uint256 exitPrice, uint256 returned, uint256 profitPaid, uint256 profitQueued, uint256 loss)',
  'event Liquidated(uint256 indexed id, address indexed user, address indexed keeper, uint256 price, uint256 margin, uint256 minted)',
]);

async function retry(fn, n = 5, ms = 500) {
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) { if (a >= n) throw e; await new Promise((r) => setTimeout(r, Math.min(30_000, ms * 2 ** a))); }
  }
}

export async function run(env = process.env) {
  for (const k of ['RPC_URL', 'EXCHANGE']) if (!env[k]) throw new Error(`missing env ${k}`);
  const pc = createPublicClient({ transport: http(env.RPC_URL, { retryCount: 0, timeout: 15_000 }) });
  const seasons = JSON.parse(readFileSync(env.SEASONS_FILE ?? 'seasons.config.json', 'utf8')).seasons;
  const chunk = BigInt(env.LOG_CHUNK ?? '2000');
  const head = await retry(() => pc.getBlockNumber());
  const tsCache = new Map();
  const tsOf = async (bn) => { if (!tsCache.has(bn)) tsCache.set(bn, Number((await retry(() => pc.getBlock({ blockNumber: bn }))).timestamp)); return tsCache.get(bn); };
  const events = [];
  for (let from = BigInt(env.FROM_BLOCK ?? '0'); from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await retry(() => pc.getContractEvents({ address: env.EXCHANGE, abi, fromBlock: from, toBlock: to }));
    for (const l of logs) events.push({ name: l.eventName, ts: await tsOf(l.blockNumber), args: l.args });
  }
  const res = computeSeasons(events, seasons);
  const out = env.OUT ?? 'seasons.json', tmp = out + '.tmp';
  writeFileSync(tmp, toJSON({ generatedAt: Math.floor(Date.now() / 1000), head: head.toString(), note: 'PAPER10KX score has no cash value', seasons: res }));
  renameSync(tmp, out); // atomic for the static site
  return { events: events.length, head };
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((r) => console.log(JSON.stringify({ ok: true, events: r.events, head: r.head.toString() }))).catch((e) => { console.error(JSON.stringify({ ok: false, err: e.shortMessage ?? e.message })); process.exit(1); });
