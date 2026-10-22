// EIP-1193 wallet layer: Reown AppKit modal (vendored, lazy: EIP-6963 wallets, WalletConnect v2 QR + mobile deep links,
// Base Account / Coinbase Smart Wallet passkeys, Safe app), plus the dependency-free injected + WalletConnect fallback.
// EIP-5792 batched calls with ERC-7677 paymaster sponsorship when the wallet supports it. No analytics.
import { CHAINS, WC_PROJECT_ID, PAYMASTER_URLS, APP_URL, ENS_RPC, MAINNET_ENABLED, availableChains } from './config.js';

export const state = { provider: null, kind: null, account: null, chainId: null, signedIn: false, name: '', ens: null, caps: null };
const subs = new Set();
export const onChange = (f) => subs.add(f);
const emit = () => subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } });

const eip6963 = [];
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.provider && !eip6963.find((x) => x.info.uuid === e.detail.info.uuid)) eip6963.push(e.detail); emit(); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
export function injectedProviders() {
  const out = eip6963.map((d) => ({ name: d.info.name, icon: d.info.icon, provider: d.provider }));
  if (!out.length && window.ethereum) out.push({ name: window.ethereum.isMetaMask ? 'MetaMask / injected' : 'Injected wallet', provider: window.ethereum });
  return out;
}

const hexToNum = (h) => parseInt(h, 16);
function attach(p) {
  p.on?.('accountsChanged', (a) => { if (state.provider !== p) return; state.account = a[0] || null; state.signedIn = false; state.ens = null; if (!state.account) disconnect(); else afterConnect(); });
  p.on?.('chainChanged', (c) => { if (state.provider !== p) return; state.chainId = typeof c === 'number' ? c : hexToNum(c); emit(); });
  p.on?.('disconnect', () => { if (state.provider === p) disconnect(); });
}

export async function connectInjected(entry) {
  const p = entry.provider;
  const accts = await p.request({ method: 'eth_requestAccounts' });
  state.provider = p; state.kind = 'injected'; state.name = entry.name; state.account = accts[0];
  state.chainId = hexToNum(await p.request({ method: 'eth_chainId' }));
  state.signedIn = false; attach(p); afterConnect();
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
  if (!WC_PROJECT_ID) throw new Error('WalletConnect isn\u2019t available here yet. Please use a browser wallet.');
  const { EthereumProvider } = await loadWC();
  const chains = availableChains(); const first = preferChain || chains[0].id;
  const rpcMap = Object.fromEntries(chains.map((c) => [c.id, c.rpc]));
  const p = await EthereumProvider.init({ projectId: WC_PROJECT_ID, chains: [first], optionalChains: chains.map((c) => c.id).filter((i) => i !== first), rpcMap, showQrModal: false,
    methods: ['eth_sendTransaction', 'personal_sign'], optionalMethods: ['wallet_switchEthereumChain', 'wallet_addEthereumChain'],
    metadata: { name: 'PAPER10K', description: 'Testnet paper perps', url: location.origin, icons: [] } });
  p.on('display_uri', onUri);
  await p.connect();
  state.provider = p; state.kind = 'walletconnect'; state.name = 'WalletConnect'; state.account = p.accounts[0]; state.chainId = p.chainId; state.signedIn = false;
  attach(p); afterConnect();
}

// ---- Reown AppKit (standard modal). Lazy: 4.7 MB bundle only loads when the user opens it.
let akScript = null, kit = null, unwatch = null;
function loadAppKit() {
  if (window.__P10K_APPKIT) return Promise.resolve(window.__P10K_APPKIT);
  akScript ??= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/appkit.bundle.js';
    s.onload = () => res(window.__P10K_APPKIT); s.onerror = () => { akScript = null; rej(new Error('could not load vendor/appkit.bundle.js')); }; document.head.append(s);
  });
  return akScript;
}
export const appKitAvailable = () => !!WC_PROJECT_ID;
export async function openAppKit() {
  if (!WC_PROJECT_ID) throw new Error('WalletConnect isn\u2019t available here yet. Please use a browser wallet.');
  const AK = await loadAppKit();
  if (!kit) {
    kit = AK.init({ projectId: WC_PROJECT_ID, mainnet: MAINNET_ENABLED, appUrl: APP_URL || location.origin, icon: (APP_URL || location.origin) + '/icon.png' });
    unwatch = kit.watch(async (a) => {
      if (a.status === 'connected' && a.address) {
        const p = await kit.provider(); if (!p) return;
        if (state.provider !== p) { state.provider = p; attach(p); }
        Object.assign(state, { kind: 'appkit', name: a.connector?.name || 'Wallet', account: a.address, chainId: a.chainId, signedIn: state.account === a.address && state.signedIn });
        afterConnect();
      } else if (a.status === 'disconnected' && state.kind === 'appkit') { reset(); }
    });
  }
  kit.open();
}

