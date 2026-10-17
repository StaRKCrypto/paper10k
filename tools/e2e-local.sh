#!/usr/bin/env bash
# Local end-to-end on a throwaway anvil chain (chain 31337) using anvil's PUBLIC DEV KEYS only. Never a real key.
# Starts anvil, deploys, configures markets, seeds pool, writes deployments.local.json, starts the price relayer (fixed prices).
set -euo pipefail
export PATH=$PATH:~/.foundry/bin
cd "$(dirname "$0")/.."
K0=$(cast wallet private-key 'test test test test test test test test test test test junk' 0) # anvil's public dev account 0 (worthless)
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
RPC=http://127.0.0.1:8545
pkill -f "anvil --port 8545" 2>/dev/null || true; pkill -f price-relayer 2>/dev/null || true
(anvil --port 8545 --block-time 1 >/tmp/anvil.log 2>&1 &); sleep 2
cd contracts
OUT=$(OWNER=$A0 ORACLE_SIGNER=$A0 CONFIG_DELAY=300 forge script script/Deploy.s.sol --rpc-url $RPC --private-key $K0 --broadcast 2>&1)
get() { echo "$OUT" | grep -E "^ +$1 " | awk '{print $2}'; }
USDC=$(get TestUSDC); ORC=$(get Oracle); PX=$(get PAPER10KX); EX=$(get Exchange)
BLK=$(cast block-number --rpc-url $RPC)
S="cast send --rpc-url $RPC --private-key $K0"
$S $PX "acceptOwnership()" >/dev/null
# markets are timelocked (CONFIG_DELAY=2s on this throwaway chain; 2 days on mainnet)
$S $EX "proposeMarket(uint32,bool,uint256,uint256)" 0 true 1000000000000 1000000000000 >/dev/null
$S $EX "proposeMarket(uint32,bool,uint256,uint256)" 1 true 1000000000000 1000000000000 >/dev/null
cast rpc evm_increaseTime 301 --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null; sleep 1
$S $EX "applyMarket(uint32)" 0 >/dev/null; $S $EX "applyMarket(uint32)" 1 >/dev/null
$S $USDC "faucet()" >/dev/null; $S $USDC "approve(address,uint256)" $EX 10000000000 >/dev/null; $S $EX "seedPool(uint256)" 10000000000 >/dev/null
$S $EX "unpause()" >/dev/null
cd ..
printf '{"31337":{"exchange":"%s","collateral":"%s","px":"%s","oracle":"%s","block":%s}}\n' $EX $USDC $PX $ORC $BLK > deployments.local.json
cat deployments.local.json
cd tools
(RELAYER_KEY=$K0 ORACLE=$ORC RPC=$RPC CHAIN_ID=31337 nohup node price-relayer.mjs --interval 3 --fixed BTC=100000,ETH=3500 >/tmp/relayer.log 2>&1 &)
sleep 3; cat /tmp/relayer.log | tail -3
