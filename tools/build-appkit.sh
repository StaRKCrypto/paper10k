#!/bin/sh
# Rebuild vendor/appkit.bundle.js (needs npm + network). Run from repo root. Versions pinned for reproducibility.
set -e
d=$(mktemp -d); cp vendor/appkit-entry.src.js $d/entry.js; cd $d
npm init -y >/dev/null
npm i --no-audit --no-fund @reown/appkit@1.8.24 @reown/appkit-adapter-wagmi@1.8.24 wagmi@3 @wagmi/core@3 @wagmi/connectors@8 viem@2 @tanstack/query-core esbuild
npx esbuild entry.js --bundle --minify --format=iife --platform=browser --target=es2020 --define:global=window \
  --define:process.env.NODE_ENV='"production"' --outfile=appkit.js
cd - >/dev/null; cp $d/appkit.js vendor/appkit.bundle.js; ls -l vendor/appkit.bundle.js
