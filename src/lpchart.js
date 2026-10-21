// Tiny canvas line chart for pool history (no dependencies).
export function drawLine(cv, pts, { color = '#12a36b', fmt = (v) => v.toFixed(2), baseline = null } = {}) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  c.fillStyle = '#8a8a84'; c.font = '11px ui-monospace,monospace';
  if (pts.length < 2) { c.fillText('collecting pool history… (samples every ~5 s while this tab is open)', 12, h / 2); return; }
  const L = 64, R = 10, T = 12, B = 20, t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v)); if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  if (hi - lo < 1e-12) { hi += Math.abs(hi) * 1e-6 + 1e-6; lo -= Math.abs(lo) * 1e-6 + 1e-6; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (w - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  c.strokeStyle = '#efeee9'; c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Y(v); c.beginPath(); c.moveTo(L, y); c.lineTo(w - R, y); c.stroke(); c.fillText(fmt(v), 4, y + 4); }
  if (baseline != null) { c.strokeStyle = '#c9c8c1'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(L, Y(baseline)); c.lineTo(w - R, Y(baseline)); c.stroke(); c.setLineDash([]); }
  c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.v)) : c.moveTo(X(p.t), Y(p.v)))); c.strokeStyle = color; c.lineWidth = 2; c.stroke();
  c.lineTo(X(t1), h - B); c.lineTo(X(t0), h - B); c.closePath(); c.fillStyle = color + '18'; c.fill();
  c.fillStyle = '#8a8a84'; const span = Math.round((t1 - t0) / 1000); c.fillText(span >= 120 ? Math.round(span / 60) + ' min of history' : span + ' s of history', L, h - 5);
}
