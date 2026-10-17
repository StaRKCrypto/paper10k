// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal oracle interface. Prices are 18-decimal fixed point USD per 1 unit of the asset.
interface IPriceOracle {
    /// @return price 1e18-scaled price (0 if unknown)
    /// @return updatedAt unix time the price was observed/signed
    function getPrice(uint32 market) external view returns (uint256 price, uint64 updatedAt);
}
