// Grid mode controller: keeps multipliers fresh, draws cells and bets, hit-tests taps.

import type { PriceTick } from './candles';
import { type ChartGeom, niceStep, withAlpha } from './chart';
import {
  type Band,
  type Bet,
  type Slot,
  expireBets,
  multiplierFor,
  settleSegment,
  slotMs,
  touchProbabilities,
  volatility,
} from './grid-logic';

const ROWS = 8; // about this many price rows across the visible range
const LEAD_MS = 500; // a slot must start at least this far in the future to be bettable
const REFRESH_MS = 400; // multiplier refresh interval
const DISPLAY_PATHS = 300;
const LOCK_PATHS = 2000; // more precise simulation when a bet is placed

export interface Cell extends Slot, Band {}

export interface GridColors {
  cell: string;
  text: string;
  accent: string;
  up: string;
  down: string;
  strong: string;
}

const fmtMult = (m: number) => `${m.toLocaleString('de-DE', { maximumFractionDigits: m < 10 ? 1 : 0 })}×`;
const fmtMoney = (v: number) =>
  `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })} $`;

export class GridMode {
  bets: Bet[] = [];
  rowSize = 5;
  /** Rows are never smaller than one price step of the market. */
  minRow = 0.01;
  private sigma = 1;
  private mults = new Map<string, number>();
  private lastRefresh = 0;
  private lastSigma = 0;
  private lastRow = 0;
  private nextId = 1;

  private key = (start: number, lo: number) => `${start}|${lo}`;

  get openBets(): Bet[] {
    return this.bets.filter((b) => b.status === 'open');
  }

  /** Drop everything, e.g. after switching to another market. */
  clear(): void {
    this.bets = [];
    this.mults.clear();
    this.lastSigma = 0;
    this.lastRow = 0;
  }

  /** Price range of open bets, so the chart keeps them in view. */
  get range(): { lo: number; hi: number } | null {
    const open = this.openBets;
    if (!open.length) return null;
    return { lo: Math.min(...open.map((b) => b.lo)), hi: Math.max(...open.map((b) => b.hi)) };
  }

  /** Visible future slots and price bands for the current chart mapping. */
  private layout(g: ChartGeom, windowSec: number): { slots: Slot[]; bands: Band[] } {
    const len = slotMs(windowSec);
    const slots: Slot[] = [];
    for (let start = Math.ceil((g.wall + LEAD_MS) / len) * len; g.X(start) < g.plotR; start += len) {
      slots.push({ start, end: start + len });
    }
    const bands: Band[] = [];
    const r = this.rowSize;
    for (let lo = Math.floor(g.yMin / r) * r; lo < g.yMax; lo += r) bands.push({ lo, hi: lo + r });
    return { slots, bands };
  }

  /** Refreshes volatility, row size and multipliers (throttled). */
  update(g: ChartGeom, ticks: PriceTick[], windowSec: number, price: number): void {
    const now = g.wall;
    if (now - this.lastSigma > 2000) {
      this.sigma = volatility(ticks, now, 60_000, price * 5e-6); // floor relative to the price
      this.lastSigma = now;
    }
    if (now - this.lastRow > 3000) {
      // rows follow the visible range (like the price axis), re-evaluated every 3 s so they do not jitter
      this.rowSize = Math.max(this.minRow, niceStep(g.yMax - g.yMin, ROWS));
      this.lastRow = now;
    }
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const { slots, bands } = this.layout(g, windowSec);
    const probs = touchProbabilities(price, this.sigma, now, slots, bands, DISPLAY_PATHS);
    this.mults.clear();
    slots.forEach((s, i) => {
      bands.forEach((b, j) => this.mults.set(this.key(s.start, b.lo), multiplierFor(probs[i][j])));
    });
  }

  /** Cell under a tap, if it is a bettable future cell. */
  hit(x: number, y: number, g: ChartGeom, windowSec: number): Cell | null {
    if (x <= g.headX || x >= g.plotR || y < g.top - 20 || y > g.bottom + 20) return null;
    const len = slotMs(windowSec);
    const start = Math.floor(g.invX(x) / len) * len;
    if (start < g.wall + LEAD_MS) return null;
    const lo = Math.floor(g.invY(y) / this.rowSize) * this.rowSize;
    return { start, end: start + len, lo, hi: lo + this.rowSize };
  }

