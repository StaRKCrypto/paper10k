// Self-written canvas candlestick chart (no dependencies).
export const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };
export class Chart {
  constructor(canvas) { this.cv = canvas; this.ctx = canvas.getContext('2d'); this.candles = []; this.tf = '1m'; this.lines = []; this.cross = null;
    canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); this.cross = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
    canvas.addEventListener('mouseleave', () => { this.cross = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas); }
  set(candles, tf) { this.candles = candles; this.tf = tf; this.draw(); }
  tick(price, now = Date.now()) {
    if (!(price > 0) || !this.candles.length) return;
    const ms = TF_MS[this.tf], t = Math.floor(now / ms) * ms, last = this.candles[this.candles.length - 1];
    if (t > last.t) this.candles.push({ t, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price });
    else { last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); }
    if (this.candles.length > 400) this.candles.shift();
  }
  fmt(p) { return p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(5); }
  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = this.ctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const cs = this.candles.slice(-Math.max(20, Math.floor(w / 9)));
    if (!cs.length) { g.fillStyle = '#c3b6ee'; g.font = '13px Inter,sans-serif'; g.fillText('Waiting for live candles…', 16, 28); return; }
    const padR = 64, padB = 20, W = w - padR, H = h - padB;
    let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
    for (const l of this.lines) if (l.price > 0 && l.price > lo * 0.97 && l.price < hi * 1.03) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
    const pad = (hi - lo) * 0.08 || hi * 0.001; lo -= pad; hi += pad;
    const y = (p) => H - ((p - lo) / (hi - lo)) * H, bw = W / cs.length;
    g.font = '11px "IBM Plex Mono",monospace'; g.textBaseline = 'middle';
    g.strokeStyle = '#3a2a6e'; g.fillStyle = '#c3b6ee'; g.lineWidth = 1;
    for (let i = 0; i <= 5; i++) { const p = lo + ((hi - lo) * i) / 5, yy = y(p); g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); g.fillText(this.fmt(p), W + 6, yy); }
    cs.forEach((c, i) => {
      const x = i * bw + bw / 2, up = c.c >= c.o; g.strokeStyle = g.fillStyle = up ? '#3dffb0' : '#ff5c9a';
      g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
      const t = y(Math.max(c.o, c.c)), b = Math.max(1, Math.abs(y(c.o) - y(c.c))); g.fillRect(x - bw * 0.35, t, bw * 0.7, b);
    });
    const last = cs[cs.length - 1];
    const hl = (p, color, label, dash) => { const yy = y(p); g.save(); g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); g.restore();
      g.fillStyle = color; g.fillRect(W, yy - 9, padR, 18); g.fillStyle = '#05080d'; g.fillText(label ?? this.fmt(p), W + 4, yy); };
    for (const l of this.lines) if (l.price > lo && l.price < hi) { hl(l.price, l.color, null, [5, 4]); g.fillStyle = l.color; g.fillText(l.label, 8, y(l.price) - 8); }
    hl(last.c, last.c >= last.o ? '#3dffb0' : '#ff5c9a', null, [2, 3]);
    g.fillStyle = '#c3b6ee'; g.textBaseline = 'alphabetic';
    for (let i = 0; i < cs.length; i += Math.ceil(cs.length / 6)) { const d = new Date(cs[i].t); g.fillText(d.toTimeString().slice(0, 5), i * bw, h - 5); }
    if (this.cross && this.cross.x < W && this.cross.y < H) { g.strokeStyle = '#3a4a63'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(this.cross.x, 0); g.lineTo(this.cross.x, H); g.moveTo(0, this.cross.y); g.lineTo(W, this.cross.y); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#e6edf7'; g.fillText(this.fmt(lo + ((H - this.cross.y) / H) * (hi - lo)), W + 6, this.cross.y); }
  }
}
