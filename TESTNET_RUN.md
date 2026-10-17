# TESTNET_RUN — rehearsal report (2026-10-17, Asia/Calcutta)

**Status: NOT a public-testnet deployment.** No public testnet could be funded without a human step (captcha / sign-in / bot check / mainnet-balance gate), and the owner's rules forbid bypassing those. The full flow was therefore run on the owner-approved **fallback: a local `anvil --fork-url` of the live HyperEVM testnet (chainId 998)**. Nothing in this file is on a public chain; there are **no block-explorer links** because these txs exist only on a throwaway local fork. Hashes below are fork-local. This is an AI-run rehearsal, not an audit.

No key is in this repo. The owner/deployer is the throwaway key at `/home/box/secrets/p10k-testnet.key` (address `0xa992B1F4641410Cc7252492E3CcC03651Ab577Bf`, chmod 600, outside git); its fork balance was conjured with `anvil_setBalance`. Users/keeper are anvil's public dev-mnemonic accounts. Mainnet: never touched.

## Faucet attempts (all blocked; address has 0 balance on every chain)
| Chain / faucet | Why it failed |
|---|---|
| HyperEVM 998 – Quicknode | wallet connect + browser bot check |
| HyperEVM 998 – Chainstack | account login + API key |
| HyperEVM 998 – thirdweb | wallet-connect widget |
| HyperEVM 998 – official Hyperliquid drip | needs prior mainnet deposit |
| Base Sepolia – Quicknode / Alchemy / ZalalenA | bot check / mainnet-activity gate + captcha / captcha |
| Base Sepolia – Coinbase CDP faucet | needs a CDP account (the documented API needs an API key) |
| Base Sepolia – Lumina HTTP faucet | endpoint dead (`404 Application not found`) |
| Sepolia – pk910 PoW | Cloudflare Turnstile "Verify you are human" before mining (seen in headless Chrome) |
| Sepolia – Google Cloud / Alchemy | Google sign-in / mainnet-activity gate |
| OP Sepolia – Superchain faucet | GitHub login; L2Faucet "under maintenance" |
| Arbitrum Sepolia – Alchemy / L2Faucet | mainnet-balance gate / passkey attestation, paused |
| Avalanche Fuji | needs mainnet AVAX balance or coupon |
| Kaia Kairos, Flare Coston2 | captcha / Turnstile on the page |
| Polygon Amoy | 403 to non-browser clients (bot protection) |
| Hoodi (ethpandaops / pk910) | PoW faucet has captcha; ethpandaops page is wallet-driven |
Not tried (no plain-HTTP/no-captcha path found): Core test2, Sei Atlantic.
**To unblock a real run:** a human claims ~0.1 HYPE on 998 (Quicknode/Chainstack/thirdweb) to the address above, or ~0.02 Base Sepolia ETH.

## Fork rehearsal results (`keeper/test/fork998.mjs`, all checks PASS)
Fork of HyperEVM testnet at block 67,160,823 (chainId 998). Foundry/anvil **do not implement HyperCore precompiles**: addresses `0x…0807` (oraclePx) and `0x…080e` (BBO) were replaced via `anvil_setCode` with `contracts/src/testnet/MockHyperCore.sol`, seeded with the **live** testnet BTC values (read via `eth_call` on the real RPC). So HyperCoreOracle's code path (staticcall encoding, uint64 decoding, spread/deviation guards, both-must-agree liquidation price, bootstrap→finalize) is exercised; the *real precompile's behaviour inside the EVM* is not. Reading the real precompiles over public RPC works and matches the decoder (see measurements).

Deployed with the repo `Deploy.s.sol` on chain 998 (`USE_HYPERCORE_ORACLE=1`, `CONFIG_DELAY=300`) — fork-local addresses:
- TestUSDC `0x524E3Ec28B84AC15F361731901375259Ca14243b`
- HyperCoreOracle `0xB575A63a60c16714853BD51D96fD1b8e6b5743d3`
- PAPER10KX `0xCB78AF30699820C0A8E761F6c32aC161C42391e0`
- Exchange `0x7d055A48282e4F99Cff579b7Ba08e3bd00eabC3a`

