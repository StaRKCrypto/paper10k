// Farcaster mini app support. Only loads the (MIT) SDK bundle when the page runs inside a mini app host (iframe / webview) or ?miniapp=1.
// Calls sdk.actions.ready() (hides the host splash) and exposes the host wallet as an EIP-6963 provider ("Farcaster Wallet").
const maybe = window.parent !== window || /[?&]miniapp=1/.test(location.search) || !!window.ReactNativeWebView;
if (maybe) {
  const s = document.createElement('script'); s.src = 'vendor/farcaster-miniapp.bundle.js';
  s.onload = async () => {
    const sdk = window.__P10K_FC; if (!sdk) return;
    try {
      if (!(await sdk.isInMiniApp())) return;
      document.body.dataset.miniapp = '1';
      await sdk.actions.ready();
      const provider = await sdk.wallet.getEthereumProvider();
      if (provider) {
        const detail = Object.freeze({ info: { uuid: 'farcaster-miniapp', name: 'Farcaster Wallet', icon: 'data:,', rdns: 'xyz.farcaster' }, provider });
        const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
        window.addEventListener('eip6963:requestProvider', ann); ann();
      }
    } catch (e) { console.warn('miniapp', e?.message); }
  };
  document.head.append(s);
}
