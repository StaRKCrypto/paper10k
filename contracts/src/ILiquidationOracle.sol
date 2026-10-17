// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Optional oracle extension used ONLY for liquidations (audit v4, F5). It must return a price that no single source can move:
///         e.g. the median of >=3 independent sources, or, with 2 sources, the one LEAST favourable to liquidating (`forLong` => max, short => min).
///         (0,0) = unavailable => the exchange cannot mark/liquidate (fails closed) but users can still close voluntarily (F8).
interface ILiquidationOracle {
    function getLiquidationPrice(uint32 market, bool forLong) external view returns (uint256 price, uint64 updatedAt);
}
