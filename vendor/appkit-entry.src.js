// Reown AppKit (vanilla, no React) + wagmi adapter. Bundled to vendor/appkit.bundle.js by tools/build-appkit.sh, loaded lazily.
// Analytics/telemetry features are switched off. Exposes a tiny bridge on window.__P10K_APPKIT; the app itself stays library-free.
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base, baseSepolia } from '@reown/appkit/networks';
import { injected, safe, coinbaseWallet, baseAccount } from '@wagmi/connectors';
import { getAccount, watchAccount, disconnect } from '@wagmi/core';
import { createPublicClient, http, toCoinType } from 'viem';
import { mainnet } from 'viem/chains';

const nameCache = new Map();
/** ENS primary name, else Basename (ENSIP-19 L2 primary name for Base, coinType of chain 8453). null if none. */
async function lookupName(address, ensRpc) {
  const k = address.toLowerCase(); if (nameCache.has(k)) return nameCache.get(k);
  const pc = createPublicClient({ chain: mainnet, transport: http(ensRpc || undefined, { timeout: 8000 }) });
  let n = null;
  try { n = await pc.getEnsName({ address }); } catch { /* none */ }
  if (!n) { try { n = await pc.getEnsName({ address, coinType: toCoinType(8453) }); } catch { /* none */ } }
  nameCache.set(k, n); return n;
}
window.__P10K_APPKIT = {
  lookupName,
  init({ projectId, mainnet, appUrl, icon }) {
    const networks = mainnet ? [base, baseSepolia] : [baseSepolia];
    const adapter = new WagmiAdapter({
      projectId, networks, ssr: false,
      connectors: [
        injected({ shimDisconnect: true }),                                  // + EIP-6963 discovery (wagmi multiInjectedProviderDiscovery)
        baseAccount({ appName: 'PAPER10K' }),                              // Base Account (Coinbase Smart Wallet, passkeys)
        coinbaseWallet({ appName: 'PAPER10K', preference: { options: 'all' } }), // Coinbase extension + Smart Wallet (passkeys)
        safe({ allowedDomains: [/app\.safe\.global$/], shimDisconnect: false }),  // only active inside the Safe{Wallet} app iframe
      ],
    });
    const modal = createAppKit({
      adapters: [adapter], networks, defaultNetwork: networks[0], projectId,
      metadata: { name: 'PAPER10K', description: '10000x paper perps on Base', url: appUrl, icons: icon ? [icon] : [] },
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false, send: false },
      enableWalletConnect: true, enableInjected: true, enableEIP6963: true, enableCoinbase: true,
    });
    const cfg = adapter.wagmiConfig;
    return {
      open: () => modal.open(),
      openNetworks: () => modal.open({ view: 'Networks' }),
      disconnect: () => disconnect(cfg),
      account: () => getAccount(cfg),
      provider: async () => { const a = getAccount(cfg); return a.connector ? a.connector.getProvider() : null; },
      watch: (fn) => watchAccount(cfg, { onChange: fn }),
    };
  },
};
