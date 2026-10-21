#!/usr/bin/env bash
# Writes a REAL signed Pyth update (BTC/USD) for the first publish time >= T to contracts/.pyth/update.hex (+ T, publishTime).
# T is chosen just after the latest Chainlink BTC/USD round on Base so both sources are fresh at T. Needs PYTH_API_KEY (never printed).
set -euo pipefail
RPC=${RPC:-https://mainnet.base.org}; ID=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
export PATH=$HOME/.foundry/bin:$PATH
UPD=$(cast call 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F "latestRoundData()(uint80,int256,uint256,uint256,uint80)" -r $RPC | sed -n 4p | awk '{print $1}')
NOW=$(date +%s); T=$(( UPD + 5 )); [ $T -gt $(( NOW - 10 )) ] && T=$(( NOW - 10 ))
mkdir -p contracts/.pyth
curl -sf -m 15 -H "Authorization: Bearer ${PYTH_API_KEY:?set PYTH_API_KEY}" "https://pyth.dourolabs.app/hermes/v2/updates/price/$T?ids[]=$ID&encoding=hex" > /tmp/pu.json
python3 - "$T" <<'PY'
import json,sys; d=json.load(open('/tmp/pu.json')); T=sys.argv[1]
open('contracts/.pyth/update.hex','w').write('0x'+d['binary']['data'][0])
open('contracts/.pyth/meta.txt','w').write(f"{T}\n{d['parsed'][0]['price']['publish_time']}\n{d['parsed'][0]['price']['price']}\n")
print('ok T', T, 'publish', d['parsed'][0]['price']['publish_time'])
PY
