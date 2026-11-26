// Grid mode ("tap a price/time cell"): pure maths, no DOM. Unit-tested.
//
// A cell is a price band [lo, hi) during a time slot [start, end). A bet on a cell wins
// stake × multiplier if the price touches the band at any moment inside the slot.
// Multipliers come from a Monte Carlo simulation of the price as a random walk with the
// volatility measured from the live feed, minus a house edge.

import type { PriceTick } from './candles';

export const HOUSE_EDGE = 0.05;
export const MIN_MULT = 1.05;
export const MAX_MULT = 100;

export type BetStatus = 'open' | 'won' | 'lost' | 'void';

export interface Bet {
  id: number;
  start: number; // slot start, epoch ms
  end: number; // slot end, epoch ms
  lo: number; // band low (inclusive)
  hi: number; // band high
  stake: number;
  mult: number; // locked at placement
  placedAt: number;
  status: BetStatus;
  settledAt?: number;
}

/** Time slot length per zoom level: about 4 future columns on screen. */
export function slotMs(windowSec: number): number {
  if (windowSec <= 45) return 5000;
  if (windowSec <= 120) return 10_000;
  return 30_000;
}

/** Price at time t (last tick at or before t). `ticks` sorted by time. */
function priceAt(ticks: PriceTick[], t: number): number | null {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? ticks[lo - 1].p : null;
}

/**
 * Volatility in $ per √second: standard deviation of 1-second price changes over the
 * lookback. Floored so a quiet market never produces absurd multipliers.
 */
export function volatility(ticks: PriceTick[], now: number, lookbackMs = 60_000, floor = 0.5): number {
  const diffs: number[] = [];
  let prev = priceAt(ticks, now - lookbackMs);
  for (let t = now - lookbackMs + 1000; t <= now; t += 1000) {
    const p = priceAt(ticks, t);
    if (p !== null && prev !== null) diffs.push(p - prev);
    prev = p;
  }
  if (diffs.length < 5) return floor;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const v = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1);
  return Math.max(floor, Math.sqrt(v));
}

export interface Slot {
  start: number;
  end: number;
}
export interface Band {
  lo: number;
  hi: number;
}

/** Standard normal sample (Box-Muller). */
function gauss(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Probability that the price touches each band during each slot, by simulation.
 * Returns probs[slotIndex][bandIndex]. Uses the Broadie-Glasserman continuity
 * correction (bands widened by 0.5826·σ·√Δt) so discrete steps do not miss touches
 * that a continuous path would make.
 */
export function touchProbabilities(
  p0: number,
  sigma: number,
  now: number,
  slots: Slot[],
  bands: Band[],
  paths = 400,
  rng: () => number = Math.random,
): number[][] {
  const probs = slots.map(() => bands.map(() => 0));
  if (!slots.length || !bands.length) return probs;
  const horizon = Math.max(...slots.map((s) => s.end));
  const dtMs = Math.max(50, Math.min(...slots.map((s) => s.end - s.start)) / 20);
  const stepSd = sigma * Math.sqrt(dtMs / 1000);
  const widen = 0.5826 * stepSd;
  const hits = slots.map(() => bands.map(() => 0));
  const mins = new Array<number>(slots.length);
  const maxs = new Array<number>(slots.length);

  for (let k = 0; k < paths; k++) {
    mins.fill(Infinity);
    maxs.fill(-Infinity);
    let x = p0;
    for (let t = now; t <= horizon; t += dtMs) {
      if (t > now) x += stepSd * gauss(rng);
      for (let s = 0; s < slots.length; s++) {
        if (t >= slots[s].start && t <= slots[s].end) {
          if (x < mins[s]) mins[s] = x;
          if (x > maxs[s]) maxs[s] = x;
        }
      }
    }
    for (let s = 0; s < slots.length; s++) {
      if (mins[s] === Infinity) continue;
      for (let b = 0; b < bands.length; b++) {
        if (maxs[s] >= bands[b].lo - widen && mins[s] <= bands[b].hi + widen) hits[s][b]++;
      }
    }
  }
  for (let s = 0; s < slots.length; s++) {
    for (let b = 0; b < bands.length; b++) probs[s][b] = (hits[s][b] + 0.5) / (paths + 1);
  }
  return probs;
}

/** Payout multiplier for a touch probability, after the house edge. */
export function multiplierFor(prob: number, edge = HOUSE_EDGE): number {
  const m = (1 - edge) / Math.max(prob, 1e-6);
  return Math.round(Math.min(MAX_MULT, Math.max(MIN_MULT, m)) * 100) / 100;
}

/**
 * Checks one price segment (prev tick → tick) against open bets. The segment is
 * interpolated to the slot boundaries, so a move before the slot never counts.
 * Returns the bets that were touched (now 'won').
 */
export function settleSegment(bets: Bet[], prev: PriceTick, cur: PriceTick): Bet[] {
  const won: Bet[] = [];
  if (cur.t <= prev.t) return won;
  const at = (t: number) => prev.p + ((cur.p - prev.p) * (t - prev.t)) / (cur.t - prev.t);
  for (const bet of bets) {
    if (bet.status !== 'open') continue;
    const a = Math.max(prev.t, bet.start);
    const b = Math.min(cur.t, bet.end);
    if (a > b) continue;
    const pa = at(a);
    const pb = at(b);
    if (Math.max(pa, pb) >= bet.lo && Math.min(pa, pb) <= bet.hi) {
      bet.status = 'won';
      bet.settledAt = cur.t;
      won.push(bet);
    }
  }
  return won;
}

/** Marks bets whose slot is over without a touch as lost. Returns them. */
export function expireBets(bets: Bet[], now: number): Bet[] {
  const lost: Bet[] = [];
  for (const bet of bets) {
    if (bet.status === 'open' && now >= bet.end) {
      bet.status = 'lost';
      bet.settledAt = now;
      lost.push(bet);
    }
  }
  return lost;
}

/** Net result of a settled bet for statistics (stake already left the balance). */
export function betNet(bet: Bet): number {
  if (bet.status === 'won') return Math.round(bet.stake * (bet.mult - 1) * 100) / 100;
  if (bet.status === 'lost') return -bet.stake;
  return 0;
}
