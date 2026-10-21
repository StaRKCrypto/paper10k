// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PAPER10KX
/// @notice Points token minted by the exchange to a trader whose position is liquidated. NO promise of value: it is not
///         redeemable for anything, carries no revenue or governance rights, and nobody is obliged to buy it.
///         It is a standard, fully transferable ERC-20 (with EIP-2612 permit) from deployment: there is NO transfer gate,
///         so the owner can never freeze, pause or blacklist transfers. Supply is hard-capped; mint never reverts on cap
///         (it mints less). The only owner power is choosing the single minter once and locking it forever.
contract Paper10kX is ERC20, ERC20Permit, Ownable2Step {
    address public minter;
    bool public minterLocked;
    uint256 public immutable maxSupply;

    event MinterSet(address minter, bool locked);

    error NotMinter();
    error MinterIsLocked();

    constructor(address owner_, uint256 maxSupply_) ERC20("PAPER10KX", "PAPER10KX") ERC20Permit("PAPER10KX") Ownable(owner_) {
        maxSupply = maxSupply_;
    }

    /// @notice Set the only address allowed to mint. Can be locked permanently (the deploy script locks it to the exchange).
    function setMinter(address m, bool lock) external onlyOwner {
        if (minterLocked) revert MinterIsLocked();
        minter = m;
        minterLocked = lock;
        emit MinterSet(m, lock);
    }

    /// @return minted amount actually minted (may be less than requested at the cap, never reverts for cap)
    function mint(address to, uint256 amount) external returns (uint256 minted) {
        if (msg.sender != minter) revert NotMinter();
        uint256 room = maxSupply - totalSupply();
        minted = amount > room ? room : amount;
        if (minted > 0) _mint(to, minted);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
