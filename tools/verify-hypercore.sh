#!/usr/bin/env bash
# Read-only: calls the HyperCore BBO / oraclePx precompiles via public RPC (no key, no tx) and prints decoded values.
# Usage: tools/verify-hypercore.sh [rpc-url]   (default mainnet public RPC; testnet: https://rpc.hyperliquid-testnet.xyz/evm)
export PATH=$PATH:~/.foundry/bin
RPC=${1:-https://rpc.hyperliquid.xyz/evm}
for spec in "BTC 0 5" "ETH 1 4"; do set -- $spec; name=$1; idx=$2; sz=$3
  arg=$(printf '%064x' $idx)
  bbo=$(cast call --rpc-url $RPC 0x000000000000000000000000000000000000080e "0x$arg" 2>&1)
  opx=$(cast call --rpc-url $RPC 0x0000000000000000000000000000000000000807 "0x$arg" 2>&1)
  echo "$name asset=$idx szDec=$sz"; echo "  bbo=$bbo"; echo "  oraclePx=$opx"
  python3 - "$bbo" "$opx" $sz <<'P'
import sys
b,o,sz=sys.argv[1],sys.argv[2],int(sys.argv[3]); sc=10**(6-sz)
try:
    bid=int(b[2:66],16); ask=int(b[66:130],16); op=int(o,16)
    print(f"  bid={bid/sc} ask={ask/sc} oraclePx={op/sc} spread_bps={(ask-bid)*1e4/((ask+bid)/2):.2f} dev_bps={abs((ask+bid)/2-op)*1e4/op:.1f}")
except Exception as e: print("  could not decode:", e)
P
done
