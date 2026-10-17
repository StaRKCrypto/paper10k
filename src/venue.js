// Venue = engine (trader accounts) + pool (house). Every trader action settles against the pool. SIMULATED FUNDS ONLY.
// ctx = { pool, accts: { user: engineState, bots: engineState } }
import * as E from './engine.js';
import * as P from './pool.js';

export const BOT_FLOAT = 1_000_000;

export function newCtx(user = E.newState(), pool = P.newPool(), bots = null) {
  const ctx = { pool, accts: { user, bots: bots ?? botState() } };
  return ctx;
}
export function botState() { const s = E.newState(); s.balance = BOT_FLOAT; return s; }

/** Fresh ctx where `pool.ext` already accounts for the accounts' funds (used by tests / first run). */
export function initCtx(user = E.newState(), bots = botState(), pool = P.newPool()) {
  pool.ext += user.balance + bots.balance;
  return { pool, accts: { user, bots } };
}

/** All positions as read-only views with globally unique ids ("user:3"). */
export function views(ctx) {
  const out = [];
  for (const [name, s] of Object.entries(ctx.accts)) for (const p of s.positions) out.push({ ...p, id: name + ':' + p.id, _acct: name, _id: p.id });
  return out;
}
export const snapshot = (ctx, marks) => P.metrics(ctx.pool, views(ctx), marks);

export function open(ctx, acct, o, marks) {
  const s = ctx.accts[acct], v = views(ctx);
  const err = E.validate(s, o) || P.checkOpen(ctx.pool, v, marks, { sym: o.sym, side: o.side, notional: o.margin * o.lev, lev: o.lev });
  if (err) return { error: err };
  const r = E.openMarket(s, o);
  if (r.position) P.onOpen(ctx.pool, r.position);
  return r;
}
export function placeLimit(ctx, acct, o, marks) {
  const s = ctx.accts[acct];
  const err = E.validate(s, o) || P.checkOpen(ctx.pool, views(ctx), marks, { sym: o.sym, side: o.side, notional: o.margin * o.lev, lev: o.lev });
  if (err) return { error: err };
  return E.placeLimit(s, o);
}
export function cancel(ctx, acct, id) { return E.cancelOrder(ctx.accts[acct], id); }

export function close(ctx, acct, id, price, now, reason = 'close', marks = {}) {
  const s = ctx.accts[acct], p = s.positions.find((x) => x.id === id);
  if (!p) return null;
  const v = views(ctx), mm = { ...marks, [p.sym]: price };
  const h = P.metrics(ctx.pool, v, mm).haircut;
  const rec = E.closePosition(s, id, price, now, reason);
  const r = P.onClose(ctx.pool, rec, reason === 'liquidation' ? 1 : h);
  s.balance -= r.delta;
  return rec;
}

/** Advance one account: funding, liquidations, limit fills (gated by caps), then pool-wide ADL. Returns events tagged with acct. */
export function tick(ctx, acct, marks, rates, now) {
  const s = ctx.accts[acct], out = [];
  const hooks = {
    gate: (o) => P.checkOpen(ctx.pool, views(ctx), marks, { sym: o.sym, side: o.side, notional: o.margin * o.lev, lev: o.lev }),
    onEvent: (e) => {
      if (e.type === 'fill') P.onOpen(ctx.pool, e.position);
      else if (e.type === 'liquidation') P.onClose(ctx.pool, e.rec, 1);
    },
  };
  for (const e of E.tick(s, marks, rates, now, hooks)) out.push({ ...e, acct });
  out.push(...adl(ctx, marks, now));
  return out;
}
export function adl(ctx, marks, now) {
  const out = [];
  for (const vid of P.adlPlan(ctx.pool, views(ctx), marks)) {
    const [acct, id] = vid.split(':'), p = ctx.accts[acct].positions.find((x) => x.id === +id);
    if (!p) continue;
    const m = marks[p.sym] > 0 ? marks[p.sym] : p.mark;
    const rec = close(ctx, acct, p.id, m, now, 'adl', marks);
    if (rec) out.push({ type: 'adl', acct, rec });
  }
  return out;
}

// ---- LP (user) ----
export function lpDeposit(ctx, amount, marks, who = 'user') {
  const s = ctx.accts.user;
  if (!(amount > 0)) return { error: 'Enter an amount > 0' };
  if (amount > s.balance + 1e-9) return { error: 'Insufficient available balance' };
  const r = P.deposit(ctx.pool, who, amount, views(ctx), marks);
  if (!r.error) { s.balance -= amount; ctx.pool.cost ??= {}; ctx.pool.cost[who] = (ctx.pool.cost[who] ?? 0) + amount; }
  return r;
}
export function lpWithdraw(ctx, amount, marks, who = 'user') {
  const before = ctx.pool.shares[who] ?? 0;
  const r = P.withdraw(ctx.pool, who, amount, views(ctx), marks);
  if (!r.error) { ctx.accts.user.balance += amount; ctx.pool.cost ??= {}; ctx.pool.cost[who] = (ctx.pool.cost[who] ?? 0) * (before > 0 ? 1 - r.shares / before : 0); }
  return r;
}

/** Bots' float is replenished from newly minted (external) simulated funds; recorded in pool.ext so conservation holds. */
export function topUpBots(ctx) {
  const b = ctx.accts.bots;
  if (b.balance < BOT_FLOAT * 0.05) { ctx.pool.ext += BOT_FLOAT; b.balance += BOT_FLOAT; return true; }
  return false;
}

/** Reset the user's trading account: close everything at mark through the pool, refund orders, then restart at $1,000. LP shares are kept. */
export function resetUser(ctx, marks, now) {
  const s = ctx.accts.user;
  for (const p of [...s.positions]) close(ctx, 'user', p.id, marks[p.sym] > 0 ? marks[p.sym] : p.mark ?? p.entry, now, 'close', marks);
  for (const o of [...s.orders]) E.cancelOrder(s, o.id);
  const fresh = E.newState();
  ctx.pool.ext += fresh.balance - s.balance;
  ctx.accts.user = fresh;
  return fresh;
}

/** Stress drill (simulated whale win): moves pct of pool assets to the bot account as trading loss. Conserves funds. */
export function stressDrill(ctx, pct) {
  const amt = ctx.pool.assets * pct;
  ctx.pool.assets -= amt; ctx.pool.trading -= amt; ctx.accts.bots.balance += amt;
  return amt;
}
