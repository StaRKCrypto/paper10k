// Shareable PnL card rendered on a canvas -> PNG.
export function renderCard(canvas, d) {
  const W = 1200, H = 630; canvas.width = W; canvas.height = H; const g = canvas.getContext('2d');
  const win = d.pnl >= 0, accent = d.liq ? '#ff4d6a' : win ? '#21e6a1' : '#ff4d6a';
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#070b12'); bg.addColorStop(1, win ? '#06201a' : '#2a0b14');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.04)'; for (let x = 0; x < W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } for (let y = 0; y < H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.fillStyle = accent; g.fillRect(0, 0, 10, H);
  g.fillStyle = '#e6edf7'; g.font = '800 40px Inter,sans-serif'; g.fillText('PAPER10K', 60, 90);
  g.fillStyle = '#ffb020'; g.font = '600 20px Inter,sans-serif'; g.fillText(d.sub || 'PAPER TRADING · SIMULATED FUNDS · NOT FINANCIAL ADVICE', 60, 125);
  g.fillStyle = '#e6edf7'; g.font = '700 54px Inter,sans-serif';
  g.fillText(d.title, 60, 230);
  if (d.badge) { g.fillStyle = d.side === 'short' ? '#ff4d6a' : '#21e6a1'; g.font = '700 30px Inter,sans-serif'; g.fillText(d.badge, 60, 280); }
  g.fillStyle = accent; g.font = '800 140px "IBM Plex Mono",monospace';
  g.fillText((d.pct >= 0 ? '+' : '') + d.pct.toFixed(2) + '%', 60, 440);
  g.font = '600 44px "IBM Plex Mono",monospace'; g.fillText((d.pnl >= 0 ? '+$' : '-$') + Math.abs(d.pnl).toFixed(2) + (d.unit ?? ' (fake USD)'), 60, 505);
  g.fillStyle = '#9fb0c8'; g.font = '500 26px "IBM Plex Mono",monospace';
  d.lines.forEach((l, i) => g.fillText(l, 60, 560 + i * 34));
  if (d.liq) { g.save(); g.translate(880, 330); g.rotate(-0.25); g.strokeStyle = '#ff4d6a'; g.lineWidth = 8; g.strokeRect(-190, -60, 380, 120); g.fillStyle = '#ff4d6a'; g.font = '800 70px Inter,sans-serif'; g.textAlign = 'center'; g.fillText('LIQUIDATED', 0, 24); g.restore(); }
  g.textAlign = 'right'; g.fillStyle = '#6b7a90'; g.font = '500 20px Inter,sans-serif'; g.fillText(new Date(d.ts).toLocaleString(), W - 40, H - 30);
  return canvas;
}