  /** Places a bet; the multiplier is locked with a more precise simulation. */
  place(cell: Cell, stake: number, price: number, now: number): Bet {
    const [[p]] = touchProbabilities(price, this.sigma, now, [cell], [cell], LOCK_PATHS);
    const bet: Bet = { id: this.nextId++, ...cell, stake, mult: multiplierFor(p), placedAt: now, status: 'open' };
    this.bets.push(bet);
    return bet;
  }

  onTick(prev: PriceTick, cur: PriceTick): Bet[] {
    return settleSegment(this.bets, prev, cur);
  }

  expire(now: number): Bet[] {
    return expireBets(this.bets, now);
  }

  /** Cancels all open bets (connection lost, app left). */
  voidOpen(now: number): Bet[] {
    const open = this.openBets;
    for (const b of open) {
      b.status = 'void';
      b.settledAt = now;
    }
    return open;
  }

  /** Forget settled bets that scrolled off screen. */
  prune(g: ChartGeom): void {
    this.bets = this.bets.filter((b) => b.status === 'open' || g.X(b.end) > -40);
  }

  draw(ctx: CanvasRenderingContext2D, g: ChartGeom, windowSec: number, col: GridColors): void {
    const { slots, bands } = this.layout(g, windowSec);
    const cellH = Math.abs(g.Y(0) - g.Y(this.rowSize));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, g.top - 12, g.plotR, g.bottom - g.top + 24);
    ctx.clip();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = Math.max(10, Math.min(14, cellH * 0.38));
    const covered = (s: Slot, b: Band) =>
      this.bets.some((bet) => bet.start === s.start && bet.lo < b.hi && bet.hi > b.lo);

    // empty future cells with multipliers
    for (const s of slots) {
      const x0 = g.X(s.start) + 2;
      const x1 = Math.min(g.X(s.end), g.plotR) - 2;
      if (x1 - x0 < 8) continue;
      for (const b of bands) {
        const y0 = g.Y(b.hi) + 2;
        const y1 = g.Y(b.lo) - 2;
        if (y1 < g.top - 30 || y0 > g.bottom + 30) continue;
        rounded(ctx, x0, y0, x1 - x0, y1 - y0, 6);
        ctx.fillStyle = withAlpha(col.cell, 0.06);
        ctx.fill();
        ctx.strokeStyle = withAlpha(col.cell, 0.22);
        ctx.lineWidth = 1;
        ctx.stroke();
        const m = this.mults.get(this.key(s.start, b.lo));
        if (m !== undefined && y1 - y0 > 14 && !covered(s, b)) {
          ctx.fillStyle = m >= 10 ? col.accent : col.text;
          fitText(ctx, fmtMult(m), (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 6, font, 700);
        }
      }
    }

    // bets (open and recently settled)
    for (const bet of this.bets) {
      const x0 = g.X(bet.start) + 2;
      const x1 = Math.min(g.X(bet.end), g.plotR) - 2;
      if (x1 < 0 || x1 - x0 < 4) continue;
      const y0 = g.Y(bet.hi) + 2;
      const y1 = g.Y(bet.lo) - 2;
      const age = bet.settledAt ? (g.wall - bet.settledAt) / 1000 : 0;
      const fade = bet.status === 'open' ? 1 : Math.max(0.55, 1 - age / 6);
      const c =
        bet.status === 'won' ? col.up : bet.status === 'lost' ? col.down : bet.status === 'void' ? col.text : col.accent;
      rounded(ctx, x0, y0, x1 - x0, y1 - y0, 6);
      ctx.fillStyle = withAlpha(c, (bet.status === 'open' ? 0.32 : 0.4) * fade);
      ctx.fill();
      ctx.strokeStyle = withAlpha(c, fade);
      ctx.lineWidth = bet.status === 'open' ? 2 : 1.5;
      ctx.stroke();
      if (y1 - y0 > 14) {
        const label =
          bet.status === 'won'
            ? fmtMoney(bet.stake * (bet.mult - 1))
            : bet.status === 'lost'
              ? fmtMoney(-bet.stake)
              : bet.status === 'void'
                ? '↺'
                : fmtMult(bet.mult);
        ctx.fillStyle = withAlpha(col.strong, fade);
        fitText(ctx, label, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 6, font, 800);
      }
    }
    ctx.restore();
  }
}

/** Draws centered text, shrinking the font to fit `maxW`; skips it if it would get too small. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight: number): void {
  let s = size;
  for (;;) {
    ctx.font = `${weight} ${s}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    s -= 1;
    if (s < 8) return;
  }
  ctx.fillText(text, x, y);
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
