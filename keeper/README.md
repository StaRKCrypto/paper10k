# paper10k keeper

A small Node (ESM, [viem](https://viem.sh)) bot that keeps the PAPER10K exchange healthy by running the permissionless two-step liquidation
(`markLiquidatable` → ≥ 2 blocks → `liquidate`, mark TTL 120 s) and collecting the capped liquidation bounty.
**No telemetry, no third-party calls: it talks only to the RPC URL you give it.** Testnet/local only while the mainnet flag is off
(the bot refuses chain 999 unless you set `ALLOW_MAINNET=I_ACCEPT_REAL_FUNDS_RISK`, which you must not do before an independent audit).

> This is software written by an AI and tested only on a local anvil chain. It is not audited. Use throwaway keys with only testnet gas.

## What it does each cycle
1. Discovers positions from the exchange's `Opened` events (chunked `getLogs` from `FROM_BLOCK`), drops closed ones (`positions(id).owner == 0`).
2. For each open position reads the **multi-source liquidation price** straight from the oracle (`getLiquidationPrice(market, isLong)`, the same price the contract uses) and `bustPriceOf(id)`.
3. Decides (pure function `src/decide.mjs`, unit-tested) using **chain time**:
   * busted, no valid mark (or expired) → `markLiquidatable`
   * busted, mark ≥ 2 blocks old and ≥ `SAFETY_SECS` left before the TTL → `liquidate`
   * busted, mark too close to expiry → wait, let it expire and re-mark
   * **not** busted but marked (price recovered) → `clearMark`
   * oracle returns 0 (guard tripped) → skip (users can still close; nobody can mark/liquidate)
4. Every tx is **simulated first** (`simulateContract`); reverts are logged and skipped. Gas price above `MAX_GAS_PRICE_GWEI` → skipped. Txs are sent one at a time and awaited (no nonce races).
5. RPC errors are retried with exponential backoff + jitter (`MAX_RETRIES`, `BACKOFF_MS`); contract reverts are not retried.
6. Skips positions owned by the keeper address itself (the contract pays no bounty for self-liquidation) and positions whose bounty is below `MIN_EXPECTED_BOUNTY`.

## Run
```bash
cd keeper && npm install            # installs viem only
npm test                            # unit tests for the decision logic

# dry run (no key needed: simulates and logs what it WOULD send, sends nothing)
RPC_URL=http://127.0.0.1:8545 EXCHANGE=0x... node src/cli.mjs --dry-run --once

# live (testnet / local anvil). The key comes ONLY from the environment; never put it in a file in this repo, a flag, or a commit.
export KEEPER_PRIVATE_KEY=0x...     # throwaway key funded with testnet gas only
RPC_URL=https://rpc.hyperliquid-testnet.xyz/evm CHAIN_ID=998 EXCHANGE=0x... FROM_BLOCK=<deploy block> node src/cli.mjs
```
Without `KEEPER_PRIVATE_KEY` the bot is forced into dry-run. Key format is validated without echoing it; it is never logged.

| env | default | meaning |
|---|---|---|
| `RPC_URL`, `EXCHANGE` | required | JSON-RPC endpoint, exchange address |
| `KEEPER_PRIVATE_KEY` | – | 0x + 64 hex; omit ⇒ dry-run |
| `CHAIN_ID` | auto | chain 999 refused unless `ALLOW_MAINNET=I_ACCEPT_REAL_FUNDS_RISK` |
| `FROM_BLOCK` / `LOG_CHUNK` | 0 / 2000 | event scan start and chunk size (lower chunk for RPCs with log-range limits) |
| `POLL_MS` | 1000 | cycle interval (backs off on failures) |
| `MAX_GAS_PRICE_GWEI` | 5 | skip sending above this |
| `MAX_RETRIES`, `BACKOFF_MS` | 4, 500 | RPC retry policy |
| `SAFETY_SECS` | 20 | don't liquidate if the mark has less than this left before the TTL |
| `MIN_EXPECTED_BOUNTY` | 0 | collateral base units (USDC has 6 decimals) |
| `LOG_LEVEL` | info | debug/info/warn/error. Logs are JSON lines on stdout |
| `--dry-run`, `--once` | | simulate only / run one cycle and exit |

Bounty: `min(margin × bountyBps / 1e4, bountyCap)` (deploy default 2 % capped at 10 USDC), credited to the **keeper's free balance in the exchange**
(call `withdraw` from the keeper wallet to take it out). Marking pays nothing; only the liquidator is paid, so a rival bot can liquidate a position you marked.

## End-to-end test (local anvil, public dev keys only)
```bash
cd keeper && npm install && npm run e2e     # needs foundry (anvil, forge) on PATH; uses port 8546
```
Deploys the real contracts, opens four 10000x positions, and checks: dry-run sends nothing; gas cap blocks sending; a stale mark on a recovered position is cleared by `clearMark`;
the live bot marks → waits ≥ 2 blocks → liquidates all four; the keeper is credited exactly 4 × 2 % of the margin; the house receives the remainder; PAPER10KX is minted.

## Limits
* Polling bot, not a mempool bot: a faster rival can win the liquidation (and the bounty). No private-orderflow integration.
* Scanning uses `getLogs` from `FROM_BLOCK`; with many positions the per-position reads are sequential RPC calls (no multicall yet).
* On a chain whose `getLiquidationPrice` is unavailable (SignedPriceOracle excepted) the bot can do nothing. It has **never** run against real HyperCore precompiles.
* Gas price cap uses `eth_gasPrice`; no EIP-1559 tip management, no tx replacement/speed-up.
