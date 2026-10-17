#!/bin/sh
# rebuild vendor/walletconnect.bundle.js (needs npm). Run from repo root.
set -e
d=$(mktemp -d); cp vendor/wc-entry.src.js $d/entry.js; cd $d
npm init -y >/dev/null; npm i @walletconnect/ethereum-provider@2.11.3 qrcode-generator esbuild
echo "export const AppKit=null;export default {};" > stub.js
npx esbuild entry.js --bundle --minify --format=iife --platform=browser --target=es2020 --define:global=window \
  --define:process.env.NODE_ENV='"production"' --alias:@web3modal/standalone=./stub.js --alias:@walletconnect/modal=./stub.js --outfile=wc.js
cd - >/dev/null; cp $d/wc.js vendor/walletconnect.bundle.js