function reset() { Object.assign(state, { provider: null, kind: null, account: null, chainId: null, signedIn: false, name: '', ens: null, caps: null }); emit(); }
export async function disconnect() {
  try { if (state.kind === 'walletconnect') await state.provider?.disconnect?.(); if (state.kind === 'appkit') await kit?.disconnect(); } catch { /* ignore */ }
  reset();
}

/** after any connection: load EIP-5792 capabilities and ENS/Basename (best effort, never blocks) */
async function afterConnect() {
  emit();
  const acct = state.account;
  state.caps = null;
  try { state.caps = await state.provider.request({ method: 'wallet_getCapabilities', params: [acct] }); } catch { /* wallet without EIP-5792 */ }
  try { const AK = window.__P10K_APPKIT || (state.kind === 'appkit' ? await loadAppKit() : null); if (AK && state.account === acct) state.ens = await AK.lookupName(acct, ENS_RPC); } catch { /* none */ }
  if (state.account === acct) emit();
}

const capFor = (chainId) => state.caps?.['0x' + Number(chainId).toString(16)] || state.caps?.[String(chainId)] || null;
/** true if the connected wallet supports ERC-7677 paymaster sponsorship on this chain AND a paymaster URL is configured */
export function gaslessReady(chainId = state.chainId) {
  const c = capFor(chainId); return !!(PAYMASTER_URLS[chainId] && c?.paymasterService?.supported);
}
export function batchReady(chainId = state.chainId) {
  const c = capFor(chainId); return !!(c?.atomic?.status === 'supported' || c?.atomic?.status === 'ready' || c?.atomicBatch?.supported);
}

/**
 * Send one or more calls. Uses EIP-5792 wallet_sendCalls (atomic batch, + paymaster when configured & supported),
 * otherwise sends them one by one with eth_sendTransaction. Resolves to the LAST transaction hash.
 * @param {{to:string,data:string}[]} calls
 */
export async function sendCalls(calls, chainId = state.chainId) {
  const gasless = gaslessReady(chainId);
  if (gasless || (calls.length > 1 && batchReady(chainId))) {
    const params = [{ version: '2.0.0', chainId: '0x' + Number(chainId).toString(16), from: state.account, atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: '0x0' })),
      capabilities: gasless ? { paymasterService: { url: PAYMASTER_URLS[chainId] } } : {} }];
    const r = await state.provider.request({ method: 'wallet_sendCalls', params });
    const id = typeof r === 'string' ? r : r?.id;
    for (let i = 0; i < 120; i++) {
      const st = await state.provider.request({ method: 'wallet_getCallsStatus', params: [id] });
      const code = typeof st?.status === 'number' ? st.status : st?.status === 'CONFIRMED' ? 200 : st?.status === 'PENDING' ? 100 : 0;
      if (code >= 200 && code < 300) { const rc = st.receipts?.at(-1); if (rc && rc.status !== '0x1' && rc.status !== 'success') throw new Error('transaction reverted'); return rc?.transactionHash; }
      if (code >= 400) throw new Error('batch failed (status ' + code + ')');
      await new Promise((s) => setTimeout(s, 1500));
    }
    throw new Error('timed out waiting for the wallet batch');
  }
  let h; for (const c of calls) { h = await sendTx(c.to, c.data); if (calls.length > 1) await waitReceipt(chainById(chainId), h); }
  return h;
}
const chainById = (id) => CHAINS[id];

/** WalletConnect mobile deep links for the dependency-free fallback path */
export const wcDeepLinks = (uri) => {
  const u = encodeURIComponent(uri);
  return [['MetaMask', `metamask://wc?uri=${u}`], ['Trust', `trust://wc?uri=${u}`], ['Rainbow', `rainbow://wc?uri=${u}`], ['Coinbase', `cbwallet://wc?uri=${u}`], ['Any wallet', uri]];
};

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
  const msg = `${location.host} wants you to sign in with your wallet.\n\nNo funds move, no gas, no transaction.\nAccount: ${state.account}\nChain ID: ${state.chainId}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
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
