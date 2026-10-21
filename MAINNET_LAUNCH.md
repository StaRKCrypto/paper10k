# MAINNET_LAUNCH.md — immutable launch on Base (8453)

PAPER10K launches **once**, fully configured, then `finalize()` freezes every rule and every owner key is renounced.
Nothing can be fixed afterwards, so every gate below is mandatory **before** the deploy script runs on mainnet.

## 1. What is fixed forever after finalize
- No timelock and no proxies: every setter (`setConfig`, `setLimits`, `setMarket`, `setOracle`, `setStaking`, `setGuardian`,
  `pause`/`unpause`) works only before `finalize()`; afterwards they revert `Final()`. Owner, PAPER10KX owner and oracle owner = `0x0`.
- No owner withdrawal of any kind: the pool/insurance only pay winners, the FIFO queue and stakers.
- Nothing can be paused: closes, close-request fills, liquidations, deposits, withdrawals, staking, claims always work.
  The only post-launch control: the guardian may `haltOpens()` (new opens only) for 72 h, at most 3 times ever (guardian 0 = none).
- PAPER10KX: standard transferable ERC-20 + permit, hard cap, minter locked to the exchange forever.
- Markets: BTC (0), ETH (1), SOL (2). No new markets later.
- Pool-scaled size (implemented in the exchange): `maxMarginNow = min(maxMarginPerPosition, (pool+insurance) × maxPayoutPoolBps / maxProfitMult)`;
  per-wallet open margin ≤ `walletMaxMult × maxMarginNow`; PAPER10KX mint rate halves per doubling of pool+insurance above `mintDecayPool`.

## 2. Deploy flow (single broadcast: `contracts/script/Deploy.s.sol`)
Params come from env `P10K_<key>` > `/workspace/p10k-backtest/final_params.json` (`PARAMS_JSON`) > placeholders (testnet only).
On mainnet a missing file or any missing key reverts (`final params missing` / `missing param: <key>`). Schema + placeholder values:
`contracts/script/final_params.example.json`.

```
MAINNET_ENABLE=I_ACCEPT_REAL_FUNDS_RISK COLLATERAL=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 GUARDIAN=<key or unset> \
  forge script script/Deploy.s.sol --rpc-url <base> --account <keystore> --broadcast --verify
```
The deployer must hold `seedPool + seedInsurance` USDC. Order inside the script (cannot be reordered or skipped):
oracle (configure BTC/ETH/SOL, optional 3rd feeds, `finalizeBootstrap`, renounce) → PAPER10KX → Exchange (deployed paused) →
Paper10kStaking, TriggerOrders, RektBadges → `setMarket` ×3, `setLimits`, `setStaking`, `setGuardian` → lock minter → seed pool/insurance →
`unpause()` immediately followed by `finalize()` → renounce exchange + PAPER10KX → asserts `finalized && owner==0 && minterLocked`.
Rehearsed on an anvil fork of Base (chain id 31337): ~16.5M gas total.

## 3. Price sources and two-step orders

**Chosen setup (Base 8453), all verified live over RPC on 2026-10-21 (Asia/Calcutta evening):**

| Role | Source | Base address / id | Why |
|---|---|---|---|
| Fill price (open/close) | **Pyth Core**, `parsePriceFeedUpdatesUnique` | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`; BTC `0xe62d…5b43`, ETH `0xff61…0ace`, SOL `0xef0d…b56d` | already a median of many first-party publishers (Binance, OKX, Bybit, Jane St, …); pull model; the *unique first update after the request* removes every price choice |
| Sanity bound on fills + 2nd liquidation vote | **Chainlink Data Feeds** (push) | BTC/USD `0x64c9…848F`, ETH/USD `0x7104…Bb70`, SOL/USD `0x9750…462D`; sequencer feed `0xBCF8…6433` | independent network, free to read; fills revert if Pyth is > `maxDevBps` (100) from it |
| Optional 3rd vote | any AggregatorV3 push feed via `setThird` (RedStone Push / API3 / Chronicle) | env `THIRD_BTC/ETH/SOL` (placeholders: not verified on Base here) | joins the "all must agree" set for liquidations and the bound for fills |
| Off-chain venues | Binance, Coinbase, Hyperliquid, Lighter public APIs (no keys) | keeper `src/refprice.mjs`, app `src/chain/refprice.js` | **secondary only**: never on-chain. Keeper skips + alerts before marking a liquidation if the oracle is > 50 bps from the venue median; filler alerts only; app shows the venues and the divergence |

Rejected: keeper-signed off-chain median on-chain (a signer key is a rug/censor vector in an immutable system); Stork (Base pushes only USN feeds; pull needs a Stork API key); Chainlink Data Streams (paid, permissioned verifier); Chronicle (reads are whitelisted).

**SEC-3 (stale-price arbitrage) fix:** after `finalize()` the instant `open()`/`close()` revert `Final()`. Trading is `requestOpen` (margin locked at once) / `requestClose` (one pending per position, not cancellable) → anyone calls `fill(rid, pythUpdateData)` paying the Pyth fee; the oracle accepts only the first Pyth update published in `[request.ts + 1, request.ts + 11]`. Failed open fills (slippage, caps, pool too small) refund the margin in the same tx. `cancelRequest` only after 1 day (oracle outage). Exploit + fix tests: `test/TwoStep.t.sol`.

**Gates added:** run `keeper/src/filler.mjs` (needs `PYTH_API_KEY`: Hermes returns 401 without one since 2026-08-26 — placeholder; header name to confirm with Pyth) and at least one independent filler before finalize; re-check every Chainlink heartbeat on data.chain.link (script uses 3,900 s BTC/ETH, 86,700 s SOL from measured round ages); finalize only after the security scan and `forge test --match-contract ForkL2 --fork-url <base rpc>` are green.

## 4. Go / no-go gates (each needs an artefact: report, tx hash, log)
- [ ] Final params from the backtest in `final_params.json`, reviewed; dry-run against a Base fork with exactly that file.
- [ ] Independent audit(s) of `contracts/src/` incl. oracle, staking and periphery; security tooling re-run (Slither, Aderyn, Echidna, Medusa) clean or triaged.
- [ ] `forge test` + `forge test --match-contract ForkL2 --fork-url <base>` green; `forge build --sizes`: exchange < 24,576 B.
- [ ] Chainlink feed addresses + heartbeats re-read on deploy day; Pyth feed ids verified.
- [ ] `PYTH_API_KEY` for the filler; ≥2 independent fillers (`keeper/src/filler.mjs`), ≥2 liquidation keepers, 1 TP/SL keeper, all on gas-only hot keys, with alerting.
- [ ] Frontend: `deployments.json["8453"]`, `MAINNET_ENABLED=true`, `WC_PROJECT_ID`, `PAYMASTER_URLS[8453]`, `APP_URL`, Farcaster manifest; Rules page shows "IMMUTABLE since block …".
- [ ] Site rollback hash recorded (contracts have no rollback by design).
