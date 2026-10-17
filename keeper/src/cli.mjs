#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { makeLogger } from './log.mjs';
import { createKeeper } from './keeper.mjs';

let cfg; try { cfg = loadConfig(); } catch (e) { process.stderr.write(JSON.stringify({ level: 'error', event: 'config', err: e.message }) + '\n'); process.exit(2); }
const log = makeLogger(cfg.logLevel);
const keeper = await createKeeper(cfg, log).catch((e) => { log.error('init_failed', { err: e.message }); process.exit(1); });
let stop = false; for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; log.info('stopping', { signal: s }); });
let failures = 0;
while (!stop) {
  try { const st = await keeper.cycle(); failures = 0; if (st.mark || st.liquidate || st.clear) log.info('cycle', st); else log.debug('cycle', st); }
  catch (e) { failures++; log.error('cycle_failed', { err: e.shortMessage ?? e.message, failures }); }
  if (cfg.once) break;
  await new Promise((r) => setTimeout(r, Math.min(30_000, cfg.pollMs * (1 + Math.min(failures, 5)))));
}
