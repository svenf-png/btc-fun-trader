import { describe, expect, it } from 'vitest';
import { buildCandles, candleMs } from '../src/candles';

const tk = (t: number, p: number) => ({ t, p });

describe('candleMs', () => {
  it('picks the length by zoom', () => {
    expect(candleMs(30)).toBe(1000);
    expect(candleMs(60)).toBe(2000);
    expect(candleMs(300)).toBe(10_000);
  });
});

describe('buildCandles', () => {
  it('aggregates open/high/low/close per bucket', () => {
    const c = buildCandles([tk(1000, 10), tk(1200, 14), tk(1500, 8), tk(1900, 11)], 1000, 1000, 1999);
    expect(c).toEqual([{ t: 1000, o: 10, h: 14, l: 8, c: 11 }]);
  });
  it('opens each candle at the previous close', () => {
    const c = buildCandles([tk(1000, 10), tk(1900, 11), tk(2100, 13)], 1000, 1000, 2999);
    expect(c[1]).toEqual({ t: 2000, o: 11, h: 13, l: 11, c: 13 });
  });
  it('fills empty buckets with a flat candle', () => {
    const c = buildCandles([tk(1000, 10), tk(3500, 12)], 1000, 1000, 3999);
    expect(c.map((x) => x.t)).toEqual([1000, 2000, 3000]);
    expect(c[1]).toEqual({ t: 2000, o: 10, h: 10, l: 10, c: 10 });
  });
  it('uses the last tick before the range as the first open', () => {
    const c = buildCandles([tk(500, 9), tk(1400, 10)], 1000, 1000, 1999);
    expect(c[0]).toEqual({ t: 1000, o: 9, h: 10, l: 9, c: 10 });
  });
  it('a green/red direction follows close vs open', () => {
    const c = buildCandles([tk(1000, 10), tk(1500, 9), tk(2500, 12)], 1000, 1000, 2999);
    expect(c[0].c < c[0].o).toBe(true); // red
    expect(c[1].c > c[1].o).toBe(true); // green
  });
  it('returns nothing without data', () => {
    expect(buildCandles([], 1000, 0, 5000)).toEqual([]);
  });
});
