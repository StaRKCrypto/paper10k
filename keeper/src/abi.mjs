import { parseAbi } from 'viem';
export const exchangeAbi = parseAbi([
  'function oracle() view returns (address)',
  'function nextPositionId() view returns (uint256)',
  'function positions(uint256) view returns (address owner, uint32 market, uint16 leverage, uint32 pv, bool isLong, uint128 margin, uint128 notional, uint128 entry, uint64 openedAt, uint32 openedBlock)',
  'function bustPriceOf(uint256) view returns (uint256)',
  'function marks(uint256) view returns (uint32 blockNo, uint64 ts)',
  'function ops() view returns (uint128 maxTotalDeposits, uint64 maxPriceAge, uint64 minHold, uint16 bountyBps, uint128 bountyCap)',
  'function MARK_MIN_BLOCKS() view returns (uint32)',
  'function MARK_TTL() view returns (uint64)',
  'function paused() view returns (bool)',
  'function markLiquidatable(uint256 id)',
  'function liquidate(uint256 id)',
  'function clearMark(uint256 id)',
  'event Opened(uint256 indexed id, address indexed user, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 entry, uint32 leverage)',
]);
export const oracleAbi = parseAbi(['function getLiquidationPrice(uint32 market, bool forLong) view returns (uint256 price, uint64 updatedAt)']);