Flow: setGuards(30 bps spread, 100 bps dev) → configure BTC → `finalizeBootstrap` → acceptOwnership → proposeMarket → +301 s → applyMarket → seedPool 10,000 USDC → unpause. Guard checks: absurd spread ⇒ `(0,0)`; oraclePx 10% off mid ⇒ `(0,0)`; recovers on sane data. 4 users opened 20 USDC × 10000x BTC longs; BTC feed moved −1%; the keeper (live process, real key path via env) marked all 4, waited, liquidated all 4 (≥39 blocks apart on the slow fork, ≥2 required); keeper bounty 4 × 0.4 = 1.6 USDC; house received 78.4 USDC; **2000 PAPER10KX minted to each liquidated owner**. Full tx hashes/gas: `testnet-run-fork.json`. Keeper log: `/tmp/keeper-fork998.log` (not committed).

### Gas (measured on the fork, same EVM costs as 998)
Exchange deploy **4,615,873**, HyperCoreOracle 1,409,076, PAPER10KX 830,227, TestUSDC 550,210; open (10000x) ~180–231k; deposit ~83–100k; `markLiquidatable` 105,156; `liquidate` 141–206k (first one higher: cold storage); proposeMarket 116k; applyMarket 119k.

## Real measurements on live HyperEVM testnet (read-only, `tools/measure-998.mjs`, 120 s, `testnet-measure-998.json`)
- **Block time ≈ 0.98 s** (118 chain-seconds / 120 blocks). **Block gas limit is 3,000,000 (small blocks).**
- **oraclePx update cadence**: value changed on ~19 of 31 samples; mean gap ≈ 6 s, max ≈ 12–16 s. My sampler spent ~4 s per loop (public RPC latency ≈ 666 ms per call × several calls), so these are upper bounds on gaps, not precise lag. The contract treats the precompile as "fresh as of this block" (`updatedAt = block.timestamp`) — it cannot see staleness, which matters given multi-second oraclePx gaps.
- BTC BBO spread 7.8–14.6 bps (avg 10.4); ETH 8.8–18.9 bps.
- **BTC mid vs oraclePx: persistently 35–39 bps apart on testnet** (ETH 0.6–14 bps). Testnet ETH trades near $80.

## Findings / what broke
1. **BLOCKER for a real 998 deploy: the Exchange needs 4.6M gas to create, but HyperEVM small blocks cap at 3M.** My first fork run inherited the 3M limit and died `OutOfGas` at exactly 3,000,000. Deploying on 998/999 therefore requires HyperEVM **big blocks** (30M limit, ~1 per minute, enabled per-address via a HyperCore `evmUserModify{usingBigBlocks:true}` action signed by the deployer) or a smaller Exchange. Runs below used `anvil --gas-limit 30000000` to emulate this. Add to MAINNET_LAUNCH.md. Day-to-day txs (≤0.25M) fit small blocks.
2. Both-agree liquidation behaved as designed on real data: with oraclePx ~37 bps above mid, a 0.03% adverse move did **not** liquidate longs (max(mid, oraclePx) stayed above the bust price); only a 1% move did. Consequence: at 10000x, liquidations lag real price moves by the source divergence, so the insurance fund absorbs that gap. Mainnet divergence must be measured before launch.
3. The 100 bps oraclePx deviation guard comfortably passes today's 37 bps testnet gap, but is >100× the 0.9 bps bust distance of a 10000x position — the guard protects against bad data, not against jitter (that is what the 2-block mark is for).
4. Fork slowness (each state fetch ~0.7 s through the public RPC) stretched the run to ~15 min; keeper block gaps of 39–49 are an artifact of that, not of the chain (live chain: ~1 block/s).
5. Not verified: real HyperCore precompile semantics inside the EVM (gas cost of the precompile calls, behaviour of reverts/short returns), true oraclePx lag (needs a faster sampler near a node), UI screenshots against a live testnet deployment (none exists; the fork is local), Pages-pointed-at-testnet.
