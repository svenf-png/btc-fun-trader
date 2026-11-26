// Full-screen, continuously scrolling line chart on a canvas (requestAnimationFrame).

import type { Side } from './trading';

export interface Tick {
  t: number; // epoch ms
  p: number;
}

export interface ChartPosition {
  side: Side;
  entry: number;
  liq: number;
  winning: boolean;
}

export interface ChartInsets {
  top: number;
  bottom: number;
}

const AXIS_W = 62; // right axis width in CSS px
const HEAD_GAP = 26; // distance of the live point from the axis

/** Fallbacks used whenever a CSS token cannot be read (e.g. styles not applied yet). */
const FALLBACK = {
  line: '#a78bfa',
  up: '#2ee6a6',
  down: '#ff5277',
  grid: '#1d1a33',
  text: '#8f89b3',
  warn: '#ffb547',
  bg: '#0d0b1a',
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** Reads a #rrggbb token from :root, falling back if it is missing or in another format. */
export function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(v) ? v : fallback;
}

/** "Nice" grid step (1, 2, 2.5, 5 * 10^n) for roughly `count` lines. */
export function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return f * mag;
}

export class Chart {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private yMin = 0;
  private yMax = 0;
  private headP = 0;
  private lastFrame = 0;
  private colors: Record<keyof typeof FALLBACK, string> = { ...FALLBACK };

  ticks: Tick[] = [];
  windowSec = 60; // currently drawn (animated)
  targetWindowSec = 60;
  position: ChartPosition | null = null;
  insets: ChartInsets = { top: 140, bottom: 150 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Default (alpha) context: an opaque canvas shows pure black whenever it is reset.
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d not available');
    this.ctx = ctx;
    this.readColors();
    this.resize();
  }

  readColors(): void {
    this.colors = {
      line: token('--chart-line', FALLBACK.line),
      up: token('--up', FALLBACK.up),
      down: token('--down', FALLBACK.down),
      grid: token('--grid', FALLBACK.grid),
      text: token('--muted', FALLBACK.text),
      warn: token('--warn', FALLBACK.warn),
      bg: token('--bg', FALLBACK.bg),
    };
  }

