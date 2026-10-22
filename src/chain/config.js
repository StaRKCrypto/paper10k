// Chain configuration & feature flags. TESTNET ONLY BY DEFAULT.
// To enable the mainnet network the OWNER must (1) set MAINNET_ENABLED=true here, (2) fill deployments.json["999"]
// after deploying themselves (see MAINNET_LAUNCH.md). Nothing in this repo enables it, and there is no URL override.
export const MAINNET_ENABLED = false;

// Free WalletConnect Cloud projectId (https://cloud.reown.com). Empty => WalletConnect button explains how to enable.
export const WC_PROJECT_ID = '922fc2559b86921e61c91471341ac269'; // Reown/WalletConnect Cloud projectId (public)

// PLACEHOLDER (owner): ERC-7677 paymaster service URLs per chain (e.g. Coinbase Developer Platform paymaster on Base). Empty = users pay gas.
// The URL usually embeds an API key: use a proxy you control or a key restricted to your domain + the exchange/collateral/trigger contracts.
export const PAYMASTER_URLS = { 8453: '', 84532: '' };
// PLACEHOLDER (owner): public site URL (Farcaster mini app + share links) and optional mainnet RPC used only for ENS/Basename lookups.
export const APP_URL = 'https://starkcrypto.github.io/paper10k/';
export const ENS_RPC = ''; // '' => viem's default public mainnet RPC
// Off-chain seasons/leaderboard file written by keeper/src/indexer.mjs and published next to index.html.
export const SEASONS_URL = 'seasons.json';

export const CHAINS = {
  998: { id: 998, name: 'HyperEVM Testnet', short: 'HyperEVM testnet', rpc: 'https://rpc.hyperliquid-testnet.xyz/evm', currency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    explorer: 'https://testnet.purrsec.com', faucet: 'https://app.hyperliquid-testnet.xyz/drip', testnet: true },
  84532: { id: 84532, name: 'Base Sepolia', short: 'Base Sepolia', rpc: 'https://sepolia.base.org', currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorer: 'https://sepolia.basescan.org', faucet: 'https://docs.base.org/chain/network-faucets', testnet: true },
  // local anvil, only offered with ?dev=1 on localhost
  31337: { id: 31337, name: 'Local Anvil', short: 'local anvil', rpc: 'http://127.0.0.1:8545', currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: '', faucet: '', testnet: true, dev: true },
  // Base mainnet: the launch target. Hidden unless MAINNET_ENABLED.
  8453: { id: 8453, name: 'Base', short: 'Base MAINNET', rpc: 'https://mainnet.base.org', currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorer: 'https://basescan.org', faucet: '', testnet: false, mainnet: true },
  // mainnet: HyperEVM (the chain papertrade.xyz uses). Hidden unless MAINNET_ENABLED.
  999: { id: 999, name: 'HyperEVM Mainnet', short: 'HyperEVM MAINNET', rpc: 'https://rpc.hyperliquid.xyz/evm', currency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    explorer: 'https://hyperevmscan.io', faucet: '', testnet: false, mainnet: true },
};

export const MARKETS = [{ id: 0, sym: 'BTC' }, { id: 1, sym: 'ETH' }, { id: 2, sym: 'SOL' }];

const dev = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('dev');

export function availableChains() {
  return Object.values(CHAINS).filter((c) => (c.mainnet ? MAINNET_ENABLED : c.dev ? dev() : true));
}
export const chainById = (id) => availableChains().find((c) => c.id === Number(id)) || null;

let deployments = null;
export async function loadDeployments() {
  if (deployments) return deployments;
  deployments = {};
  const urls = ['deployments.json'];
  if (dev()) urls.push('deployments.local.json');
  for (const u of urls) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) Object.assign(deployments, await r.json()); } catch { /* none */ }
  }
  if (!MAINNET_ENABLED) { delete deployments[999]; delete deployments[8453]; }
  return deployments;
}
