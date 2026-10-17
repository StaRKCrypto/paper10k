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

/// @title Paper10kExchange (v2)
/// @notice Synthetic isolated-margin perps (up to 10000x) settled against a house pool + insurance fund, priced by an oracle.
///
///  Cash accounting invariant (fuzz/invariant-tested, holds with EQUALITY absent donations):
///      collateral.balanceOf(this) >= totalFree + totalMargin + pool + insurance
///   totalFree   user free balances (withdrawable any time, even when paused)
///   totalMargin margins locked in open positions
///   pool        house capital (owner seed + net forfeited losses - paid wins)
///   insurance   backstop: fed by `insuranceBps` of every forfeited loss and by anyone; pays winners only after the pool is empty
///  Wins that pool+insurance cannot cover become queued debt (unbacked) paid FIFO from future inflows.
///
///  Governance (all behind `configDelay`, a TIMELOCK): risk Params are VERSIONED. Every position snapshots the Params version that
///  was current when it opened and settles under THAT version, so a config change can never alter an open position's leverage cap,
///  maintenance margin, haircut, fee, profit cap, deadband or mint rate. Owner CANNOT instantly change anything economic; owner CAN
///  instantly: pause (also guardian), close a market, and (via 2-step) seed/transfer ownership.
contract Paper10kExchange is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint32 public constant HARD_MAX_LEVERAGE = 10_000;
    uint256 public constant BPS = 10_000;

    IERC20 public immutable collateral;
    Paper10kX public immutable px;
    uint256 public immutable mintScale;
    uint64 public immutable configDelay;

    // ---------------------------------------------------------------- versioned params (settlement-affecting)
    struct Params {
        uint16 maxLeverage; uint16 maintBps; uint16 winFeeBps; uint16 insuranceBps; uint16 maxProfitMult;
        uint32 rateMultiplier; uint32 mintPerCollateral;
        uint64 deadbandWad; uint64 baseRateWad;
        uint128 minMargin; uint128 maxMarginPerPosition;
    }
    Params[] public paramsHistory; // index = version; positions snapshot the version at open

    // ---------------------------------------------------------------- live ops params (also timelocked)
    struct Ops { uint128 maxTotalDeposits; uint64 maxPriceAge; uint64 minHold; }
    Ops public ops;

    struct PendingConfig { Params p; Ops o; uint64 at; bool set; }
    PendingConfig public pendingConfig;

    // oracle
    IPriceOracle public oracle;
    IPriceOracle public pendingOracle;
    uint64 public pendingOracleAt;

    address public guardian;
    bool public emergencyMode;

    struct Market { bool listed; bool open; uint256 oiCapLong; uint256 oiCapShort; uint256 oiLong; uint256 oiShort; }
    mapping(uint32 => Market) public markets;
    struct PendingMarket { bool open; uint256 capLong; uint256 capShort; uint64 at; bool set; }
    mapping(uint32 => PendingMarket) public pendingMarket;

    struct Position {
        address owner; uint32 market; uint16 leverage; uint32 pv; bool isLong;
        uint128 margin; uint128 notional;
        uint128 entry; uint64 openedAt; uint32 openedBlock;
    }
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    // ---------------------------------------------------------------- accounting
    mapping(address => uint256) public free;
    uint256 public totalFree;
    uint256 public totalMargin;
    uint256 public pool;
    uint256 public insurance;

    struct Queued { address user; uint256 amount; }
    Queued[] public queue;
    uint256 public queueHead;
    uint256 public queuedTotal;
    mapping(address => uint256) public queuedOf;

    struct PendingWithdraw { address to; uint256 amount; bool fromInsurance; uint64 at; bool set; }
    PendingWithdraw public pendingWithdraw;

    // ---------------------------------------------------------------- events
    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event PoolSeeded(address indexed from, uint256 amount);
    event InsuranceFunded(address indexed from, uint256 amount);
    event Opened(uint256 indexed id, address indexed user, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 entry, uint32 leverage);
    event Closed(uint256 indexed id, address indexed user, uint256 exitPrice, uint256 returned, uint256 profitPaid, uint256 profitQueued, uint256 loss);
    event Liquidated(uint256 indexed id, address indexed user, address indexed keeper, uint256 price, uint256 margin, uint256 minted);
    event EmergencyCancelled(uint256 indexed id, address indexed user, uint256 margin);
    event QueuePaid(address indexed user, uint256 amount);
    event ConfigProposed(uint64 effectiveAt);
    event ConfigApplied(uint32 version);
    event ConfigCancelled();
    event OracleProposed(address oracle, uint64 effectiveAt);
    event OracleSet(address oracle);
    event MarketProposed(uint32 indexed market, bool open, uint256 oiCapLong, uint256 oiCapShort, uint64 effectiveAt);
    event MarketSet(uint32 indexed market, bool open, uint256 oiCapLong, uint256 oiCapShort);
    event WithdrawProposed(address to, uint256 amount, bool fromInsurance, uint64 effectiveAt);
    event WithdrawApplied(address to, uint256 amount, bool fromInsurance);
    event EmergencyModeSet(bool on);
    event GuardianSet(address g);

    error BadParam(); error NotListed(); error MarketClosed(); error Leverage(); error Margin(); error Cap();
    error PriceBad(); error Slippage(); error NotOwnerOfPosition(); error TooSoon(); error NotLiquidatable();
    error InsufficientFree(); error TransferMismatch(); error NotEmergency(); error NotGuardian(); error Delay(); error NothingPending();

    constructor(
        address owner_, IERC20 collateral_, uint8 collateralDecimals, Paper10kX px_, IPriceOracle oracle_,
        uint64 configDelay_, Params memory p0, Ops memory o0
    ) Ownable(owner_) {
        require(collateralDecimals <= 18 && address(oracle_) != address(0), "init");
        collateral = collateral_; px = px_; mintScale = 10 ** (18 - collateralDecimals);
        oracle = oracle_; configDelay = configDelay_;
        _validate(p0, o0);
        paramsHistory.push(p0); ops = o0;
        _pause(); // deployed PAUSED
    }

    // ================================================================ user: funds
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert BadParam();
        if (totalFree + totalMargin + amount > ops.maxTotalDeposits) revert Cap();
        _pull(amount);
        free[msg.sender] += amount; totalFree += amount;
        emit Deposit(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || free[msg.sender] < amount) revert InsufficientFree();
        free[msg.sender] -= amount; totalFree -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    function _pull(uint256 amount) internal {
        uint256 b = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        if (collateral.balanceOf(address(this)) - b != amount) revert TransferMismatch();
    }

    // ================================================================ trading
    function open(uint32 market, bool isLong, uint256 margin, uint32 leverage, uint256 worstPrice)
        external nonReentrant whenNotPaused returns (uint256 id)
    {
        Market storage m = markets[market];
        if (!m.listed) revert NotListed();
        if (!m.open) revert MarketClosed();
        uint32 pv = uint32(paramsHistory.length - 1);
        Params memory pr = paramsHistory[pv];
        if (leverage == 0 || leverage > pr.maxLeverage) revert Leverage();
        if (margin < pr.minMargin || margin > pr.maxMarginPerPosition) revert Margin();
        if (free[msg.sender] < margin) revert InsufficientFree();
        uint256 price = _price(market);
        if (isLong ? price > worstPrice : price < worstPrice) revert Slippage();
        uint256 notional = margin * leverage;
        if (isLong) { m.oiLong += notional; if (m.oiLong > m.oiCapLong) revert Cap(); }
        else { m.oiShort += notional; if (m.oiShort > m.oiCapShort) revert Cap(); }

        free[msg.sender] -= margin; totalFree -= margin; totalMargin += margin;
        id = nextPositionId++;
        positions[id] = Position(msg.sender, market, uint16(leverage), pv, isLong, uint128(margin), uint128(notional), uint128(price), uint64(block.timestamp), uint32(block.number));
        emit Opened(id, msg.sender, market, isLong, margin, notional, price, leverage);
    }

    /// @notice voluntary close. Not in the same block as open and not before `minHold`. Past bust => it is a liquidation.
    function close(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwnerOfPosition();
        if (block.timestamp < p.openedAt + ops.minHold || block.number <= p.openedBlock) revert TooSoon();
        Params memory pr = paramsHistory[p.pv];
        uint256 price = _price(p.market);
        if (_busted(p, pr, price)) { _liquidate(id, p, pr, price, msg.sender); return; }
        _removePosition(id, p);
        (bool win, uint256 amt) = _pnl(p, pr, price);
        totalMargin -= p.margin;
        if (!win) {
            _inflow(amt, pr.insuranceBps);
            free[p.owner] += p.margin - amt; totalFree += p.margin - amt;
            emit Closed(id, p.owner, price, p.margin - amt, 0, 0, amt);
        } else {
            free[p.owner] += p.margin; totalFree += p.margin;
            (uint256 paid, uint256 queued) = _payProfit(p.owner, amt);
            emit Closed(id, p.owner, price, p.margin, paid, queued, 0);
        }
    }

    function liquidate(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NotLiquidatable();
        Params memory pr = paramsHistory[p.pv];
        uint256 price = _price(p.market);
        if (!_busted(p, pr, price)) revert NotLiquidatable();
        _liquidate(id, p, pr, price, msg.sender);
    }

    function _liquidate(uint256 id, Position memory p, Params memory pr, uint256 price, address keeper) internal {
        _removePosition(id, p);
        totalMargin -= p.margin;
        _inflow(p.margin, pr.insuranceBps);
        uint256 minted = px.mint(p.owner, uint256(p.margin) * mintScale * pr.mintPerCollateral);
        emit Liquidated(id, p.owner, keeper, price, p.margin, minted);
    }

    function _removePosition(uint256 id, Position memory p) internal {
        Market storage m = markets[p.market];
        if (p.isLong) m.oiLong -= p.notional; else m.oiShort -= p.notional;
        delete positions[id];
    }

    /// @dev forfeited trader funds: `insBps` to the insurance fund, rest to the pool
    function _inflow(uint256 amt, uint256 insBps) internal {
        uint256 ins = amt * insBps / BPS;
        insurance += ins; pool += amt - ins;
    }

    function _take(uint256 want) internal returns (uint256 got) {
        got = want > pool ? pool : want;
        pool -= got;
        uint256 rest = want - got;
        if (rest > 0 && insurance > 0) { uint256 i = rest > insurance ? insurance : rest; insurance -= i; got += i; }
    }

    function _payProfit(address user, uint256 profit) internal returns (uint256 paid, uint256 queued) {
        if (profit == 0) return (0, 0);
        if (queueHead >= queue.length) paid = _take(profit); // empty queue: pay now; else strict FIFO
        if (paid > 0) { free[user] += paid; totalFree += paid; }
        queued = profit - paid;
        if (queued > 0) { queue.push(Queued(user, queued)); queuedTotal += queued; queuedOf[user] += queued; }
    }

    function processQueue(uint256 maxEntries) external nonReentrant {
        uint256 n;
        while (queueHead < queue.length && n < maxEntries) {
            Queued storage q = queue[queueHead];
            uint256 pay = _take(q.amount);
            if (pay == 0) break;
            q.amount -= pay; queuedTotal -= pay; queuedOf[q.user] -= pay;
            free[q.user] += pay; totalFree += pay;
            emit QueuePaid(q.user, pay);
            if (q.amount == 0) { queueHead++; n++; } else break;
        }
    }

    function positionOwner(uint256 id) external view returns (address) { return positions[id].owner; }
    function queueLength() external view returns (uint256) { return queue.length - queueHead; }

    // ================================================================ emergency (user-protective)
    function emergencyCancel(uint256 id) external nonReentrant {
        if (!emergencyMode || !paused()) revert NotEmergency();
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwnerOfPosition();
        _removePosition(id, p);
        totalMargin -= p.margin; free[p.owner] += p.margin; totalFree += p.margin;
        emit EmergencyCancelled(id, p.owner, p.margin);
    }

    // ================================================================ views
    function paramsVersion() external view returns (uint256) { return paramsHistory.length - 1; }
    function currentParams() external view returns (Params memory) { return paramsHistory[paramsHistory.length - 1]; }

    function bustPrice(Position memory p, Params memory pr) internal pure returns (uint256) {
        uint256 d = Math.mulDiv(p.entry, BPS - pr.maintBps, BPS * uint256(p.leverage));
        return p.isLong ? p.entry - d : p.entry + d;
    }
    function bustPriceOf(uint256 id) external view returns (uint256) {
        Position memory p = positions[id]; require(p.owner != address(0), "none");
        return bustPrice(p, paramsHistory[p.pv]);
    }

    function previewClose(uint256 id) external view returns (bool busted, bool win, uint256 amount, uint256 price) {
        Position memory p = positions[id]; require(p.owner != address(0), "none");
        Params memory pr = paramsHistory[p.pv];
        price = _price(p.market); busted = _busted(p, pr, price);
        if (!busted) (win, amount) = _pnl(p, pr, price);
    }

    function _busted(Position memory p, Params memory pr, uint256 price) internal pure returns (bool) {
        uint256 b = bustPrice(p, pr);
        return p.isLong ? price <= b : price >= b;
    }

    function _price(uint32 market) internal view returns (uint256 price) {
        uint64 ts;
        (price, ts) = oracle.getPrice(market);
        if (price == 0 || price > type(uint128).max || ts == 0 || ts + ops.maxPriceAge < block.timestamp || ts > block.timestamp + 10) revert PriceBad();
    }

    function _pnl(Position memory p, Params memory pr, uint256 price) internal pure returns (bool win, uint256 amount) {
        bool favorable = p.isLong ? price > p.entry : price < p.entry;
        uint256 diff = price > p.entry ? price - p.entry : p.entry - price;
        uint256 move = Math.mulDiv(diff, WAD, p.entry);
        if (!favorable) {
            uint256 loss = Math.mulDiv(p.notional, move, WAD);
            return (false, loss > p.margin ? p.margin : loss);
        }
        if (move <= pr.deadbandWad) return (true, 0);
        uint256 m = move - pr.deadbandWad;
        uint256 raw = Math.mulDiv(p.notional, m, WAD);
        uint256 b = Math.mulDiv(raw, WAD - pr.baseRateWad, WAD);
        uint256 denom = WAD + Math.mulDiv(WAD, WAD, m * pr.rateMultiplier);
        uint256 profit = Math.mulDiv(b, WAD, denom);
        uint256 cap = uint256(p.margin) * pr.maxProfitMult;
        if (profit > cap) profit = cap;
        profit -= Math.mulDiv(profit, pr.winFeeBps, BPS);
        return (true, profit);
    }

    // ================================================================ funding the house
    function seedPool(uint256 amount) external nonReentrant { _pull(amount); pool += amount; emit PoolSeeded(msg.sender, amount); }
    function fundInsurance(uint256 amount) external nonReentrant { _pull(amount); insurance += amount; emit InsuranceFunded(msg.sender, amount); }

    // ================================================================ governance (timelocked)
    function _validate(Params memory p, Ops memory o) internal pure {
        if (p.maxLeverage == 0 || p.maxLeverage > HARD_MAX_LEVERAGE) revert BadParam();
        if (p.maintBps < 100 || p.maintBps > 5000) revert BadParam();
        if (p.winFeeBps > 1000 || p.insuranceBps > 5000 || p.maxProfitMult == 0 || p.maxProfitMult > 10_000) revert BadParam();
        if (p.rateMultiplier == 0 || p.rateMultiplier > 1e6 || p.mintPerCollateral > 1e6) revert BadParam();
        if (p.deadbandWad > 1e16 || p.baseRateWad > 5e17) revert BadParam();
        if (p.minMargin == 0 || p.maxMarginPerPosition < p.minMargin) revert BadParam();
        if (o.maxPriceAge < 5 || o.maxPriceAge > 600 || o.minHold > 600 || o.minHold < 2) revert BadParam();
    }

    /// @notice propose new risk params + ops. After `configDelay` anyone-visible window the owner applies; new Params apply ONLY to positions opened afterwards.
    function proposeConfig(Params calldata p, Ops calldata o) external onlyOwner {
        _validate(p, o);
        pendingConfig = PendingConfig(p, o, uint64(block.timestamp) + configDelay, true);
        emit ConfigProposed(pendingConfig.at);
    }
    function applyConfig() external onlyOwner {
        PendingConfig memory c = pendingConfig;
        if (!c.set) revert NothingPending();
        if (block.timestamp < c.at) revert Delay();
        paramsHistory.push(c.p); ops = c.o; delete pendingConfig;
        emit ConfigApplied(uint32(paramsHistory.length - 1));
    }
    function cancelConfig() external onlyOwner { delete pendingConfig; emit ConfigCancelled(); }

    function proposeMarket(uint32 id, bool open_, uint256 capLong, uint256 capShort) external onlyOwner {
        pendingMarket[id] = PendingMarket(open_, capLong, capShort, uint64(block.timestamp) + configDelay, true);
        emit MarketProposed(id, open_, capLong, capShort, pendingMarket[id].at);
    }
    function applyMarket(uint32 id) external onlyOwner {
        PendingMarket memory pm = pendingMarket[id];
        if (!pm.set) revert NothingPending();
        if (block.timestamp < pm.at) revert Delay();
        Market storage m = markets[id];
        m.listed = true; m.open = pm.open; m.oiCapLong = pm.capLong; m.oiCapShort = pm.capShort;
        delete pendingMarket[id];
        emit MarketSet(id, pm.open, pm.capLong, pm.capShort);
    }
    /// @notice instant, protective: stop new positions on a market (existing positions keep settling)
    function closeMarket(uint32 id) external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        markets[id].open = false;
        emit MarketSet(id, false, markets[id].oiCapLong, markets[id].oiCapShort);
    }

    function proposeOracle(IPriceOracle o) external onlyOwner {
        require(address(o) != address(0), "0");
        pendingOracle = o; pendingOracleAt = uint64(block.timestamp) + configDelay;
        emit OracleProposed(address(o), pendingOracleAt);
    }
    function applyOracle() external onlyOwner {
        if (address(pendingOracle) == address(0) || block.timestamp < pendingOracleAt) revert Delay();
        oracle = pendingOracle; pendingOracle = IPriceOracle(address(0));
        emit OracleSet(address(oracle));
    }

    /// @notice withdrawing house capital (pool surplus or insurance) is timelocked and can never dip into queued-win reserves
    function proposeWithdraw(address to, uint256 amount, bool fromInsurance) external onlyOwner {
        require(to != address(0), "to");
        pendingWithdraw = PendingWithdraw(to, amount, fromInsurance, uint64(block.timestamp) + configDelay, true);
        emit WithdrawProposed(to, amount, fromInsurance, pendingWithdraw.at);
    }
    function applyWithdraw() external onlyOwner nonReentrant {
        PendingWithdraw memory w = pendingWithdraw;
        if (!w.set) revert NothingPending();
        if (block.timestamp < w.at) revert Delay();
        delete pendingWithdraw;
        if (queuedTotal != 0) revert Cap(); // never while winners are owed
        if (w.fromInsurance) { if (w.amount > insurance) revert Cap(); insurance -= w.amount; }
        else { if (w.amount > pool) revert Cap(); pool -= w.amount; }
        collateral.safeTransfer(w.to, w.amount);
        emit WithdrawApplied(w.to, w.amount, w.fromInsurance);
    }
    function cancelWithdraw() external onlyOwner { delete pendingWithdraw; }

    // ================================================================ instant safety controls
    function pause() external { if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian(); _pause(); }
    function unpause() external onlyOwner { emergencyMode = false; _unpause(); }
    function setEmergencyMode(bool on) external onlyOwner { if (on && !paused()) revert NotEmergency(); emergencyMode = on; emit EmergencyModeSet(on); }
    function setGuardian(address g) external onlyOwner { guardian = g; emit GuardianSet(g); }
    function rescueToken(IERC20 t, address to, uint256 amount) external onlyOwner { require(address(t) != address(collateral), "collateral"); t.safeTransfer(to, amount); }
}
