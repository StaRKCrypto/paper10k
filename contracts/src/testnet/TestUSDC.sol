// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC — TESTNET ONLY free faucet token (6 decimals). No value. NEVER deploy on mainnet.
contract TestUSDC is ERC20 {
    uint256 public constant DRIP = 10_000e6;
    uint256 public constant COOLDOWN = 1 hours;
    mapping(address => uint256) public lastDrip;

    constructor() ERC20("Test USDC (no value)", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice unrestricted mint — TESTNET ONLY token, used by tests and local e2e
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }

    /// @notice free test tokens, once per hour per address
    function faucet() external {
        require(block.timestamp >= lastDrip[msg.sender] + COOLDOWN, "cooldown");
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP);
    }
}
