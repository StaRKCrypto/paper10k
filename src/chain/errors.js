// Human-readable messages for contract reverts (custom-error selectors computed with `cast sig`) and common wallet errors.
const E = {
  '0xde17a3af': 'Invalid parameter.', '0x665c1c57': 'Market is not listed.', '0x0b5f6bf0': 'This market is closed to new positions (existing positions can still close).',
  '0x43e0dfdd': 'Leverage is above the current maximum.', '0x50cb02e4': 'Margin or notional is outside the allowed range (check min/max margin and min/max notional).',
  '0xe9fef498': 'A risk cap is reached: open-interest cap, your per-wallet margin cap, the house-pool utilisation cap or the deposit cap. Try a smaller size.',
  '0x43109855': 'Oracle price unavailable or stale. Trading resumes when the price feed is fresh.', '0x7dd37f70': 'Price moved past your slippage limit. Try again.',
  '0x0aff6f5d': 'You do not own this position.', '0x6fed7d85': 'Too soon: positions must be held for the minimum hold time (and at least one block).',
  '0xddeb79ba': 'Position is not liquidatable.', '0x02ab7b1a': 'Liquidation needs a mark at least 2 blocks earlier.', '0x170aba98': 'Position is still past its bust price.',
  '0xfaf3f41e': 'Withdrawal would dip into reserved liabilities.', '0xfa9ec973': 'Insufficient trading balance. Deposit first.', '0xfdff204a': 'Collateral transfer amount mismatch.',
  '0x07953e9a': 'Not in emergency mode.', '0xef6d0f02': 'Only the owner or guardian can do this.', '0x57d96db2': 'Timelock delay has not passed yet.', '0x175c1aea': 'Nothing pending.',
  '0x3d91129f': 'Circuit breaker: the price moved too fast. New positions are paused for up to a minute; closing still works.',
  '0xd93c0665': 'The exchange is paused. Withdrawals of your free balance still work.',
  '0x30cd7471': 'Not your order.', '0x19aad573': 'No such order.', '0xcbc95a6c': 'Trigger price not reached yet.', '0xe1227653': 'Take-profit must be on the profit side of entry and stop-loss on the loss side.',
  '0xc19f17a9': 'Approve the trigger contract as a close-only operator first.', '0xa4420a95': 'Badges are soulbound.', '0x21a9b143': 'Unknown badge tier.', '0xf8eb54de': 'Not eligible for this badge yet.',
  '0xe450d38c': 'Insufficient USDC balance.', '0xfb8f41b2': 'USDC allowance too low: approve first.',
};
export function friendly(e) {
  const s = [e?.data, e?.data?.data, e?.error?.data, e?.cause?.data, e?.message].map((x) => (typeof x === 'string' ? x : '')).join(' ');
  const m = s.match(/0x[0-9a-fA-F]{8}/g) || [];
  for (const sel of m) { const t = E[sel.toLowerCase()]; if (t) return t; }
  if (e?.code === 4001 || /user rejected|denied|rejected the request/i.test(e?.message || '')) return 'Request rejected in wallet.';
  if (e?.code === 4902) return 'This network is not added to your wallet.';
  if (/insufficient funds/i.test(e?.message || '')) return 'Not enough ETH for gas on this network.';
  if (/reverted/i.test(e?.message || '')) return 'Transaction reverted on-chain. Refresh and check limits, price freshness and pause status.';
  return e?.shortMessage || e?.message || String(e);
}
