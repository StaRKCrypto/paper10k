// Two-step order filler (SEC-3). Permissionless: anyone can run it; the price is NOT the filler's choice.
// For each Requested(rid) it fetches the Pyth update for publishTime = request.ts + FILL_DELAY from Hermes and calls
// exchange.fill(rid, updateData). The contract accepts only the UNIQUE first Pyth price published in
// [ts+1, ts+11] (parsePriceFeedUpdatesUnique), bounded by Chainlink (+ optional 3rd feed).
// Off-chain venue check is ALERT-ONLY here (see refprice.mjs for why skipping a fill would be wrong).
// Env: RPC_URL, EXCHANGE, KEEPER_PRIVATE_KEY (optional => dry run), PYTH (default Base 0x8250...), PYTH_API_KEY (Authorization: Bearer; Hermes needs a key
// since 2026-08-26; placeholder), HERMES_URL (default https://pyth.dourolabs.app/hermes; auth = Authorization: Bearer, verified live 2026-10-22), PYTH_IDS (json {"0":"0x..","1":"0x.."}).
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fetchRefs, judge, MARKET_SYMBOL } from './refprice.mjs';

const abi = parseAbi([
  'event Requested(uint256 indexed rid, address indexed trader, uint256 posId)',
  'function reqs(uint256) view returns (address trader, uint64 ts, uint32 market, uint32 leverage, bool isLong, uint128 margin, uint128 worst, uint256 posId)',
  'function fill(uint256 rid, bytes[] data) payable',
  'function FILL_DELAY() view returns (uint64)',
]);
const pythAbi = parseAbi(['function getUpdateFee(bytes[] data) view returns (uint256)']);
const DEFAULT_IDS = { // Pyth Core feed ids (BTC/USD, ETH/USD, SOL/USD)
  0: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  1: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  2: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};

export async function hermesAt(publishTime, id, { url = 'https://pyth.dourolabs.app/hermes', apiKey, fetchFn = fetch } = {}) {
  const r = await fetchFn(`${url}/v2/updates/price/${publishTime}?ids[]=${id}&encoding=hex`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!r.ok) throw new Error('hermes http ' + r.status);
  const d = await r.json();
  return { data: d.binary.data.map((h) => '0x' + h), price: d.parsed?.[0]?.price };
}

async function main(env = process.env) {
  const transport = http(env.RPC_URL);
  const pc = createPublicClient({ transport });
  const account = env.KEEPER_PRIVATE_KEY ? privateKeyToAccount(env.KEEPER_PRIVATE_KEY) : undefined;
  const wc = account ? createWalletClient({ account, transport, chain: { id: await pc.getChainId() } }) : undefined;
  const ex = env.EXCHANGE; const pyth = env.PYTH ?? '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a';
  const ids = env.PYTH_IDS ? JSON.parse(env.PYTH_IDS) : DEFAULT_IDS;
  const delay = await pc.readContract({ address: ex, abi, functionName: 'FILL_DELAY' });
  const log = (k, o) => console.log(JSON.stringify({ t: new Date().toISOString(), k, ...o }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const pending = new Set(); let from = BigInt(env.FROM_BLOCK ?? (await pc.getBlockNumber()) - 1000n);
  for (;;) {
    const head = await pc.getBlockNumber();
    if (head >= from) {
      for (const l of await pc.getContractEvents({ address: ex, abi, eventName: 'Requested', fromBlock: from, toBlock: head })) pending.add(l.args.rid);
      from = head + 1n;
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const rid of [...pending]) {
      const r = await pc.readContract({ address: ex, abi, functionName: 'reqs', args: [rid] });
      if (r[1] === 0n) { pending.delete(rid); continue; }            // filled / cancelled
      const t = r[1] + delay; if (now < t + 1n) continue;               // wait until the target price exists
      try {
        const u = await hermesAt(Number(t), ids[r[2]], { url: env.HERMES_URL, apiKey: env.PYTH_API_KEY });
        const px = u.price ? Number(u.price.price) * 10 ** u.price.expo : NaN;
        const v = judge(px, await fetchRefs(MARKET_SYMBOL[r[2]]), { maxBps: Number(env.MAX_REF_DIV_BPS ?? 50) });
        if (v.verdict === 'diverged') log('ALERT_fill_price_diverged', { rid, px, ...v }); // alert only, still fill
        const fee = await pc.readContract({ address: pyth, abi: pythAbi, functionName: 'getUpdateFee', args: [u.data] });
        if (!wc) { log('dry_run_would_fill', { rid, px, fee }); continue; }
        const { request } = await pc.simulateContract({ address: ex, abi, functionName: 'fill', args: [rid, u.data], value: fee, account });
        log('fill_sent', { rid, hash: await wc.writeContract(request) });
      } catch (e) { log('fill_error', { rid, err: e.shortMessage ?? e.message }); }
    }
    await new Promise((s) => setTimeout(s, Number(env.POLL_MS ?? 1000)));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
