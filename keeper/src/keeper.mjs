import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { exchangeAbi, oracleAbi } from './abi.mjs';
import { decide, isBusted } from './decide.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRevert = (e) => /revert|ContractFunctionRevertedError|execution reverted|MarkNotReady|NotLiquidatable|PriceBad/i.test(e?.name + ' ' + (e?.shortMessage ?? e?.message ?? ''));

export async function createKeeper(cfg, log) {
  const transport = http(cfg.rpcUrl, { retryCount: 0, timeout: 15_000 });
  const probe = createPublicClient({ transport });
  const chainId = cfg.chainId ?? (await probe.getChainId());
  if (chainId === 999 && !cfg.allowMainnet) throw new Error('refusing chain 999 (HyperEVM mainnet): mainnet flag is OFF');
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const pc = createPublicClient({ chain, transport, pollingInterval: Math.min(cfg.pollMs, 1000) });
  const account = cfg.key ? privateKeyToAccount(cfg.key) : undefined; // key is only ever held here
  const wc = account ? createWalletClient({ account, chain, transport }) : undefined;
  const ex = cfg.exchange;

  // retry with exponential backoff + jitter for transient RPC problems (NOT for contract reverts)
  async function retry(label, fn) {
    let lastErr;
    for (let a = 0; a <= cfg.maxRetries; a++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (isRevert(e)) throw e;
        const wait = Math.min(30_000, cfg.backoffMs * 2 ** a) * (0.75 + Math.random() * 0.5);
        log.warn('retry', { label, attempt: a + 1, of: cfg.maxRetries + 1, waitMs: Math.round(wait), err: e.shortMessage ?? e.message });
        if (a < cfg.maxRetries) await sleep(wait);
      }
    }
    throw lastErr;
  }
  const read = (functionName, args = []) => retry(functionName, () => pc.readContract({ address: ex, abi: exchangeAbi, functionName, args }));

  const consts = { minBlocks: Number(await read('MARK_MIN_BLOCKS')), ttl: Number(await read('MARK_TTL')) };
  const oracle = await read('oracle');
  const open = new Set(); let scanned = cfg.fromBlock > 0n ? cfg.fromBlock - 1n : -1n;
  log.info('start', { chainId, exchange: ex, oracle, keeper: account?.address ?? null, dryRun: cfg.dryRun, ...consts, maxGasPriceWei: cfg.maxGasPriceWei });

  async function discover() {
    const head = await retry('blockNumber', () => pc.getBlockNumber());
    while (scanned < head) {
      const from = scanned + 1n; const to = from + cfg.logChunk - 1n > head ? head : from + cfg.logChunk - 1n;
      const logs = await retry('getLogs', () => pc.getContractEvents({ address: ex, abi: exchangeAbi, eventName: 'Opened', fromBlock: from, toBlock: to }));
      for (const l of logs) open.add(l.args.id);
      scanned = to;
    }
  }

  async function sendTx(functionName, id, ctx) {
    const base = { fn: functionName, id, ...ctx };
    let gasPrice;
    try { gasPrice = await retry('gasPrice', () => pc.getGasPrice()); } catch (e) { log.error('gas_price_failed', { ...base, err: e.shortMessage ?? e.message }); return false; }
    if (gasPrice > cfg.maxGasPriceWei) { log.warn('gas_price_above_cap', { ...base, gasPrice, cap: cfg.maxGasPriceWei }); return false; }
    let request;
    try { ({ request } = await pc.simulateContract({ address: ex, abi: exchangeAbi, functionName, args: [id], account: account?.address ?? '0x0000000000000000000000000000000000000001' })); }
    catch (e) { log.warn('simulation_reverted', { ...base, err: e.shortMessage ?? e.message }); return false; }
    if (cfg.dryRun) { log.info('dry_run_would_send', { ...base, gasPrice }); return true; }
    try {
      const hash = await retry('send:' + functionName, () => wc.writeContract({ ...request, gasPrice }));
      const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs });
      log[rcpt.status === 'success' ? 'info' : 'error']('tx_' + rcpt.status, { ...base, hash, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed });
      return rcpt.status === 'success';
    } catch (e) { log.error('tx_failed', { ...base, err: e.shortMessage ?? e.message }); return false; }
  }

  async function cycle() {
    await discover();
    if (await read('paused')) { log.debug('paused'); return { checked: 0 }; }
    const block = await retry('getBlock', () => pc.getBlock());
    const o = await read('ops');
    const stats = { checked: 0, mark: 0, liquidate: 0, clear: 0, wait: 0 };
    for (const id of [...open]) {
      const p = await read('positions', [id]);
      if (p[0] === '0x0000000000000000000000000000000000000000') { open.delete(id); continue; }
      const [, market, , , isLong, margin] = p;
      let lp;
      try { [lp] = await retry('liqPrice', () => pc.readContract({ address: oracle, abi: oracleAbi, functionName: 'getLiquidationPrice', args: [market, isLong] })); }
      catch (e) { log.warn('liq_price_error', { id, err: e.shortMessage ?? e.message }); continue; }
      stats.checked++;
      if (lp === 0n) { log.debug('liq_price_unavailable', { id }); continue; } // guard tripped: cannot mark/liquidate (users can still close)
      const bust = await read('bustPriceOf', [id]);
      const [mb, mts] = await read('marks', [id]);
      const action = decide({ busted: isBusted(isLong, lp, bust), mark: { blockNo: BigInt(mb), ts: BigInt(mts) }, blockNumber: block.number, blockTs: block.timestamp, ...consts, safetySecs: cfg.safetySecs });
      const ctx = { market, isLong, liqPrice: lp, bust, markBlock: mb, block: block.number, chainTs: block.timestamp };
      if (action === 'none') continue;
      if (action === 'wait' || action === 'wait_expiry') { stats.wait++; log.debug(action, { id, ...ctx }); continue; }
      if (action === 'liquidate') {
        const expected = (BigInt(margin) * BigInt(o[3])) / 10_000n; const bounty = expected > o[4] ? o[4] : expected;
        if (account && p[0].toLowerCase() === account.address.toLowerCase()) { log.warn('skip_own_position', { id }); continue; }
        if (bounty < cfg.minExpectedBounty) { log.info('skip_low_bounty', { id, bounty, min: cfg.minExpectedBounty }); continue; }
        if (await sendTx('liquidate', id, { ...ctx, expectedBounty: bounty })) stats.liquidate++;
      } else if (action === 'mark') { if (await sendTx('markLiquidatable', id, ctx)) stats.mark++; }
      else if (action === 'clear') { if (await sendTx('clearMark', id, ctx)) stats.clear++; }
    }
    return stats;
  }

  return { cycle, open, consts, account };
}
