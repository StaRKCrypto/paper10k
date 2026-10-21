// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Paper10kStaking — stake PAPER10KX, earn USDC pro rata (Synthetix-style reward-per-token accumulator, no loops).
/// @notice No owner, no admin, no upgrade: every parameter is an immutable set at deploy.
///   Revenue: only the exchange may call notifyReward(), after transferring the USDC in (Paper10kExchange.sweepStakers()).
///   The exchange never sweeps while totalStaked == 0, so rewards are never stranded (they stay in the house pool).
///   Donations sent directly to this contract are ignored (accounting uses notified amounts only), so there is no
///   share-price / first-depositor inflation attack: rewards are per staked token, not per share.
///   cooldown = 0 (Papertrade: "no staking minimum, cooldown or lockup") => unstake is immediate; otherwise unstaked tokens stop
///   earning at request time and can be withdrawn after `cooldown` seconds.
contract Paper10kStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant ACC = 1e36; // reward-per-token scale (USDC 6 dp vs PAPER10KX 18 dp)

    IERC20 public immutable stakeToken;   // PAPER10KX
    IERC20 public immutable rewardToken;  // USDC
    address public immutable exchange;
    uint64 public immutable cooldown;

    uint256 public totalStaked;
    uint256 public rewardPerTokenStored;  // x ACC
    uint256 public dust;                  // x ACC, carried so rounding never loses rewards
    uint256 public totalNotified;
    uint256 public totalClaimed;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public paidPerToken;
    mapping(address => uint256) public rewards;
    struct Pending { uint128 amount; uint64 unlockAt; }
    mapping(address => Pending) public pending;

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event RewardNotified(uint256 amount, uint256 rewardPerToken);
    error NotExchange(); error Zero(); error Insufficient(); error Locked(); error NoStakers();

    constructor(IERC20 stake_, IERC20 reward_, address exchange_, uint64 cooldown_) {
        stakeToken = stake_; rewardToken = reward_; exchange = exchange_; cooldown = cooldown_;
    }

    function earned(address u) public view returns (uint256) {
        return rewards[u] + staked[u] * (rewardPerTokenStored - paidPerToken[u]) / ACC;
    }
    function _settle(address u) internal { rewards[u] = earned(u); paidPerToken[u] = rewardPerTokenStored; }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert Zero();
        _settle(msg.sender);
        uint256 b = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = stakeToken.balanceOf(address(this)) - b; // fee-on-transfer safe (PAPER10KX has none)
        staked[msg.sender] += got; totalStaked += got;
        emit Staked(msg.sender, got);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert Zero();
        if (staked[msg.sender] < amount) revert Insufficient();
        _settle(msg.sender);
        staked[msg.sender] -= amount; totalStaked -= amount;
        if (cooldown == 0) { stakeToken.safeTransfer(msg.sender, amount); emit Unstaked(msg.sender, amount); return; }
        Pending storage q = pending[msg.sender];
        q.amount += uint128(amount); q.unlockAt = uint64(block.timestamp) + cooldown;
        emit UnstakeRequested(msg.sender, amount, q.unlockAt);
    }

    function withdrawUnstaked() external nonReentrant {
        Pending memory q = pending[msg.sender];
        if (q.amount == 0) revert Zero();
        if (block.timestamp < q.unlockAt) revert Locked();
        delete pending[msg.sender];
        stakeToken.safeTransfer(msg.sender, q.amount);
        emit Unstaked(msg.sender, q.amount);
    }

    function claim() external nonReentrant returns (uint256 r) {
        _settle(msg.sender);
        r = rewards[msg.sender];
        if (r == 0) return 0;
        rewards[msg.sender] = 0; totalClaimed += r;
        rewardToken.safeTransfer(msg.sender, r);
        emit Claimed(msg.sender, r);
    }

    /// @dev called by the exchange right after it transferred `amount` USDC here
    function notifyReward(uint256 amount) external nonReentrant {
        if (msg.sender != exchange) revert NotExchange();
        if (totalStaked == 0) revert NoStakers();
        uint256 scaled = amount * ACC + dust;
        uint256 inc = scaled / totalStaked;
        dust = scaled - inc * totalStaked;
        rewardPerTokenStored += inc; totalNotified += amount;
        emit RewardNotified(amount, rewardPerTokenStored);
    }
}
