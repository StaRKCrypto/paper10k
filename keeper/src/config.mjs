// Config comes from ENV + CLI flags only. The private key is read from KEEPER_PRIVATE_KEY and nowhere else (never a file, never an argument).
export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(n);
  const need = (k) => { if (!env[k]) throw new Error(`missing env ${k}`); return env[k]; };
  const cfg = {
    rpcUrl: need('RPC_URL'),
    exchange: need('EXCHANGE'),
    chainId: env.CHAIN_ID ? Number(env.CHAIN_ID) : undefined,
    fromBlock: BigInt(env.FROM_BLOCK ?? '0'),
    pollMs: Number(env.POLL_MS ?? 1000),
    logChunk: BigInt(env.LOG_CHUNK ?? '2000'),
    maxGasPriceWei: BigInt(Math.floor(Number(env.MAX_GAS_PRICE_GWEI ?? '5') * 1e9)),
    maxRetries: Number(env.MAX_RETRIES ?? 4),
    backoffMs: Number(env.BACKOFF_MS ?? 500),
    safetySecs: Number(env.SAFETY_SECS ?? 20),
    minExpectedBounty: BigInt(env.MIN_EXPECTED_BOUNTY ?? '0'), // collateral base units; skip liquidations paying less
    receiptTimeoutMs: Number(env.RECEIPT_TIMEOUT_MS ?? 60_000),
    refCheck: env.REF_CHECK !== '0',                          // off-chain venue median check before marking (default on)
    maxRefDivBps: Number(env.MAX_REF_DIV_BPS ?? 50),          // skip+alert above this divergence from the venue median
    logLevel: env.LOG_LEVEL ?? 'info',
    once: flag('--once'),
    dryRun: flag('--dry-run') || env.DRY_RUN === '1',
    allowMainnet: env.ALLOW_MAINNET === 'I_ACCEPT_REAL_FUNDS_RISK',
    key: env.KEEPER_PRIVATE_KEY, // may be undefined => forced dry-run
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.exchange)) throw new Error('EXCHANGE must be a 0x address');
  if (cfg.key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(cfg.key)) throw new Error('KEEPER_PRIVATE_KEY must be 0x + 64 hex chars (value not shown)');
  if (!cfg.key) cfg.dryRun = true;
  return cfg;
}
