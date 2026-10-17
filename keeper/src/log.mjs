// Structured JSON-lines logger. Never logs secrets (the key is never passed here). No network.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function makeLogger(level = 'info', out = process.stdout) {
  const min = LEVELS[level] ?? 20;
  const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
  const emit = (lvl) => (event, fields = {}) => { if (LEVELS[lvl] >= min) out.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...fields }, replacer) + '\n'); };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
