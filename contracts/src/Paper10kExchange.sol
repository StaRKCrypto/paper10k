// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {ILiquidationOracle} from "./ILiquidationOracle.sol";
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
///  Governance (v6, immutable launch): every setter is owner-only AND pre-finalize() only; finalize() is one-way, after which the owner
///  renounces and nothing economic can change (`configDelay` is kept only as a constructor sanity value). Risk Params are VERSIONED. Every position snapshots the Params version that
///  was current when it opened and settles under THAT version, so a config change can never alter an open position's leverage cap,
///  maintenance margin, haircut, fee, profit cap, deadband or mint rate. Owner CANNOT instantly change anything economic; owner CAN
///  instantly: pause (also guardian), close a market, and (via 2-step) seed/transfer ownership.
interface IFillOracle { function fillPrice(uint32 market, bytes[] calldata data, uint64 minTs, uint64 maxTs) external payable returns (uint256); }
interface IStakingSink { function totalStaked() external view returns (uint256); function notifyReward(uint256 amount) external; }

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
    // v5: liquidation bounty = min(margin * bountyBps / 1e4, bountyCap), carved from the LIQUIDATED margin only (never insurance), credited to the
    // liquidator's free balance, 0 if the liquidator is the position owner. bountyBps <= 1000 (10%) is enforced, so the bounty can never exceed the margin.
    struct Ops { uint128 maxTotalDeposits; uint64 maxPriceAge; uint64 minHold; uint16 bountyBps; uint128 bountyCap; }
    Ops public ops;


    // oracle
    IPriceOracle public oracle;

    address public guardian;

    /// @notice launch risk limits (Papertrade-style). 0 = disabled. Settable only before finalize(), then fixed forever.
    ///   minNotional/maxNotional: per-position notional bounds (collateral units; Papertrade: $10k min, $10M max per position).
    ///   maxWalletMargin: total open margin per wallet. maxLiabPoolBps: per market+side, worst-case reserved liability
    ///   (margin x maxProfitMult) <= (pool+insurance) x bps (LP utilisation cap). maxJumpBps: oracle circuit breaker, opens revert
    ///   while the price is more than maxJumpBps from the reference price, which re-anchors at most every jumpWindow seconds. maxPayoutPoolBps: one position's
    ///   worst-case payout (margin x maxProfitMult) <= (pool+insurance) x bps, else PoolTooSmall (max size = % of pool).
    ///   walletMaxMult: open margin per wallet <= maxMarginNow() x mult. mintDecayPool: PAPER10KX mint rate halves for every doubling of
    ///   pool+insurance above this level (0 = flat).
    struct Limits { uint128 minNotional; uint128 maxNotional; uint128 maxWalletMargin; uint32 maxLiabPoolBps; uint16 maxJumpBps; uint32 jumpWindow; uint16 maxPayoutPoolBps; uint16 walletMaxMult; uint64 mintDecayPool; }
    Limits public limits;
    /// @notice one-way immutability switch. After finalize(): every propose/apply/setter, pause, closeMarket, emergency mode,
    ///         owner withdrawals and rescue revert forever; the owner then renounces. Rules can never change again.
    bool public finalized;
    uint64 public finalizedAt;
    uint64 public finalizedBlock;
    /// @notice the ONLY post-launch control: the guardian may halt NEW opens for HALT_SECS, at most MAX_HALTS times ever.
    ///         Closes, liquidations, deposits, withdrawals, staking flows are never affected. guardian = 0 disables it.
    uint64 public opensHaltedUntil;
    uint8 public haltsUsed;
    uint64 public constant HALT_SECS = 72 hours;
    uint8 public constant MAX_HALTS = 3;
    /// @notice last time a fresh oracle price was used; if no fresh price for ORACLE_DEAD_SECS, owners can cancel at margin
    uint64 public lastPriceOk;
    uint64 public constant ORACLE_DEAD_SECS = 7 days;
    /// @notice PAPER10KX staking revenue (Papertrade-style). Set before finalize, then fixed.
    address public staking;
    uint16 public stakerLossBps;   // share of every realised trader loss / liquidation inflow
    uint16 public stakerFeeBps;    // share of every win fee
    uint256 public stakerCap;      // pool above max(stakerCap, reserved liability) is swept to stakers (0 = off)
    uint256 public stakerAccrued;  // collateral owed to stakers, held here until sweepStakers()
    mapping(address => uint256) public walletMargin;
    /// @notice close-only operators (e.g. the TriggerOrders periphery for TP/SL). An operator can only call close() on the owner's
    ///         positions; proceeds always go to the position owner; it can never open, withdraw or move funds.
    mapping(address => mapping(address => bool)) public isOperator;
    /// @notice liquidation count per trader (read by RektBadges for achievements; no cash value)
    mapping(address => uint256) public rektCount;
    mapping(uint32 => uint256) public refPx;
    mapping(uint32 => uint64) public refAt;

    struct Market { bool listed; bool open; uint256 oiCapLong; uint256 oiCapShort; uint256 oiLong; uint256 oiShort; }
    mapping(uint32 => Market) public markets;

    struct Position {
        address owner; uint32 market; uint16 leverage; uint32 pv; bool isLong;
        uint128 margin; uint128 notional;
        uint128 entry; uint64 openedAt; uint32 openedBlock;
    }
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    // ---------------------------------------------------------------- v4: liquidation persistence (F5) + reserved liability (F7)
    uint32 public constant MARK_MIN_BLOCKS = 2;   // liquidate() only >= 2 blocks after markLiquidatable()
    uint64 public constant MARK_TTL = 120;        // a mark expires; a stale mark cannot be used for a later, unrelated dip
    struct Mark { uint32 blockNo; uint64 ts; }
    mapping(uint256 => Mark) public marks;
    /// per-market worst-case payout of open positions (margin * maxProfitMult of the params version it opened under), by side
    mapping(uint32 => uint256) public liabLong;
    mapping(uint32 => uint256) public liabShort;
    uint32[] public marketIds;

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


    // ---------------------------------------------------------------- events
    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event PoolSeeded(address indexed from, uint256 amount);
    event InsuranceFunded(address indexed from, uint256 amount);
    event Opened(uint256 indexed id, address indexed user, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 entry, uint32 leverage);
    event Closed(uint256 indexed id, address indexed user, uint256 exitPrice, uint256 returned, uint256 profitPaid, uint256 profitQueued, uint256 loss);
    event Liquidated(uint256 indexed id, address indexed user, address indexed keeper, uint256 price, uint256 margin, uint256 minted);
    event BountyPaid(uint256 indexed id, address indexed keeper, uint256 amount);
    event Marked(uint256 indexed id, address indexed by, uint256 price);
    event MarkCleared(uint256 indexed id);
    event EmergencyCancelled(uint256 indexed id, address indexed user, uint256 margin);
    event QueuePaid(address indexed user, uint256 amount);
    event ConfigApplied(uint32 version);
    event OracleSet(address oracle);
    event MarketSet(uint32 indexed market, bool open, uint256 oiCapLong, uint256 oiCapShort);
    event GuardianSet(address g);

    event OperatorSet(address indexed user, address indexed op, bool on);
    event Finalized(uint256 blockNo); event OpensHalted(uint64 until, uint8 used); event StakersPaid(uint256 amount, bool toPool);
    event LimitsSet();
    error BadParam(); error NotListed(); error MarketClosed(); error Leverage(); error Margin(); error Cap();
    error PriceBad(); error Slippage(); error NotOwnerOfPosition(); error TooSoon(); error NotLiquidatable();
    error MarkNotReady(); error StillBusted(); error Reserved(); error InsufficientFree(); error TransferMismatch(); error NotEmergency(); error NotGuardian(); error Delay(); error NothingPending(); error Breaker(); error PoolTooSmall(); error Final(); error Halted();

    constructor(
        address owner_, IERC20 collateral_, uint8 collateralDecimals, Paper10kX px_, IPriceOracle oracle_,
        uint64 configDelay_, Params memory p0, Ops memory o0
    ) Ownable(owner_) {
        require(collateralDecimals <= 18 && address(oracle_) != address(0), "init");
        require(configDelay_ >= 5 minutes, "delay"); // v3: timelock cannot be deployed as a no-op
        collateral = collateral_; px = px_; mintScale = 10 ** (18 - collateralDecimals);
        oracle = oracle_; configDelay = configDelay_;
        _validate(p0, o0);
        paramsHistory.push(p0); ops = o0;
        _pause(); // deployed PAUSED
    }

    modifier notFinal() { if (finalized) revert Final(); _; }

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
    /// @notice instant open at the stored oracle price. ONLY before finalize() (bootstrap/tests). After finalize every open and close
    ///         is two-step (requestOpen/requestClose -> fill) at the UNIQUE first Pyth price published after the request (SEC-3).
    function open(uint32 market, bool isLong, uint256 margin, uint32 leverage, uint256 worstPrice)
        external nonReentrant whenNotPaused returns (uint256 id)
    {
        if (finalized) revert Final();
        _lock(msg.sender, margin);
        id = _open(msg.sender, market, isLong, margin, leverage, worstPrice, _price(market));
    }

    function _lock(address u, uint256 margin) internal {
        if (free[u] < margin) revert InsufficientFree();
        free[u] -= margin; totalFree -= margin; totalMargin += margin;
    }

    /// @dev margin is already locked (moved free -> totalMargin) by the caller
    function _open(address trader, uint32 market, bool isLong, uint256 margin, uint32 leverage, uint256 worstPrice, uint256 price)
        internal returns (uint256 id)
    {
        Market storage m = markets[market];
        if (!m.listed) revert NotListed();
        if (!m.open) revert MarketClosed();
        uint32 pv = uint32(paramsHistory.length - 1);
        Params memory pr = paramsHistory[pv];
        if (leverage == 0 || leverage > pr.maxLeverage) revert Leverage();
        if (margin < pr.minMargin || margin > pr.maxMarginPerPosition) revert Margin();
        if (block.timestamp < opensHaltedUntil) revert Halted();
        lastPriceOk = uint64(block.timestamp);
        if (isLong ? price > worstPrice : price < worstPrice) revert Slippage();
        uint256 notional = margin * leverage;
        if (notional > type(uint128).max) revert Margin(); // v3: no silent uint128 truncation of notional
        if (isLong) { m.oiLong += notional; if (m.oiLong > m.oiCapLong) revert Cap(); }
        else { m.oiShort += notional; if (m.oiShort > m.oiCapShort) revert Cap(); }
        _checkLimits(trader, market, isLong, margin, notional, price, pr.maxProfitMult);
        if (isLong) liabLong[market] += margin * pr.maxProfitMult; else liabShort[market] += margin * pr.maxProfitMult;
        id = nextPositionId++;
        positions[id] = Position(trader, market, uint16(leverage), pv, isLong, uint128(margin), uint128(notional), uint128(price), uint64(block.timestamp), uint32(block.number));
        emit Opened(id, trader, market, isLong, margin, notional, price, leverage);
    }

    // ================================================================ SEC-3: two-step orders (the only trade path after finalize)
    /// Stale-price arbitrage fix. A request locks margin (opens) or flags the position (closes) at time T. Anyone may fill it with Pyth
    /// update data; the oracle verifies it via parsePriceFeedUpdatesUnique(minPublishTime = T + FILL_DELAY): the FIRST Pyth price published
    /// at/after that instant. The price is unknown at request time and unique, so neither the trader nor the filler can choose it.
    /// The trader cannot cancel; an unfillable request (oracle outage) can be cancelled by anyone after REQ_TIMEOUT (margin refunded).
    /// One pending close per position, so a close the trader dislikes cannot be abandoned and re-requested.
    struct Req { address trader; uint64 ts; uint32 market; uint32 leverage; bool isLong; uint128 margin; uint128 worst; uint256 posId; }
    mapping(uint256 => Req) public reqs;
    mapping(uint256 => uint256) public closeReq; // position id => pending request id
    uint256 public nextReq = 1;
    uint64 public constant FILL_DELAY = 1;
    uint64 public constant FILL_WINDOW = 10;
    uint64 public constant REQ_TIMEOUT = 1 days;
    event Requested(uint256 indexed rid, address indexed trader, uint256 posId);
    event Filled(uint256 indexed rid, uint256 posId, uint256 price);

    function requestOpen(uint32 market, bool isLong, uint256 margin, uint32 leverage, uint256 worstPrice)
        external nonReentrant whenNotPaused returns (uint256 rid)
    {
        if (margin > type(uint128).max || worstPrice > type(uint128).max) revert Margin();
        _lock(msg.sender, margin);
        rid = nextReq++;
        reqs[rid] = Req(msg.sender, uint64(block.timestamp), market, leverage, isLong, uint128(margin), uint128(worstPrice), 0);
        emit Requested(rid, msg.sender, 0);
    }

    function requestClose(uint256 id) external nonReentrant {
        Position memory p = positions[id];
        if (p.owner != msg.sender && !isOperator[p.owner][msg.sender]) revert NotOwnerOfPosition();
        if (closeReq[id] != 0) revert Delay();
        uint256 rid = nextReq++;
        reqs[rid] = Req(p.owner, uint64(block.timestamp), p.market, 0, false, 0, 0, id);
        closeReq[id] = rid;
        emit Requested(rid, p.owner, id);
    }

    /// @notice permissionless keeper call. msg.value pays the Pyth update fee.
    function fill(uint256 rid, bytes[] calldata data) external payable nonReentrant whenNotPaused {
        Req memory r = reqs[rid];
        if (r.ts == 0) revert NothingPending();
        uint64 t = r.ts + FILL_DELAY;
        uint256 price = IFillOracle(address(oracle)).fillPrice{value: msg.value}(r.market, data, t, t + FILL_WINDOW);
        if (price == 0 || price > type(uint128).max) revert PriceBad();
        delete reqs[rid];
        lastPriceOk = uint64(block.timestamp);
        uint256 pid = r.posId;
        if (pid != 0) {
            delete closeReq[pid];
            if (positions[pid].owner != address(0)) _close(pid, price); // liquidated meanwhile => nothing to do
        } else {
            try this.execOpen(r, price) returns (uint256 id) { pid = id; } catch { _unlock(r.trader, r.margin); }
        }
        emit Filled(rid, pid, price);
    }

    function execOpen(Req calldata r, uint256 price) external returns (uint256) {
        if (msg.sender != address(this)) revert NotGuardian();
        return _open(r.trader, r.market, r.isLong, r.margin, r.leverage, r.worst, price);
    }

    function cancelRequest(uint256 rid) external nonReentrant {
        Req memory r = reqs[rid];
        if (r.ts == 0 || block.timestamp <= r.ts + REQ_TIMEOUT) revert TooSoon();
        delete reqs[rid];
        if (r.posId != 0) delete closeReq[r.posId]; else _unlock(r.trader, r.margin);
        emit Filled(rid, 0, 0);
    }

    function _unlock(address u, uint256 margin) internal { totalMargin -= margin; free[u] += margin; totalFree += margin; }

    /// @notice voluntary close. Not in the same block as open and not before `minHold`. Past bust => it is a liquidation.
    function close(uint256 id) external nonReentrant whenNotPaused {
        if (finalized) revert Final();
        Position memory p = positions[id];
        if (p.owner != msg.sender && !isOperator[p.owner][msg.sender]) revert NotOwnerOfPosition();
        lastPriceOk = uint64(block.timestamp);
        _close(id, _price(p.market));
    }

    function _close(uint256 id, uint256 price) internal {
        Position memory p = positions[id];
        if (block.timestamp < p.openedAt + ops.minHold || block.number <= p.openedBlock) revert TooSoon();
        Params memory pr = paramsHistory[p.pv];
        // v4: a hard bust on voluntary close needs the multi-source liquidation price to agree. If it is unavailable (F8) or does not agree,
        // the close proceeds at the primary price; a position past maintenance then simply realises its (capped) loss.
        (bool lok, uint256 lp) = _liqPrice(p);
        if (lok && _busted(p, pr, lp)) { _liquidate(id, p, pr, lp, p.owner); return; } // owner as keeper: no bounty, also via an operator
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
            if (staking != address(0) && queued == 0) { // staker share of the win fee, only if the pool covers it
                uint256 cut = amt * pr.winFeeBps / (BPS - pr.winFeeBps) * stakerFeeBps / BPS;
                if (cut <= pool) { pool -= cut; stakerAccrued += cut; }
            }
            emit Closed(id, p.owner, price, p.margin, paid, queued, 0);
        }
    }

    /// @dev multi-source price for liquidation decisions; (false,0) if unavailable (fails closed)
    function _liqPrice(Position memory p) internal view returns (bool ok, uint256 price) {
        uint64 ts;
        try ILiquidationOracle(address(oracle)).getLiquidationPrice(p.market, p.isLong) returns (uint256 pr_, uint64 ts_) { price = pr_; ts = ts_; }
        catch { return (false, 0); }
        if (price == 0 || price > type(uint128).max || ts == 0 || ts + ops.maxPriceAge < block.timestamp || ts > block.timestamp + 10) return (false, 0);
        ok = true;
    }

    /// @notice step 1 (permissionless): record that the position is past its bust price by the MULTI-SOURCE liquidation price.
    ///         If it is not (price recovered) any existing mark is cleared. A still-valid mark is never refreshed (earliest wins).
    function markLiquidatable(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NotLiquidatable();
        (bool ok, uint256 lp) = _liqPrice(p);
        if (!ok) revert PriceBad();
        if (!_busted(p, paramsHistory[p.pv], lp)) {
            if (marks[id].blockNo != 0) { delete marks[id]; emit MarkCleared(id); }
            return;
        }
        Mark memory m = marks[id];
        if (m.blockNo != 0 && block.timestamp <= m.ts + MARK_TTL) return;
        marks[id] = Mark(uint32(block.number), uint64(block.timestamp));
        emit Marked(id, msg.sender, lp);
    }

    /// @notice permissionless: drop a mark once the multi-source price has recovered (anyone, incl. the owner, can protect a position this way)
    function clearMark(uint256 id) external nonReentrant {
        Position memory p = positions[id];
        if (p.owner == address(0) || marks[id].blockNo == 0) revert NotLiquidatable();
        (bool ok, uint256 lp) = _liqPrice(p);
        if (!ok) revert PriceBad();
        if (_busted(p, paramsHistory[p.pv], lp)) revert StillBusted();
        delete marks[id]; emit MarkCleared(id);
    }

    /// @notice step 2: >= MARK_MIN_BLOCKS after the mark (and within MARK_TTL) AND still busted now by the multi-source price.
    function liquidate(uint256 id) external nonReentrant whenNotPaused {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NotLiquidatable();
        Mark memory m = marks[id];
        if (m.blockNo == 0 || block.number < uint256(m.blockNo) + MARK_MIN_BLOCKS || block.timestamp > m.ts + MARK_TTL) revert MarkNotReady();
        Params memory pr = paramsHistory[p.pv];
        (bool ok, uint256 lp) = _liqPrice(p);
        if (!ok) revert PriceBad();
        if (!_busted(p, pr, lp)) revert NotLiquidatable();
        _liquidate(id, p, pr, lp, msg.sender);
    }

    function _liquidate(uint256 id, Position memory p, Params memory pr, uint256 price, address keeper) internal {
        _removePosition(id, p);
        totalMargin -= p.margin;
        uint256 bounty;
        if (keeper != p.owner) { // self-liquidation never earns a bounty
            bounty = uint256(p.margin) * ops.bountyBps / BPS;
            if (bounty > ops.bountyCap) bounty = ops.bountyCap;
            if (bounty > p.margin) bounty = p.margin; // belt and braces (bountyBps <= 10% already)
        }
        if (bounty > 0) { free[keeper] += bounty; totalFree += bounty; emit BountyPaid(id, keeper, bounty); }
        _inflow(p.margin - bounty, pr.insuranceBps);
        uint256 minted = px.mint(p.owner, uint256(p.margin) * mintScale * mintRateNow(pr.mintPerCollateral));
        rektCount[p.owner]++;
        emit Liquidated(id, p.owner, keeper, price, p.margin, minted);
    }

    function setOperator(address op, bool on) external { isOperator[msg.sender][op] = on; emit OperatorSet(msg.sender, op, on); }

    function _removePosition(uint256 id, Position memory p) internal {
        Market storage m = markets[p.market];
        if (p.isLong) m.oiLong -= p.notional; else m.oiShort -= p.notional;
        uint256 l = uint256(p.margin) * paramsHistory[p.pv].maxProfitMult;
        if (p.isLong) liabLong[p.market] -= l; else liabShort[p.market] -= l;
        walletMargin[p.owner] -= p.margin;
        delete positions[id]; delete marks[id];
    }

    function _checkLimits(address trader, uint32 market, bool isLong, uint256 margin, uint256 notional, uint256 price, uint256 mult) internal {
        Limits memory L = limits;
        if (notional < L.minNotional || (L.maxNotional != 0 && notional > L.maxNotional)) revert Margin();
        uint256 wm = walletMargin[trader] + margin;
        if ((L.maxWalletMargin != 0 && wm > L.maxWalletMargin) || (L.walletMaxMult != 0 && wm > maxMarginNow() * L.walletMaxMult)) revert Cap();
        walletMargin[trader] = wm;
        if (L.maxPayoutPoolBps != 0 && margin * mult * BPS > (pool + insurance) * L.maxPayoutPoolBps) revert PoolTooSmall();
        if (L.maxLiabPoolBps != 0) {
            uint256 liab = (isLong ? liabLong[market] : liabShort[market]) + margin * mult;
            // SEC-1: capital owed to queued winners is not free LP capital
            uint256 house = pool + insurance; house = house > queuedTotal ? house - queuedTotal : 0;
            if (liab * BPS > house * L.maxLiabPoolBps) revert Cap();
        }
        if (L.maxJumpBps != 0) {
            uint256 r = refPx[market];
            if (r == 0 || block.timestamp >= refAt[market] + L.jumpWindow) { refPx[market] = price; refAt[market] = uint64(block.timestamp); }
            else if ((price > r ? price - r : r - price) * BPS > r * L.maxJumpBps) revert Breaker();
        }
    }

    /// @dev forfeited trader funds: `insBps` to the insurance fund, rest to the pool
    function _inflow(uint256 amt, uint256 insBps) internal {
        if (staking != address(0) && queueHead >= queue.length) { uint256 cut = amt * stakerLossBps / BPS; stakerAccrued += cut; amt -= cut; }
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


    // ================================================================ emergency (user-protective)
    function emergencyCancel(uint256 id) external nonReentrant {
        if (!(paused() && !finalized) && !(lastPriceOk != 0 && block.timestamp > lastPriceOk + ORACLE_DEAD_SECS)) revert NotEmergency();
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwnerOfPosition();
        _removePosition(id, p);
        totalMargin -= p.margin; free[p.owner] += p.margin; totalFree += p.margin;
        emit EmergencyCancelled(id, p.owner, p.margin);
    }

    // ================================================================ views
    /// @notice worst-case payout the house could owe if the price moved fully in one direction on every market at once:
    ///         per market the larger side's sum of (margin * maxProfitMult); summed over markets (cross-market correlation assumed).
    /// @notice current max margin per position: min(hard cap, (pool+insurance) x maxPayoutPoolBps / maxProfitMult) — grows with the pool
    function maxMarginNow() public view returns (uint256 m) {
        Params memory pr = paramsHistory[paramsHistory.length - 1];
        m = pr.maxMarginPerPosition;
        uint256 bps = limits.maxPayoutPoolBps;
        if (bps != 0) { uint256 d = (pool + insurance) * bps / BPS / pr.maxProfitMult; if (d < m) m = d; }
    }
    /// @notice PAPER10KX per collateral unit right now (halves per doubling of pool+insurance above mintDecayPool)
    function mintRateNow(uint256 base) public view returns (uint256) {
        uint256 x = limits.mintDecayPool; uint256 pv = pool + insurance;
        if (x == 0 || pv < x) return base;
        uint256 h = Math.log2(pv / x) + 1;
        return h >= 64 ? 0 : base >> h;
    }
    function reservedLiability() public view returns (uint256 r) {
        for (uint256 i = 0; i < marketIds.length; i++) {
            uint32 id = marketIds[i]; uint256 a = liabLong[id]; uint256 b = liabShort[id];
            r += a > b ? a : b;
        }
    }
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
        price = _price(p.market);
        (bool lok, uint256 lp) = _liqPrice(p);
        busted = lok && _busted(p, pr, lp);
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
        if (o.bountyBps > 1000) revert BadParam();
    }

    /// @notice v6 (immutable launch): NO timelock is needed because every setter works ONLY before finalize(), and after finalize nothing
    ///         economic can ever change again. New Params apply only to positions opened afterwards (versioned).
    function setConfig(Params calldata p, Ops calldata o) external onlyOwner notFinal {
        _validate(p, o);
        paramsHistory.push(p); ops = o;
        emit ConfigApplied(uint32(paramsHistory.length - 1));
    }
    function _validLimits(Limits memory l) internal pure {
        if ((l.maxNotional != 0 && l.maxNotional < l.minNotional) || l.maxLiabPoolBps > 1_000_000 || l.maxJumpBps > 5000 || l.jumpWindow > 1 days || l.maxPayoutPoolBps > BPS
            || (l.maxJumpBps != 0 && l.jumpWindow == 0)) revert BadParam();
    }
    function setLimits(Limits calldata l) external onlyOwner notFinal { _validLimits(l); limits = l; emit LimitsSet(); }
    function setMarket(uint32 id, bool open_, uint256 capLong, uint256 capShort) external onlyOwner notFinal {
        Market storage m = markets[id];
        if (!m.listed) marketIds.push(id);
        m.listed = true; m.open = open_; m.oiCapLong = capLong; m.oiCapShort = capShort;
        emit MarketSet(id, open_, capLong, capShort);
    }

    function setOracle(IPriceOracle o) external onlyOwner notFinal {
        if (address(o) == address(0)) revert BadParam();
        oracle = o; emit OracleSet(address(o));
    }

    // ================================================================ instant safety controls
    function pause() external notFinal { if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian(); _pause(); }
    function unpause() external onlyOwner notFinal { _unpause(); }
    /// @dev v3: renouncing would leave a paused exchange with positions that can never close or be rescued.
    function renounceOwnership() public override onlyOwner { if (!finalized) revert BadParam(); _transferOwnership(address(0)); }

    /// @notice set the staking sink and its shares once, before finalize (then fixed forever)
    function setStaking(address s_, uint16 lossBps, uint16 feeBps, uint256 cap) external onlyOwner notFinal {
        if (lossBps > 1000 || feeBps > BPS) revert BadParam();
        staking = s_; stakerLossBps = lossBps; stakerFeeBps = feeBps; stakerCap = cap;
    }
    /// @notice one-way: freezes every rule. Requires a live, unpaused exchange with nothing pending.
    function finalize() external onlyOwner notFinal {
        if (paused()) revert BadParam();
        finalized = true; finalizedAt = uint64(block.timestamp); finalizedBlock = uint64(block.number);
        emit Finalized(block.number);
    }
    /// @notice guardian-only, auto-expiring, limited: halts NEW opens for 72h. Nothing else.
    function haltOpens() external {
        if (msg.sender != guardian || haltsUsed >= MAX_HALTS) revert NotGuardian();
        haltsUsed++; opensHaltedUntil = uint64(block.timestamp) + HALT_SECS;
        emit OpensHalted(opensHaltedUntil, haltsUsed);
    }
    /// @notice permissionless: route accrued staker revenue (plus pool excess above max(stakerCap, reserved liability)) to staking.
    ///         With zero stakers the amount returns to the pool (never lost). Never runs while wins are queued.
    function sweepStakers() external nonReentrant {
        address st = staking;
        if (st == address(0) || queueHead < queue.length) return;
        if (stakerCap != 0) { uint256 r = reservedLiability(); if (r < stakerCap) r = stakerCap; if (pool > r) { stakerAccrued += pool - r; pool = r; } }
        uint256 amt = stakerAccrued; if (amt == 0) return;
        stakerAccrued = 0;
        if (IStakingSink(st).totalStaked() == 0) { pool += amt; emit StakersPaid(amt, true); return; }
        collateral.safeTransfer(st, amt); IStakingSink(st).notifyReward(amt);
        emit StakersPaid(amt, false);
    }
    function setGuardian(address g) external onlyOwner notFinal { guardian = g; emit GuardianSet(g); }
}
