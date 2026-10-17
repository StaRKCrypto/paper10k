// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MockHyperCore  (TEST/FORK ONLY)
/// @notice Foundry/anvil do not implement HyperCore read precompiles. This contract is placed with `anvil_setCode` at
///   0x...0807 (oraclePx, mode=1 -> returns 32 bytes) and 0x...080e (BBO, mode=0 -> returns 64 bytes) on a LOCAL fork so that
///   HyperCoreOracle's real code path (staticcall encode(uint256 asset) -> decode uint64s, guards, median) is exercised.
///   Calldata of exactly 32 bytes is a read (like the real precompile); anything else hits the setters. Never deploy on a real chain.
contract MockHyperCore {
    mapping(uint256 => uint64) public a;  // bid  (or oraclePx)
    mapping(uint256 => uint64) public b;  // ask
    bool public single;                   // true => oraclePx-style single value
    function set(uint256 asset, uint64 a_, uint64 b_) external { a[asset] = a_; b[asset] = b_; }
    function setSingle(bool s) external { single = s; }
    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length == 32, "bad input");
        uint256 asset = abi.decode(data, (uint256));
        return single ? abi.encode(uint256(a[asset])) : abi.encode(uint256(a[asset]), uint256(b[asset]));
    }
}
