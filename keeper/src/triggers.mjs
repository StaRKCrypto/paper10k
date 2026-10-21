#!/usr/bin/env node
// TP/SL trigger keeper for the TriggerOrders periphery. Env: RPC_URL, TRIGGERS (address), FROM_BLOCK, POLL_MS, LOG_CHUNK,
// MAX_GAS_PRICE_GWEI, KEEPER_PRIVATE_KEY (optional; absent => dry-run). Key is never logged. Earns nothing: it is a service.
import { createPublicClient, createWalletClient, http, parseAbi, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeLogger } from './log.mjs';

const abi = parseAbi([
  'event Placed(uint256 indexed id, address indexed owner, uint256 tp, uint256 sl)',
  'function check(uint256 id) view returns (uint8 hit, uint256 price)',
  'function orders(uint256 id) view returns (uint128 tp, uint128 sl, address owner)',
  'function execute(uint256 id)',
]);
const env = process.env; const log = makeLogger(env.LOG_LEVEL ?? 'info');
for (const k of ['RPC_URL', 'TRIGGERS']) if (!env[k]) { log.error('config', { err: `missing env ${k}` }); process.exit(2); }
if (env.KEEPER_PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(env.KEEPER_PRIVATE_KEY)) { log.error('config', { err: 'KEEPER_PRIVATE_KEY malformed (value not shown)' }); process.exit(2); }
const transport = http(env.RPC_URL, { retryCount: 0, timeout: 15_000 });
const chainId = await createPublicClient({ transport }).getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
const pc = createPublicClient({ chain, transport });
const account = env.KEEPER_PRIVATE_KEY ? privateKeyToAccount(env.KEEPER_PRIVATE_KEY) : undefined;
const wc = account ? createWalletClient({ account, chain, transport }) : undefined;
const maxGas = BigInt(Math.floor(Number(env.MAX_GAS_PRICE_GWEI ?? '1') * 1e9));
const chunk = BigInt(env.LOG_CHUNK ?? '2000'); const T = env.TRIGGERS;
async function retry(label, fn, n = 4) {
  for (let a = 0; ; a++) { try { return await fn(); } catch (e) {
    if (/revert/i.test(e?.shortMessage ?? e?.message ?? '') || a >= n) throw e;
    log.warn('retry', { label, attempt: a + 1, err: e.shortMessage ?? e.message }); await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** a)));
  } }
}
const live = new Set(); let from = BigInt(env.FROM_BLOCK ?? '0'); let stop = false;
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
log.info('start', { chainId, triggers: T, dryRun: !wc });
while (!stop) {
  try {
    const head = await retry('head', () => pc.getBlockNumber());
    for (; from <= head; from += chunk) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      for (const l of await retry('logs', () => pc.getContractEvents({ address: T, abi, eventName: 'Placed', fromBlock: from, toBlock: to }))) live.add(l.args.id);
    }
    for (const id of [...live]) {
      const [, , owner] = await retry('order', () => pc.readContract({ address: T, abi, functionName: 'orders', args: [id] }));
      if (owner === '0x0000000000000000000000000000000000000000') { live.delete(id); continue; }
      const [hit, price] = await retry('check', () => pc.readContract({ address: T, abi, functionName: 'check', args: [id] }));
      if (hit === 0) continue;
      const gasPrice = await retry('gas', () => pc.getGasPrice());
      if (gasPrice > maxGas) { log.warn('gas_too_high', { id: String(id), gasPrice: String(gasPrice) }); continue; }
      if (!wc) { log.info('would_execute', { id: String(id), hit, price: String(price) }); continue; }
      try {
        const { request } = await pc.simulateContract({ account, address: T, abi, functionName: 'execute', args: [id] });
        const hash = await retry('send', () => wc.writeContract({ ...request, gasPrice }));
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
        log.info('executed', { id: String(id), hit, hash, status: rc.status }); if (rc.status === 'success') live.delete(id);
      } catch (e) { log.warn('execute_failed', { id: String(id), err: e.shortMessage ?? e.message }); } // e.g. TooSoon: retried next cycle
    }
  } catch (e) { log.error('cycle_failed', { err: e.shortMessage ?? e.message }); }
  if (env.ONCE === '1') break;
  await new Promise((r) => setTimeout(r, Number(env.POLL_MS ?? 1000)));
}
