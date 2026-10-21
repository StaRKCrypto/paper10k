// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Paper10kExchange} from "../src/Paper10kExchange.sol";
// v6: positionOwner()/queueLength() were removed from the exchange (size budget); tests read the public getters instead
function _po(Paper10kExchange e, uint256 id) view returns (address o) { (o,,,,,,,,,) = e.positions(id); }
function _ql(Paper10kExchange e) view returns (uint256) {
    uint256 n = e.queueHead();
    while (true) { try e.queue(n) returns (address, uint256) { n++; } catch { break; } }
    return n - e.queueHead();
}
