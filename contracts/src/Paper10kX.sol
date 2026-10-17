// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PAPER10KX
/// @notice Commemorative points token with NO monetary value and NO promise of any. Minted by the exchange to a
///         trader whose position is liquidated. Non-transferable by default (owner may enable transfers; it is
///         never redeemable for anything). Supply is hard-capped; mint never reverts on cap (it mints less).
contract Paper10kX is ERC20, Ownable2Step {
    address public minter;
    bool public minterLocked;
    bool public transfersEnabled;
    uint256 public immutable maxSupply;

    event MinterSet(address minter, bool locked);
    event TransfersEnabled(bool enabled);

    error NotMinter();
    error MinterIsLocked();
    error TransfersDisabled();

    constructor(address owner_, uint256 maxSupply_) ERC20("PAPER10KX", "PAPER10KX") Ownable(owner_) {
        maxSupply = maxSupply_;
    }

    /// @notice Set the only address allowed to mint. Can be locked permanently.
    function setMinter(address m, bool lock) external onlyOwner {
        if (minterLocked) revert MinterIsLocked();
        minter = m;
        minterLocked = lock;
        emit MinterSet(m, lock);
    }

    function setTransfersEnabled(bool e) external onlyOwner {
        transfersEnabled = e;
        emit TransfersEnabled(e);
    }

    /// @return minted amount actually minted (may be less than requested at the cap, never reverts for cap)
    function mint(address to, uint256 amount) external returns (uint256 minted) {
        if (msg.sender != minter) revert NotMinter();
        uint256 room = maxSupply - totalSupply();
        minted = amount > room ? room : amount;
        if (minted > 0) _mint(to, minted);
    }

    function _update(address from, address to, uint256 value) internal override {
        // mint (from==0) always allowed; burn and transfers need the flag, except burn by holder
        if (from != address(0) && to != address(0) && !transfersEnabled) revert TransfersDisabled();
        super._update(from, to, value);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
