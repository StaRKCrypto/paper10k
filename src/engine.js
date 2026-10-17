// Pure trading math for the simulator. No DOM, no network. See README for formulas.
export const CFG = {
  MAX_LEV: 10000,
  MIN_LEV: 1,
  MIN_MARGIN: 1,          // USD
  TAKER_FEE: 0.00035,     // 3.5 bps of notional, charged from free balance on open and close
  MAINT: 0.10,            // maintenance margin = 10% of initial margin
  START_BALANCE: 1000,
  DEFAULT_FUNDING_HR: 0.0000125, // 0.00125%/h (Hyperliquid baseline) when no live rate known
};

const sgn = (side) => (side === 'long' ? 1 : -1);

export function newState() {
  return { v: 1, balance: CFG.START_BALANCE, positions: [], orders: [], history: [], nextId: 1, liquidations: 0, startedAt: Date.now() };
}

export function notional(margin, lev) { return margin * lev; }
export function sizeOf(margin, lev, price) { return (margin * lev) / price; }
export function fee(notionalUsd) { return notionalUsd * CFG.TAKER_FEE; }

/** Liquidation price. funding = funding already paid (+) / received (-) by the position, in USD. */
export function liqPrice(side, entry, size, margin, funding = 0) {
  const buffer = (margin * (1 - CFG.MAINT) - funding) / size; // price distance until equity == maintenance
  return side === 'long' ? entry - buffer : entry + buffer;
}
export function liqDistancePct(side, entry, lev) { return ((1 - CFG.MAINT) / lev) * 100; }
export function upnl(p, mark) { return sgn(p.side) * (mark - p.entry) * p.size; }
export function equityOf(p, mark) { return p.margin + upnl(p, mark) - p.funding; }
export function posLiq(p) { return liqPrice(p.side, p.entry, p.size, p.margin, p.funding); }
export function isLiquidated(p, mark) { return equityOf(p, mark) <= p.margin * CFG.MAINT; }
export function maxMargin(balance, lev) { return Math.max(0, balance / (1 + lev * CFG.TAKER_FEE)); }

export function validate(state, { margin, lev }) {
  if (!(margin >= CFG.MIN_MARGIN)) return `Minimum margin is $${CFG.MIN_MARGIN}`;
  if (!(lev >= CFG.MIN_LEV && lev <= CFG.MAX_LEV)) return `Leverage must be ${CFG.MIN_LEV}-${CFG.MAX_LEV}x`;
  if (margin + fee(margin * lev) > state.balance + 1e-9) return 'Insufficient balance (margin + fee)';
  return null;
}

function openAt(state, { sym, side, margin, lev, price, now, fundingRate }) {
  const n = margin * lev, f = fee(n);
  const p = { id: state.nextId++, sym, side, entry: price, size: n / price, margin, lev, openedAt: now, funding: 0, lastFundingAt: now, fundingRate: fundingRate ?? CFG.DEFAULT_FUNDING_HR, openFee: f, mark: price };
  state.positions.push(p);
  return p;
}

export function openMarket(state, o) {
  const err = validate(state, o);
  if (err) return { error: err };
  state.balance -= o.margin + fee(o.margin * o.lev);
  return { position: openAt(state, o) };
}

export function placeLimit(state, o) {
  const err = validate(state, o);
  if (err) return { error: err };
  if (!(o.limitPrice > 0)) return { error: 'Invalid limit price' };
  state.balance -= o.margin + fee(o.margin * o.lev); // reserved; refunded on cancel
  const ord = { id: state.nextId++, sym: o.sym, side: o.side, margin: o.margin, lev: o.lev, limitPrice: o.limitPrice, createdAt: o.now };
  state.orders.push(ord);
  return { order: ord };
}

export function cancelOrder(state, id) {
  const i = state.orders.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const o = state.orders[i];
  state.balance += o.margin + fee(o.margin * o.lev);
  state.orders.splice(i, 1);
  return true;
}

/** Close at `price`. reason: 'close' | 'liquidation'. Liquidation forfeits all margin, no closing fee. */
export function closePosition(state, id, price, now, reason = 'close') {
  const i = state.positions.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const p = state.positions[i];
  state.positions.splice(i, 1);
  let proceeds = 0, closeFee = 0, pnlRaw = upnl(p, price);
  if (reason === 'liquidation') {
    pnlRaw = upnl(p, price);
  } else {
    proceeds = Math.max(0, p.margin + pnlRaw - p.funding); // isolated: loss capped at margin
    closeFee = reason === 'close' ? fee(p.size * price) : 0; // 'adl' (auto-deleverage) closes are fee-free
    closeFee = Math.min(closeFee, proceeds); // never push balance below what the position returned
  }
  state.balance += proceeds - closeFee;
  const pnl = (reason === 'liquidation' ? -p.margin : proceeds - p.margin) - p.openFee - closeFee;
  const rec = { id: p.id, sym: p.sym, side: p.side, lev: p.lev, size: p.size, margin: p.margin, entry: p.entry, exit: price, openedAt: p.openedAt, closedAt: now, pnl, funding: p.funding, fees: p.openFee + closeFee, openFee: p.openFee, closeFee, proceeds, reason };
  state.history.unshift(rec);
  if (state.history.length > 500) state.history.length = 500;
  if (reason === 'liquidation') state.liquidations++;
  return rec;
}

export function accrueFunding(p, mark, now) {
  const dtH = Math.max(0, now - p.lastFundingAt) / 3600000;
  p.funding += sgn(p.side) * p.size * mark * p.fundingRate * dtH; // longs pay when rate > 0
  p.lastFundingAt = now;
}

/**
 * Advance the sim. marks: {sym: price}, rates: {sym: hourlyRate}. Returns events [{type, ...}].
 * Liquidation is checked first; liquidated positions close at their liquidation price.
 */
export function tick(state, marks, rates, now, hooks = {}) {
  const events = [], emit = (e) => { events.push(e); hooks.onEvent?.(e); };
  for (const p of [...state.positions]) {
    const m = marks[p.sym];
    if (!(m > 0)) continue;
    if (rates && rates[p.sym] != null) p.fundingRate = rates[p.sym];
    accrueFunding(p, m, now);
    p.mark = m;
    if (isLiquidated(p, m)) {
      const rec = closePosition(state, p.id, m, now, 'liquidation');
      emit({ type: 'liquidation', rec });
    }
  }
  for (const o of [...state.orders]) {
    const m = marks[o.sym];
    if (!(m > 0)) continue;
    const hit = o.side === 'long' ? m <= o.limitPrice : m >= o.limitPrice;
    if (!hit) continue;
    state.orders.splice(state.orders.indexOf(o), 1);
    const why = hooks.gate ? hooks.gate(o, m) : null; // venue risk gate (caps); rejected orders are refunded
    if (why) { state.balance += o.margin + fee(o.margin * o.lev); emit({ type: 'reject', order: o, reason: why }); continue; }
    // reserved margin+fee already deducted; open directly at limit price
    const p = openAt(state, { sym: o.sym, side: o.side, margin: o.margin, lev: o.lev, price: o.limitPrice, now, fundingRate: rates?.[o.sym] });
    p.mark = m;
    emit({ type: 'fill', position: p });
    if (isLiquidated(p, m)) emit({ type: 'liquidation', rec: closePosition(state, p.id, m, now, 'liquidation') });
  }
  return events;
}

export function totalEquity(state, marks) {
  let e = state.balance;
  for (const o of state.orders) e += o.margin + fee(o.margin * o.lev);
  for (const p of state.positions) e += equityOf(p, marks[p.sym] > 0 ? marks[p.sym] : p.entry);
  return e;
}
