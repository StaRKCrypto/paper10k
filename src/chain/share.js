// On-chain win / rekt PnL cards (client-side canvas PNG) + share to Farcaster / X / download. No upload, no server.
import { renderCard } from '../card.js';
import { APP_URL } from './config.js';

/** r: { id, market, isLong, lev, margin, pnl (number, collateral units as float), liq, ts, chainName, sym } */
export function cardCanvas(r) {
  const pct = r.margin ? (r.pnl / r.margin) * 100 : 0;
  return renderCard(document.createElement('canvas'), {
    title: `${r.sym}-PERP ${r.isLong ? 'LONG' : 'SHORT'} ${r.lev}x`, badge: r.liq ? 'REKT' : r.pnl >= 0 ? 'WIN' : 'LOSS', side: r.isLong ? 'long' : 'short',
    pct, pnl: r.pnl, liq: r.liq, ts: r.ts * 1000, unit: ' USDC',
    sub: `ON-CHAIN · ${r.chainName} · position #${r.id} · NOT FINANCIAL ADVICE`,
    lines: [r.liq ? 'Liquidated. PAPER10KX minted (a score, no cash value).' : 'Closed on PAPER10K.'],
  });
}

const blobOf = (cv) => new Promise((res) => cv.toBlob(res, 'image/png'));
const text = (r) => r.liq ? `Got rekt at ${r.lev}x on PAPER10K 💀` : r.pnl >= 0 ? `+${r.pnl.toFixed(2)} USDC at ${r.lev}x on PAPER10K` : `Closed ${r.lev}x on PAPER10K`;
const site = () => APP_URL || location.origin;

export async function share(r, how) {
  const cv = cardCanvas(r), blob = await blobOf(cv), file = new File([blob], `paper10k-${r.id}.png`, { type: 'image/png' });
  if (how === 'native' && navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], text: text(r), url: site() });
  if (how === 'farcaster') return window.open(`https://farcaster.xyz/~/compose?text=${encodeURIComponent(text(r))}&embeds[]=${encodeURIComponent(site())}`, '_blank', 'noopener');
  if (how === 'x') return window.open(`https://x.com/intent/post?text=${encodeURIComponent(text(r))}&url=${encodeURIComponent(site())}`, '_blank', 'noopener');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
