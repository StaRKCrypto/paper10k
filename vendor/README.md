# vendor/

`walletconnect.bundle.js` — `@walletconnect/ethereum-provider@2.11.3` (Apache-2.0, see WALLETCONNECT-LICENSE) + `qrcode-generator@1.x` (MIT),
bundled with esbuild, **QR modal packages stubbed out** (no web3modal / reown AppKit, no fonts, no explorer API, no telemetry).
Reproduce: see `wc-entry.src.js` and `tools/build-wc.sh`. Loaded lazily, only when the user clicks "WalletConnect".
When used it talks to the WalletConnect relay (`wss://relay.walletconnect.com`) — unavoidable for the protocol — and requires a
free WalletConnect Cloud projectId (set `WC_PROJECT_ID` in `src/chain/config.js`). Newer 2.17+ versions are under a
non-OSS community license and add `pulse.walletconnect.org` telemetry, so we intentionally pin 2.11.3.
Status: bundle builds; NOT tested against a live wallet in this environment.