  /** Matches the backing store to the CSS size; checked every frame (no observer needed). */
  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr && this.canvas.width > 0) return;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  /** Visible time window in seconds; animated unless `immediate`. */
  setWindow(sec: number, immediate = false): void {
    this.targetWindowSec = sec;
    if (immediate) this.windowSec = sec;
  }

  render(now: number): void {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.resize();
    const { ctx, w, h, dpr, colors: c } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.ticks.length || w === 0) return;

    // animate zoom (log space feels even) and head price
    const ease = (k: number) => 1 - Math.exp(-dt * k);
    this.windowSec = Math.exp(
      Math.log(this.windowSec) + (Math.log(this.targetWindowSec) - Math.log(this.windowSec)) * ease(10),
    );
    const last = this.ticks[this.ticks.length - 1];
    this.headP = this.headP ? this.headP + (last.p - this.headP) * ease(14) : last.p;

    const wall = Date.now();
    const plotR = w - AXIS_W;
    const headX = plotR - HEAD_GAP;
    const top = this.insets.top;
    const bottom = h - this.insets.bottom;
    const span = this.windowSec * 1000;
    const pxPerMs = headX / span;
    const t0 = wall - span - 2000;

    // visible range for autoscale
    let lo = this.headP;
    let hi = this.headP;
    let first = this.ticks.length - 1;
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      const tk = this.ticks[i];
      first = i;
      if (tk.t < t0) break;
      if (tk.p < lo) lo = tk.p;
      if (tk.p > hi) hi = tk.p;
    }
    if (this.position) {
      const { entry, liq } = this.position;
      lo = Math.min(lo, entry);
      hi = Math.max(hi, entry);
      // bring the liquidation line into view once the price gets close to it
      if (Math.abs(this.headP - liq) < (hi - lo) * 1.2) {
        lo = Math.min(lo, liq);
        hi = Math.max(hi, liq);
      }
    }
    const minRange = Math.max(4, this.headP * 0.00012); // avoid zooming into noise
    if (hi - lo < minRange) {
      const mid = (hi + lo) / 2;
      lo = mid - minRange / 2;
      hi = mid + minRange / 2;
    }
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;
    if (!this.yMax) {
      this.yMin = lo;
      this.yMax = hi;
    } else {
      this.yMin += (lo - this.yMin) * ease(5);
      this.yMax += (hi - this.yMax) * ease(5);
    }
    const yr = this.yMax - this.yMin || 1;
    const X = (t: number) => headX - (wall - t) * pxPerMs;
    const Y = (p: number) => bottom - ((p - this.yMin) / yr) * (bottom - top);

    // vertical time grid, scrolls with time
    const tStep = this.windowSec <= 45 ? 5000 : this.windowSec <= 120 ? 10000 : 60000;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil((wall - span) / tStep) * tStep; t <= wall; t += tStep) {
      const x = Math.round(X(t)) + 0.5;
      ctx.moveTo(x, top - 20);
      ctx.lineTo(x, bottom + 20);
    }
    ctx.stroke();

    // horizontal price grid + right axis labels
    const step = niceStep(yr, 5);
    ctx.font = '600 11px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const decimals = step < 1 ? 2 : 0;
    ctx.beginPath();
    for (let p = Math.ceil(this.yMin / step) * step; p <= this.yMax; p += step) {
      const y = Math.round(Y(p)) + 0.5;
      if (y < top - 30 || y > bottom + 30) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(plotR, y);
    }
    ctx.stroke();
    ctx.fillStyle = c.text;
    for (let p = Math.ceil(this.yMin / step) * step; p <= this.yMax; p += step) {
      const y = Y(p);
      if (y < top - 10 || y > bottom + 10) continue;
      ctx.fillText(
        p.toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
        plotR + 6,
        y,
      );
    }

    const lineColor = this.position ? (this.position.winning ? c.up : c.down) : c.line;

    // price path
    ctx.beginPath();
    let started = false;
    for (let i = first; i < this.ticks.length; i++) {
      const tk = this.ticks[i];
      const x = X(tk.t);
      const y = Y(tk.p);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    const hy = Y(this.headP);
    ctx.lineTo(headX, hy);

    // area fill
    ctx.save();
    ctx.lineTo(headX, bottom + 40);
    ctx.lineTo(X(this.ticks[first].t), bottom + 40);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom + 40);
    g.addColorStop(0, withAlpha(lineColor, 0.28));
    g.addColorStop(1, withAlpha(lineColor, 0));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // line on top
    ctx.beginPath();
    started = false;
    for (let i = first; i < this.ticks.length; i++) {
      const tk = this.ticks[i];
      if (!started) {
        ctx.moveTo(X(tk.t), Y(tk.p));
        started = true;
      } else ctx.lineTo(X(tk.t), Y(tk.p));
    }
    ctx.lineTo(headX, hy);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = withAlpha(lineColor, 0.6);
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // entry and liquidation lines
    if (this.position) {
      const pos = this.position;
      this.hLine(Y(pos.entry), plotR, pos.side === 'long' ? c.up : c.down, `${pos.side === 'long' ? '▲' : '▼'} ${fmt(pos.entry)}`, [7, 5]);
      const ly = Y(pos.liq);
      if (ly > top - 40 && ly < bottom + 40) this.hLine(ly, plotR, c.warn, `⚠ ${fmt(pos.liq)}`, [2, 4]);
    }

    // live point with pulse
    const pulse = (Math.sin(now / 260) + 1) / 2;
    ctx.fillStyle = withAlpha(lineColor, 0.18 + pulse * 0.15);
    ctx.beginPath();
    ctx.arc(headX, hy, 9 + pulse * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(headX, hy, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // current price tag on the axis
    this.tag(hy, plotR, lineColor, fmt(last.p), true);
  }

  private hLine(y: number, plotR: number, color: string, label: string, dash: number[]): void {
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(plotR, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    this.tag(y, plotR, color, label, false);
  }

  private tag(y: number, plotR: number, color: string, text: string, filled: boolean): void {
    const { ctx } = this;
    ctx.font = '700 11px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 10;
    const x = filled ? plotR + 2 : plotR - tw - 4;
    ctx.fillStyle = filled ? color : withAlpha(this.colors.bg, 0.85);
    roundRect(ctx, x, y - 10, Math.max(tw, filled ? AXIS_W - 4 : 0), 20, 6);
    ctx.fill();
    if (!filled) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = filled ? this.colors.bg : color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y + 0.5);
  }
}

const fmt = (p: number) => p.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Accepts #rrggbb colors from the CSS tokens. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = Number.parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
