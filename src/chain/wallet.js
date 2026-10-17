// EIP-1193 wallet layer: injected (EIP-6963 + window.ethereum) and WalletConnect (vendored, lazy). No analytics.
import { CHAINS, WC_PROJECT_ID, availableChains } from './config.js';

export const state = { provider: null, kind: null, account: null, chainId: null, signedIn: false, name: '' };
const subs = new Set();
export const onChange = (f) => subs.add(f);
const emit = () => subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } });

const eip6963 = [];
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.provider && !eip6963.find((x) => x.info.uuid === e.detail.info.uuid)) eip6963.push(e.detail); emit(); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
export function injectedProviders() {
  const out = eip6963.map((d) => ({ name: d.info.name, provider: d.provider }));
  if (!out.length && window.ethereum) out.push({ name: window.ethereum.isMetaMask ? 'MetaMask / injected' : 'Injected wallet', provider: window.ethereum });
  return out;
}

const hexToNum = (h) => parseInt(h, 16);
function attach(p) {
  p.on?.('accountsChanged', (a) => { state.account = a[0] || null; state.signedIn = false; if (!state.account) disconnect(); else emit(); });
  p.on?.('chainChanged', (c) => { state.chainId = hexToNum(c); emit(); });
  p.on?.('disconnect', () => disconnect());
}

export async function connectInjected(entry) {
  const p = entry.provider;
  const accts = await p.request({ method: 'eth_requestAccounts' });
  state.provider = p; state.kind = 'injected'; state.name = entry.name; state.account = accts[0];
  state.chainId = hexToNum(await p.request({ method: 'eth_chainId' }));
  state.signedIn = false; attach(p); emit();
}

let wcScript = null;
function loadWC() {
  if (window.__P10K_WC) return Promise.resolve(window.__P10K_WC);
  wcScript ??= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/walletconnect.bundle.js';
    s.onload = () => res(window.__P10K_WC); s.onerror = () => rej(new Error('could not load vendor/walletconnect.bundle.js')); document.head.append(s);
  });
  return wcScript;
}
/** @param onUri called with the wc: URI (render as QR / link) */
export async function connectWalletConnect(onUri, preferChain) {
  if (!WC_PROJECT_ID) throw new Error('WalletConnect needs a free projectId: set WC_PROJECT_ID in src/chain/config.js (see README).');
  const { EthereumProvider } = await loadWC();
  const chains = availableChains(); const first = preferChain || chains[0].id;
  const rpcMap = Object.fromEntries(chains.map((c) => [c.id, c.rpc]));
  const p = await EthereumProvider.init({ projectId: WC_PROJECT_ID, chains: [first], optionalChains: chains.map((c) => c.id).filter((i) => i !== first), rpcMap, showQrModal: false,
    methods: ['eth_sendTransaction', 'personal_sign'], optionalMethods: ['wallet_switchEthereumChain', 'wallet_addEthereumChain'],
    metadata: { name: 'PAPER10K', description: 'Testnet paper perps', url: location.origin, icons: [] } });
  p.on('display_uri', onUri);
  await p.connect();
  state.provider = p; state.kind = 'walletconnect'; state.name = 'WalletConnect'; state.account = p.accounts[0]; state.chainId = p.chainId; state.signedIn = false;
  attach(p); emit();
}

export async function disconnect() {
  try { if (state.kind === 'walletconnect') await state.provider?.disconnect?.(); } catch { /* ignore */ }
  Object.assign(state, { provider: null, kind: null, account: null, chainId: null, signedIn: false, name: '' }); emit();
}

export async function switchChain(id) {
  const c = CHAINS[id]; const hex = '0x' + id.toString(16);
  try { await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e) {
    if (e?.code === 4902 || /unrecognized|not added|4902/i.test(e?.message || '')) {
      await state.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: c.name, nativeCurrency: c.currency, rpcUrls: [c.rpc], blockExplorerUrls: c.explorer ? [c.explorer] : [] }] });
    } else throw e;
  }
  state.chainId = hexToNum(await state.provider.request({ method: 'eth_chainId' })); emit();
}

/** Sign-in with a plain EIP-191 message; verified nowhere (no server) — proves control of the account to this page only. */
export async function signIn() {
  const nonce = crypto.getRandomValues(new Uint32Array(2)).join('');
  const msg = `${location.host} wants you to sign in with your wallet.\n\nTESTNET ONLY - no funds, no gas, no transaction.\nAccount: ${state.account}\nChain ID: ${state.chainId}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  await state.provider.request({ method: 'personal_sign', params: [ '0x' + [...new TextEncoder().encode(msg)].map((b) => b.toString(16).padStart(2, '0')).join(''), state.account] });
  state.signedIn = true; emit();
}

export async function sendTx(to, data) {
  return state.provider.request({ method: 'eth_sendTransaction', params: [{ from: state.account, to, data }] });
}

// ---- read-only JSON-RPC straight to the chain's public RPC (no wallet needed)
let rid = 1;
export async function rpc(chain, method, params = []) {
  const r = await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
export const call = (chain, to, data) => rpc(chain, 'eth_call', [{ to, data }, 'latest']);
export async function waitReceipt(chain, hash, tries = 90) {
  for (let i = 0; i < tries; i++) { const r = await rpc(chain, 'eth_getTransactionReceipt', [hash]); if (r) { if (r.status !== '0x1') throw new Error('transaction reverted'); return r; } await new Promise((s) => setTimeout(s, 1500)); }
  throw new Error('timed out waiting for confirmation');
}
