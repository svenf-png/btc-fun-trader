import { describe, expect, it } from 'vitest';
import { niceStep, plotArea } from '../src/chart';

describe('plotArea', () => {
  it('uses measured insets when they leave enough room', () => {
    expect(plotArea(852, { top: 187, bottom: 230 })).toEqual({ top: 187, bottom: 622 });
  });
  it('never returns an inverted band (top below bottom)', () => {
    // header measured before styles applied: top inset larger than the remaining space
    const a = plotArea(852, { top: 472, bottom: 372 });
    expect(a.bottom).toBeGreaterThan(a.top + 120);
  });
  it('falls back on a too narrow band and on bad numbers', () => {
    const a = plotArea(852, { top: 460, bottom: 380 });
    expect(a.bottom - a.top).toBeGreaterThan(300);
    const b = plotArea(852, { top: Number.NaN, bottom: 10 });
    expect(b.bottom).toBeGreaterThan(b.top);
  });
});

describe('niceStep', () => {
  it('picks 1/2/2.5/5 steps', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(12, 5)).toBe(2.5);
    expect(niceStep(400, 5)).toBe(100);
  });
});
