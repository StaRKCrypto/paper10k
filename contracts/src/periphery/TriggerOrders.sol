// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "../IPriceOracle.sol";

interface IP10KExchange {
    function positions(uint256 id) external view returns (
        address owner, uint32 market, uint16 leverage, uint32 pv, bool isLong, uint128 margin, uint128 notional,
        uint128 entry, uint64 openedAt, uint32 openedBlock);
    function oracle() external view returns (IPriceOracle);
    function close(uint256 id) external;
    function requestClose(uint256 id) external;
    function finalized() external view returns (bool);
    function isOperator(address user, address op) external view returns (bool);
}

/// @title TriggerOrders — take-profit / stop-loss for PAPER10K positions (periphery, no custody).
/// @notice The trader calls `exchange.setOperator(address(this), true)` once, then `place(id, tp, sl)`.
///         Anyone (a keeper) may call `execute(id)`; it closes the position only if the exchange's own oracle price has
///         crossed the trigger. This contract holds no funds and earns nothing: the exchange credits proceeds to the owner.
/// @dev Trigger semantics (prices 1e18): long  -> TP if price >= tp, SL if price <= sl;  short -> TP if price <= tp, SL if price >= sl.
///      0 disables a leg. At 10000x the bust distance (~0.009%) is usually inside any SL, so SL mainly helps lower leverage.
///      Execution price is whatever the exchange's close() uses in that block (same oracle), not the trigger price.
contract TriggerOrders {
    struct Order { uint128 tp; uint128 sl; address owner; }
    IP10KExchange public immutable exchange;
    mapping(uint256 => Order) public orders;

    event Placed(uint256 indexed id, address indexed owner, uint256 tp, uint256 sl);
    event Cancelled(uint256 indexed id);
    event Executed(uint256 indexed id, address indexed keeper, uint256 price, bool takeProfit);
    error NotOwner(); error NoOrder(); error NotTriggered(); error BadTrigger(); error NotApproved();

    constructor(IP10KExchange ex) { exchange = ex; }

    function place(uint256 id, uint128 tp, uint128 sl) external {
        (address owner,,,, bool isLong,,, uint128 entry,,) = exchange.positions(id);
        if (owner != msg.sender) revert NotOwner();
        if (!exchange.isOperator(owner, address(this))) revert NotApproved();
        if (tp == 0 && sl == 0) revert BadTrigger();
        // a TP must be on the profitable side of entry and an SL on the losing side (otherwise it would fire instantly)
        if (isLong ? ((tp != 0 && tp <= entry) || (sl != 0 && sl >= entry)) : ((tp != 0 && tp >= entry) || (sl != 0 && sl <= entry))) revert BadTrigger();
        orders[id] = Order(tp, sl, owner);
        emit Placed(id, owner, tp, sl);
    }

    function cancel(uint256 id) external {
        if (orders[id].owner != msg.sender) revert NotOwner();
        delete orders[id]; emit Cancelled(id);
    }

    /// @return hit 0 = no, 1 = take-profit, 2 = stop-loss (view helper for keepers)
    function check(uint256 id) public view returns (uint8 hit, uint256 price) {
        Order memory o = orders[id];
        (address owner, uint32 market,,, bool isLong,,,,,) = exchange.positions(id);
        if (o.owner == address(0) || owner != o.owner) return (0, 0);
        (price,) = exchange.oracle().getPrice(market);
        if (price == 0) return (0, 0);
        if (o.tp != 0 && (isLong ? price >= o.tp : price <= o.tp)) return (1, price);
        if (o.sl != 0 && (isLong ? price <= o.sl : price >= o.sl)) return (2, price);
        return (0, price);
    }

    function execute(uint256 id) external {
        if (orders[id].owner == address(0)) revert NoOrder();
        (uint8 hit, uint256 price) = check(id);
        if (hit == 0) {
            (address owner,,,,,,,,,) = exchange.positions(id);
            if (owner != orders[id].owner) { delete orders[id]; emit Cancelled(id); return; } // position gone: clean up
            revert NotTriggered();
        }
        delete orders[id];
        // after finalize closes are two-step: this files the close request; a keeper fills it at the next unique Pyth price
        if (exchange.finalized()) exchange.requestClose(id); else exchange.close(id);
        emit Executed(id, msg.sender, price, hit == 1);
    }
}
