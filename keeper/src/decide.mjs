// Pure decision logic (unit-tested). All times are CHAIN time (block timestamp), never wall clock.
// pos state: busted = position past bust by the MULTI-SOURCE liquidation price; mark = {blockNo, ts} (blockNo 0 = none)
export function decide({ busted, mark, blockNumber, blockTs, minBlocks, ttl, safetySecs }) {
  const hasMark = mark.blockNo !== 0n && mark.blockNo !== 0;
  const expired = hasMark && blockTs > mark.ts + BigInt(ttl);
  if (!busted) return hasMark ? 'clear' : 'none';
  if (!hasMark || expired) return 'mark';
  if (BigInt(blockNumber) < BigInt(mark.blockNo) + BigInt(minBlocks)) return 'wait';
  // liquidate needs block.timestamp <= mark.ts + ttl at INCLUSION time; leave a safety margin for inclusion delay
  const remaining = mark.ts + BigInt(ttl) - blockTs;
  if (remaining < BigInt(safetySecs)) return 'wait_expiry'; // too late to be safe: let it expire then re-mark
  return 'liquidate';
}
export const isBusted = (isLong, price, bust) => (isLong ? price <= bust : price >= bust);
