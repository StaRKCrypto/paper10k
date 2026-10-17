// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPriceOracle} from "../IPriceOracle.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SignedPriceOracle
/// @notice Prices are signed off-chain by `signer` (EIP-712) and relayed by ANYONE. Timestamps must be strictly
///         increasing per market (no replay / no cherry-picking older prices), not from the future, not stale,
///         and may not jump more than `maxJumpBps` from the previous price (owner can `forcePrice` to reset).
///         TRUST: whoever holds `signer` controls prices. Use only on testnet, or behind a hardened signer
///         (multi-sig/threshold/HSM) with monitoring. See MAINNET_LAUNCH.md.
contract SignedPriceOracle is IPriceOracle, Ownable2Step, EIP712 {
    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(uint32 market,uint256 price,uint64 timestamp)");

    address public signer;
    uint256 public maxJumpBps = 500; // 5%
    uint64 public maxAge = 60; // for accepting a signed price at relay time
    uint64 public constant FUTURE_TOLERANCE = 5;

    struct Px { uint256 price; uint64 ts; }
    mapping(uint32 => Px) public latest;

    event PriceUpdated(uint32 indexed market, uint256 price, uint64 ts);
    event SignerSet(address signer);
    event ParamsSet(uint256 maxJumpBps, uint64 maxAge);

    error BadSig();
    error Stale();
    error Future();
    error NotNewer();
    error Jump();
    error BadPrice();

    constructor(address owner_, address signer_) Ownable(owner_) EIP712("Paper10kOracle", "1") {
        require(signer_ != address(0), "signer=0");
        signer = signer_;
        emit SignerSet(signer_);
    }

    function setSigner(address s) external onlyOwner {
        require(s != address(0), "signer=0");
        signer = s;
        emit SignerSet(s);
    }

    function setParams(uint256 jumpBps, uint64 age) external onlyOwner {
        require(jumpBps >= 10 && jumpBps <= 5000, "jump");
        require(age >= 5 && age <= 1 hours, "age");
        maxJumpBps = jumpBps;
        maxAge = age;
        emit ParamsSet(jumpBps, age);
    }

    function updatePrice(uint32 market, uint256 price, uint64 ts, bytes calldata sig) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, market, price, ts)));
        if (ECDSA.recover(digest, sig) != signer) revert BadSig();
        if (price == 0 || price > type(uint128).max) revert BadPrice();
        if (ts > block.timestamp + FUTURE_TOLERANCE) revert Future();
        if (ts + maxAge < block.timestamp) revert Stale();
        Px memory p = latest[market];
        if (ts <= p.ts) revert NotNewer();
        if (p.price != 0) {
            uint256 diff = price > p.price ? price - p.price : p.price - price;
            if (diff * 10_000 > p.price * maxJumpBps) revert Jump();
        }
        latest[market] = Px(price, ts);
        emit PriceUpdated(market, price, ts);
    }

    /// @notice owner escape hatch after a legitimate large gap move (trusted action; emits event)
    function forcePrice(uint32 market, uint256 price) external onlyOwner {
        if (price == 0 || price > type(uint128).max) revert BadPrice();
        latest[market] = Px(price, uint64(block.timestamp));
        emit PriceUpdated(market, price, uint64(block.timestamp));
    }

    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }

    function getPrice(uint32 market) external view returns (uint256, uint64) {
        Px memory p = latest[market];
        return (p.price, p.ts);
    }
}
