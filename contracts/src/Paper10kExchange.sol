// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {Paper10kX} from "./Paper10kX.sol";

/// @title Paper10kExchange
/// @notice Synthetic isolated-margin perps (up to 10000x) settled against a house pool, priced by an oracle.
///         Same margin math as the browser simulator (see README "Margin model"), plus a payout haircut,
///         a profit cap and a FIFO payout queue so the pool can never be forced to pay more than it holds.
///
///  Cash accounting invariant (checked by invariant tests):
///      collateral.balanceOf(this) >= totalFree + totalMargin + pool
///  - totalFree : sum of user free balances (withdrawable any time, even when paused)
///  - totalMargin: sum of margins locked in open positions
///  - pool      : house capital (owner seed + forfeited losses - paid wins). Owner can withdraw ONLY this, and
///                only the part not needed to cover the queue. User free balances / margins are never owner-reachable.
///  Wins the pool can't cover immediately are recorded as queued debt (NOT backed by cash) paid FIFO from
///  future pool inflows. RISK: queued winners are unsecured creditors of the house.
contract Paper10kExchange is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants
    uint256 public constant WAD = 1e18;
    uint32 public constant HARD_MAX_LEVERAGE = 10_000;
    uint256 public constant BPS = 10_000;

    // ---------------------------------------------------------------- immutables
    IERC20 public immutable collateral;
    Paper10kX public immutable px;
    uint256 public immutable mintScale; // PAPER10KX wei per collateral base unit (before mintPerCollateral)
    uint64 public immutable oracleDelay;

    // ---------------------------------------------------------------- config (all owner-bounded)
    IPriceOracle public oracle;
    IPriceOracle public pendingOracle;
    uint64 public pendingOracleAt;

    address public guardian; // may pause (not unpause)
    bool public emergencyMode; // lets users cancel positions at cost (no pnl) when paused

    uint32 public maxLeverage = 10_000;
    uint256 public minMargin; // collateral base units
    uint256 public maxMarginPerPosition;
    uint256 public maxTotalDeposits; // TVL cap on totalFree + totalMargin
    uint64 public maxPriceAge = 30; // seconds
    uint64 public minHold = 3; // seconds before a voluntary close
    uint256 public maintBps = 1000; // maintenance = 10% of margin => bust move = (1-0.10)/L
    uint256 public deadbandWad = 2e12; // 0.0002% move ignored for wins
    uint256 public baseRateWad = 0;
    uint256 public rateMultiplier = 1000; // haircut steepness
    uint256 public winFeeBps = 200; // 2% of paid gain stays in pool
    uint256 public maxProfitMult = 100; // profit cap = 100x margin
    uint256 public mintPerCollateral = 100; // PAPER10KX per 1 collateral unit liquidated

    struct Market { bool listed; bool open; uint256 oiCapLong; uint256 oiCapShort; uint256 oiLong; uint256 oiShort; }
    mapping(uint32 => Market) public markets;

    struct Position {
        address owner; uint32 market; bool isLong; uint32 leverage;
        uint128 margin; uint128 notional; uint128 entry; uint64 openedAt; uint16 maint;
    }
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    // ---------------------------------------------------------------- accounting
    mapping(address => uint256) public free;
    uint256 public totalFree;
    uint256 public totalMargin;
    uint256 public pool;

    struct Queued { address user; uint256 amount; }
    Queued[] public queue;
    uint256 public queueHead;
    uint256 public queuedTotal;
    mapping(address => uint256) public queuedOf;

    // ---------------------------------------------------------------- events
    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event PoolSeeded(address indexed from, uint256 amount);
    event PoolWithdrawn(address indexed to, uint256 amount);
    event Opened(uint256 indexed id, address indexed user, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 entry, uint32 leverage);
    event Closed(uint256 indexed id, address indexed user, uint256 exitPrice, uint256 returned, uint256 profitPaid, uint256 profitQueued, uint256 loss);
    event Liquidated(uint256 indexed id, address indexed user, address indexed keeper, uint256 price, uint256 margin, uint256 minted);
    event EmergencyCancelled(uint256 indexed id, address indexed user, uint256 margin);
    event QueuePaid(address indexed user, uint256 amount);
    event ParamsUpdated(bytes32 indexed what);
    event OracleProposed(address oracle, uint64 effectiveAt);
    event OracleSet(address oracle);
    event MarketSet(uint32 indexed market, bool open, uint256 oiCapLong, uint256 oiCapShort);
    event EmergencyModeSet(bool on);
    event GuardianSet(address g);

    // ---------------------------------------------------------------- errors
    error BadParam();
    error NotListed();
    error MarketClosed();
    error Leverage();
    error Margin();
    error Cap();
    error PriceBad();
    error Slippage();
    error NotOwnerOfPosition();
    error TooSoon();
    error NotLiquidatable();
    error InsufficientFree();
    error TransferMismatch();
    error NotEmergency();
    error NotGuardian();
    error OracleDelay();

    constructor(
        address owner_, IERC20 collateral_, uint8 collateralDecimals, Paper10kX px_, IPriceOracle oracle_,
        uint64 oracleDelay_, uint256 minMargin_, uint256 maxMarginPerPosition_, uint256 maxTotalDeposits_
    ) Ownable(owner_) {
        require(collateralDecimals <= 18 && address(oracle_) != address(0), "init");
        collateral = collateral_;
        px = px_;
        mintScale = 10 ** (18 - collateralDecimals);
        oracle = oracle_;
        oracleDelay = oracleDelay_;
        minMargin = minMargin_;
        maxMarginPerPosition = maxMarginPerPosition_;
        maxTotalDeposits = maxTotalDeposits_;
        _pause(); // deployed PAUSED: owner must unpause after configuring markets and caps
    }

    // ================================================================ user: funds
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert BadParam();
        if (totalFree + totalMargin + amount > maxTotalDeposits) revert Cap();
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        if (collateral.balanceOf(address(this)) - before != amount) revert TransferMismatch(); // no fee-on-transfer
        free[msg.sender] += amount;
        totalFree += amount;
        emit Deposit(msg.sender, amount);
    }

    /// @notice always available, even when paused or in emergency mode
    function withdraw(uint256 amount) external nonReentrant {
        if (free[msg.sender] < amount || amount == 0) revert InsufficientFree();
        free[msg.sender] -= amount;
        totalFree -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    // ================================================================ trading
    /// @param worstPrice max price for a long / min price for a short (1e18). Protects against oracle front-running.
    function open(uint32 market, bool isLong, uint256 margin, uint32 leverage, uint256 worstPrice)
        external nonReentrant whenNotPaused returns (uint256 id)
    {
        Market storage m = markets[market];
        if (!m.listed) revert NotListed();
        if (!m.open) revert MarketClosed();
        if (leverage == 0 || leverage > maxLeverage) revert Leverage();
        if (margin < minMargin || margin > maxMarginPerPosition) revert Margin();
        if (free[msg.sender] < margin) revert InsufficientFree();
        uint256 price = _price(market);
        if (isLong ? price > worstPrice : price < worstPrice) revert Slippage();
        uint256 notional = margin * leverage;
        if (notional > type(uint128).max) revert Margin();
        if (isLong) { m.oiLong += notional; if (m.oiLong > m.oiCapLong) revert Cap(); }
        else { m.oiShort += notional; if (m.oiShort > m.oiCapShort) revert Cap(); }

        free[msg.sender] -= margin;
        totalFree -= margin;
        totalMargin += margin;
        id = nextPositionId++;
        positions[id] = Position(msg.sender, market, isLong, leverage, uint128(margin), uint128(notional), uint128(price), uint64(block.timestamp), uint16(maintBps));
        emit Opened(id, msg.sender, market, isLong, margin, notional, price, leverage);
    }

    /// @notice voluntary close at current oracle price. If price is already past the bust price, this IS a liquidation.
    function close(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwnerOfPosition();
        if (block.timestamp < p.openedAt + minHold) revert TooSoon();
        uint256 price = _price(p.market);
        if (_busted(p, price)) { _liquidate(id, p, price, msg.sender); return; }
        _removePosition(id, p);

        (bool win, uint256 amt) = _pnl(p, price);
        totalMargin -= p.margin;
        if (!win) {
            // loss: amt < margin here (else it'd be busted)
            pool += amt;
            free[p.owner] += p.margin - amt;
            totalFree += p.margin - amt;
            emit Closed(id, p.owner, price, p.margin - amt, 0, 0, amt);
        } else {
            free[p.owner] += p.margin;
            totalFree += p.margin;
            (uint256 paid, uint256 queued) = _payProfit(p.owner, amt);
            emit Closed(id, p.owner, price, p.margin, paid, queued, 0);
        }
    }

    /// @notice anyone (keeper) can liquidate a position beyond its bust price. Margin forfeited to pool, PAPER10KX minted to trader.
    function liquidate(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NotLiquidatable();
        uint256 price = _price(p.market);
        if (!_busted(p, price)) revert NotLiquidatable();
        _liquidate(id, p, price, msg.sender);
    }

    function _liquidate(uint256 id, Position memory p, uint256 price, address keeper) internal {
        _removePosition(id, p);
        totalMargin -= p.margin;
        pool += p.margin;
        uint256 minted = px.mint(p.owner, uint256(p.margin) * mintScale * mintPerCollateral);
        emit Liquidated(id, p.owner, keeper, price, p.margin, minted);
    }

    function _removePosition(uint256 id, Position memory p) internal {
        Market storage m = markets[p.market];
        if (p.isLong) m.oiLong -= p.notional; else m.oiShort -= p.notional;
        delete positions[id];
    }

    /// @notice pay as much as the pool holds; queue the rest (FIFO). Profit net of win fee.
    function _payProfit(address user, uint256 profit) internal returns (uint256 paid, uint256 queued) {
        if (profit == 0) return (0, 0);
        if (queueHead < queue.length) { paid = 0; } // queue non-empty: strict FIFO, join the back
        else { paid = profit > pool ? pool : profit; }
        if (paid > 0) { pool -= paid; free[user] += paid; totalFree += paid; }
        queued = profit - paid;
        if (queued > 0) { queue.push(Queued(user, queued)); queuedTotal += queued; queuedOf[user] += queued; }
    }

    /// @notice anyone can pay queued winners out of the pool, oldest first
    function processQueue(uint256 maxEntries) external nonReentrant {
        uint256 n;
        while (queueHead < queue.length && n < maxEntries && pool > 0) {
            Queued storage q = queue[queueHead];
            uint256 pay = q.amount > pool ? pool : q.amount;
            pool -= pay;
            q.amount -= pay;
            queuedTotal -= pay;
            queuedOf[q.user] -= pay;
            free[q.user] += pay;
            totalFree += pay;
            emit QueuePaid(q.user, pay);
            if (q.amount == 0) { queueHead++; n++; } else break;
        }
    }

    function queueLength() external view returns (uint256) { return queue.length - queueHead; }

    // ================================================================ emergency (user-protective)
    /// @notice when owner/guardian paused AND set emergencyMode, a trader can cancel at entry: margin back, no PnL, no mint.
    function emergencyCancel(uint256 id) external nonReentrant {
        if (!emergencyMode || !paused()) revert NotEmergency();
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwnerOfPosition();
        _removePosition(id, p);
        totalMargin -= p.margin;
        free[p.owner] += p.margin;
        totalFree += p.margin;
        emit EmergencyCancelled(id, p.owner, p.margin);
    }

    // ================================================================ views
    function bustPrice(Position memory p) public view returns (uint256) {
        uint256 d = Math.mulDiv(p.entry, BPS - p.maint, BPS * uint256(p.leverage));
        return p.isLong ? p.entry - d : p.entry + d;
    }

    function previewClose(uint256 id) external view returns (bool busted, bool win, uint256 amount, uint256 price) {
        Position memory p = positions[id];
        require(p.owner != address(0), "none");
        price = _price(p.market);
        busted = _busted(p, price);
        if (!busted) (win, amount) = _pnl(p, price);
    }

    function _busted(Position memory p, uint256 price) internal view returns (bool) {
        uint256 b = bustPrice(p);
        return p.isLong ? price <= b : price >= b;
    }

    function _price(uint32 market) internal view returns (uint256 price) {
        uint64 ts;
        (price, ts) = oracle.getPrice(market);
        if (price == 0 || price > type(uint128).max || ts == 0 || ts + maxPriceAge < block.timestamp || ts > block.timestamp + 10) revert PriceBad();
    }

    /// @dev returns (win, amount). Loss amount capped at margin; win amount = haircut, capped profit net of fee
    function _pnl(Position memory p, uint256 price) internal view returns (bool win, uint256 amount) {
        bool favorable = p.isLong ? price > p.entry : price < p.entry;
        uint256 diff = price > p.entry ? price - p.entry : p.entry - price;
        uint256 move = Math.mulDiv(diff, WAD, p.entry);
        if (!favorable) {
            uint256 loss = Math.mulDiv(p.notional, move, WAD);
            return (false, loss > p.margin ? p.margin : loss);
        }
        if (move <= deadbandWad) return (true, 0);
        uint256 m = move - deadbandWad;
        uint256 raw = Math.mulDiv(p.notional, m, WAD);
        uint256 b = Math.mulDiv(raw, WAD - baseRateWad, WAD);
        uint256 denom = WAD + Math.mulDiv(WAD, WAD, m * rateMultiplier);
        uint256 profit = Math.mulDiv(b, WAD, denom);
        uint256 cap = uint256(p.margin) * maxProfitMult;
        if (profit > cap) profit = cap;
        profit -= Math.mulDiv(profit, winFeeBps, BPS);
        return (true, profit);
    }

    // ================================================================ owner / guardian
    function seedPool(uint256 amount) external nonReentrant {
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        if (collateral.balanceOf(address(this)) - before != amount) revert TransferMismatch();
        pool += amount;
        emit PoolSeeded(msg.sender, amount);
    }

    /// @notice owner may withdraw only pool surplus not needed for the payout queue. Never user balances/margins.
    function withdrawPool(address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount + queuedTotal > pool) revert Cap(); // queued winners are senior to the owner
        pool -= amount;
        collateral.safeTransfer(to, amount);
        emit PoolWithdrawn(to, amount);
    }

    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        emergencyMode = false;
        _unpause();
    }

    function setEmergencyMode(bool on) external onlyOwner {
        if (on && !paused()) revert NotEmergency();
        emergencyMode = on;
        emit EmergencyModeSet(on);
    }

    function setGuardian(address g) external onlyOwner { guardian = g; emit GuardianSet(g); }

    function setMarket(uint32 id, bool open_, uint256 capLong, uint256 capShort) external onlyOwner {
        Market storage m = markets[id];
        m.listed = true; m.open = open_; m.oiCapLong = capLong; m.oiCapShort = capShort;
        emit MarketSet(id, open_, capLong, capShort);
    }

    function setRisk(
        uint32 maxLev, uint256 minMargin_, uint256 maxMargin_, uint256 maxDeposits_, uint256 maintBps_, uint256 maxProfitMult_
    ) external onlyOwner {
        if (maxLev == 0 || maxLev > HARD_MAX_LEVERAGE) revert BadParam();
        if (maintBps_ < 100 || maintBps_ > 5000) revert BadParam();
        if (minMargin_ == 0 || maxMargin_ < minMargin_ || maxProfitMult_ == 0 || maxProfitMult_ > 10_000) revert BadParam();
        maxLeverage = maxLev; minMargin = minMargin_; maxMarginPerPosition = maxMargin_;
        maxTotalDeposits = maxDeposits_; maintBps = maintBps_; maxProfitMult = maxProfitMult_;
        emit ParamsUpdated("risk");
    }
    // NOTE: risk changes only affect NEW positions: maintenance is snapshotted per position (p.maint) so the owner
    // can never move the liquidation price of an already-open position.

    function setPricing(
        uint64 maxPriceAge_, uint64 minHold_, uint256 deadband_, uint256 baseRate_, uint256 rateMult_, uint256 winFeeBps_, uint256 mintPerCollateral_
    ) external onlyOwner {
        if (maxPriceAge_ < 5 || maxPriceAge_ > 600 || minHold_ > 600 || deadband_ > 1e16 || baseRate_ > 5e17
            || rateMult_ == 0 || rateMult_ > 1e6 || winFeeBps_ > 1000 || mintPerCollateral_ > 1e6) revert BadParam();
        maxPriceAge = maxPriceAge_; minHold = minHold_; deadbandWad = deadband_; baseRateWad = baseRate_;
        rateMultiplier = rateMult_; winFeeBps = winFeeBps_; mintPerCollateral = mintPerCollateral_;
        emit ParamsUpdated("pricing");
    }

    /// @notice oracle changes are time-locked so users can exit before a malicious oracle goes live
    function proposeOracle(IPriceOracle o) external onlyOwner {
        require(address(o) != address(0), "0");
        pendingOracle = o;
        pendingOracleAt = uint64(block.timestamp) + oracleDelay;
        emit OracleProposed(address(o), pendingOracleAt);
    }

    function applyOracle() external onlyOwner {
        if (address(pendingOracle) == address(0) || block.timestamp < pendingOracleAt) revert OracleDelay();
        oracle = pendingOracle;
        pendingOracle = IPriceOracle(address(0));
        emit OracleSet(address(oracle));
    }

    /// @notice rescue tokens sent by mistake. Cannot touch the collateral token.
    function rescueToken(IERC20 t, address to, uint256 amount) external onlyOwner {
        require(address(t) != address(collateral), "collateral");
        t.safeTransfer(to, amount);
    }
}
