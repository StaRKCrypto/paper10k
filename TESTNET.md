# Testnet guide (no real funds)

**Verified (2026-10-17):** HyperEVM testnet RPC `https://rpc.hyperliquid-testnet.xyz/evm` → chainId `0x3e6` (998); Base Sepolia RPC `https://sepolia.base.org` → `0x14a34` (84532).
**Faucets we could NOT pass:** HyperEVM-testnet's gas faucet requires an account with mainnet activity; Base Sepolia faucets (Coinbase/Alchemy/QuickNode) need
sign-in/captcha or a mainnet balance. Per the safety rules we did not try to bypass them or use any existing key, so **nothing is deployed on a public testnet**.
The same flow was run end-to-end on a local anvil chain using anvil's *public dev keys*: `tools/e2e-local.sh` + `tools/e2e-shots.py` (screenshots in `paper10k-shots/`).

## Deploy to a public testnet yourself (throwaway key only!)
```sh
cd contracts && forge test                      # must be green
export PATH=$PATH:~/.foundry/bin
cast wallet new                                  # NEW throwaway key. Fund it from the faucet. Never reuse a real key.
export OWNER=<throwaway address> ORACLE_SIGNER=<throwaway address>   # same key can sign prices on testnet
forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $KEY --broadcast   # chain 998
#            or --rpc-url https://sepolia.base.org                                                              # chain 84532
# then, as OWNER:  px.acceptOwnership(); exchange.setMarket(0,true,cap,cap); setMarket(1,...); faucet+approve+seedPool; unpause()
#   (tools/e2e-local.sh shows the exact cast commands)
```
Put the printed addresses and the deploy block in `deployments.json` (`{"998":{"exchange":"0x..","collateral":"0x..","px":"0x..","oracle":"0x..","block":123}}`), then run the price relayer:
```sh
cd tools && npm i && RELAYER_KEY=<throwaway> ORACLE=<oracle> RPC=<rpc> CHAIN_ID=998 node price-relayer.mjs
```
WalletConnect needs a free projectId in `src/chain/config.js` (`WC_PROJECT_ID`). Injected wallets (MetaMask/Rabby/…) work with no setup.

## Layout
`contracts/` Foundry project (src, test, script) · `src/chain/` wallet + on-chain UI · `vendor/` WalletConnect bundle · `tools/` relayer, local e2e.
