import { describe, expect, it } from 'vitest';
import {
  type Bet,
  MAX_MULT,
  betNet,
  expireBets,
  multiplierFor,
  settleSegment,
  slotMs,
  touchProbabilities,
  volatility,
} from '../src/grid-logic';

/** Small deterministic PRNG (mulberry32) so simulations are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bet = (over: Partial<Bet>): Bet => ({
  id: 1,
  start: 10_000,
  end: 15_000,
  lo: 100,
  hi: 102,
  stake: 10,
  mult: 3,
  placedAt: 0,
  status: 'open',
  ...over,
});

describe('slotMs', () => {
  it('scales with zoom', () => {
    expect(slotMs(30)).toBe(5000);
    expect(slotMs(60)).toBe(10_000);
    expect(slotMs(300)).toBe(30_000);
  });
});

describe('volatility', () => {
  it('measures the spread of 1-second moves and has a floor', () => {
    const flat = Array.from({ length: 61 }, (_, i) => ({ t: i * 1000, p: 100 }));
    expect(volatility(flat, 60_000)).toBe(0.5);
    const zigzag = Array.from({ length: 61 }, (_, i) => ({ t: i * 1000, p: i % 2 ? 104 : 100 }));
    expect(volatility(zigzag, 60_000)).toBeCloseTo(4, 0);
  });
});

describe('touchProbabilities', () => {
  const slots = [{ start: 5000, end: 10_000 }];
  it('is near 1 for the band around the current price and falls with distance', () => {
    const bands = [
      { lo: 99, hi: 101 },
      { lo: 105, hi: 107 },
      { lo: 115, hi: 117 },
    ];
    const [[near, mid, far]] = touchProbabilities(100, 1, 0, slots, bands, 2000, rng(1));
    expect(near).toBeGreaterThan(0.7);
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
  });
  it('matches the reflection principle for a level touch within T', () => {
    // P(max of Brownian motion over T ≥ d) = 2·(1 − Φ(d / (σ√T))); d = 2σ√T → ≈ 0.0455
    const sigma = 1;
    const T = 10;
    const d = 2 * sigma * Math.sqrt(T);
    const [[p]] = touchProbabilities(100, sigma, 0, [{ start: 0, end: T * 1000 }], [{ lo: 100 + d, hi: 1e9 }], 6000, rng(7));
    expect(p).toBeGreaterThan(0.03);
    expect(p).toBeLessThan(0.065);
  });
});

describe('multiplierFor', () => {
  it('pays (1 − edge) / p, clamped', () => {
    expect(multiplierFor(0.5)).toBe(1.9);
    expect(multiplierFor(0.1)).toBe(9.5);
    expect(multiplierFor(1)).toBe(1.05);
    expect(multiplierFor(0)).toBe(MAX_MULT);
  });
  it('gives the house a 5 % edge on average', () => {
    const p = 0.2;
    const ev = p * multiplierFor(p) - 1; // per 1 $ stake
    expect(ev).toBeCloseTo(-0.05, 2);
  });
});

describe('settleSegment', () => {
  it('wins when the price passes through the band inside the slot', () => {
    const b = bet({});
    expect(settleSegment([b], { t: 11_000, p: 98 }, { t: 12_000, p: 105 })).toEqual([b]);
    expect(b.status).toBe('won');
  });
  it('ignores a touch that happened before the slot started', () => {
    const b = bet({});
    // price is in the band at t=9000, leaves it by t=10000 (slot start)
    settleSegment([b], { t: 9000, p: 101 }, { t: 9900, p: 110 });
    settleSegment([b], { t: 9900, p: 110 }, { t: 11_000, p: 111 });
    expect(b.status).toBe('open');
  });
  it('interpolates a segment that straddles the slot start', () => {
    const b = bet({});
    // linear from 90 at 9000 to 110 at 11000 → 100 at 10000 (inside the band at slot start)
    settleSegment([b], { t: 9000, p: 90 }, { t: 11_000, p: 110 });
    expect(b.status).toBe('won');
  });
});

describe('expireBets / betNet', () => {
  it('loses an untouched bet when its slot ends', () => {
    const b = bet({});
    expect(expireBets([b], 14_999)).toEqual([]);
    expect(expireBets([b], 15_000)).toEqual([b]);
    expect(b.status).toBe('lost');
    expect(betNet(b)).toBe(-10);
  });
  it('nets stake × (mult − 1) on a win', () => {
    expect(betNet(bet({ status: 'won', mult: 3.4 }))).toBe(24);
    expect(betNet(bet({ status: 'void' }))).toBe(0);
  });
});
