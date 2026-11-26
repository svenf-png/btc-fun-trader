// Turns raw price ticks into OHLC candles. Pure and unit-tested.

export interface PriceTick {
  t: number; // epoch ms
  p: number;
}

export interface Candle {
  t: number; // bucket start, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Candle length for a visible window: about 30 candles on screen. */
export function candleMs(windowSec: number): number {
  if (windowSec <= 45) return 1000;
  if (windowSec <= 120) return 2000;
  return 10_000;
}

/**
 * Candles for every bucket in [from, to]. A bucket without ticks becomes a flat
 * candle at the previous close, so the chart has no holes. Each candle opens at the
 * previous close (like exchange charts), which keeps consecutive candles connected.
 * `ticks` must be sorted by time.
 */
export function buildCandles(ticks: PriceTick[], bucketMs: number, from: number, to: number): Candle[] {
  const out: Candle[] = [];
  if (!ticks.length || bucketMs <= 0 || to < from) return out;
  const start = Math.floor(from / bucketMs) * bucketMs;
  const end = Math.floor(to / bucketMs) * bucketMs;

  // last price before the first bucket (binary search)
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].t < start) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  let prev: number | null = i > 0 ? ticks[i - 1].p : null;

  for (let b = start; b <= end; b += bucketMs) {
    const bEnd = b + bucketMs;
    let o = prev;
    let h = -Infinity;
    let l = Infinity;
    let c = prev;
    while (i < ticks.length && ticks[i].t < bEnd) {
      const p = ticks[i].p;
      if (o === null) o = p;
      if (p > h) h = p;
      if (p < l) l = p;
      c = p;
      i++;
    }
    if (o === null || c === null) continue; // nothing known yet
    h = Math.max(h, o, c);
    l = Math.min(l, o, c);
    out.push({ t: b, o, h, l, c });
    prev = c;
  }
  return out;
}
