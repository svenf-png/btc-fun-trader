import { describe, expect, it } from 'vitest';
import {
  FEE_RATE,
  closePosition,
  effectiveStake,
  isLiquidated,
  liquidationPrice,
  livePnl,
  maxAffordableStake,
  openPosition,
} from '../src/trading';

describe('liquidationPrice', () => {
  it('long 10x liquidates 10 % below entry', () => {
    expect(liquidationPrice('long', 50_000, 10)).toBeCloseTo(45_000);
  });
  it('short 100x liquidates 1 % above entry', () => {
    expect(liquidationPrice('short', 50_000, 100)).toBeCloseTo(50_500);
  });
  it('long 1x only liquidates at zero', () => {
    expect(liquidationPrice('long', 50_000, 1)).toBe(0);
  });
});

describe('pnl without fees', () => {
  it('long gains when price rises', () => {
    const p = openPosition('long', 50_000, 100, 10, 0, 0);
    const t = closePosition(p, 50_500, 1);
    // +1 % move * 10x = +10 % of stake
    expect(t.net).toBe(10);
    expect(t.pct).toBeCloseTo(10);
    expect(t.liquidated).toBe(false);
  });
  it('short gains when price falls', () => {
    const p = openPosition('short', 50_000, 200, 5, 0, 0);
    expect(closePosition(p, 49_000, 1).net).toBe(20);
  });
  it('short loses when price rises', () => {
    const p = openPosition('short', 50_000, 200, 5, 0, 0);
    expect(closePosition(p, 51_000, 1).net).toBe(-20);
  });
});

describe('fees', () => {
  it('charges fee on entry and exit notional', () => {
    const p = openPosition('long', 50_000, 100, 10, FEE_RATE, 0);
    const t = closePosition(p, 50_000, 1);
    // 1000 notional * 0.05 % twice = 1.00
    expect(t.fees).toBe(1);
    expect(t.net).toBe(-1);
  });
  it('live pnl includes both fees', () => {
    const p = openPosition('long', 50_000, 100, 10, FEE_RATE, 0);
    expect(livePnl(p, 50_000).net).toBeCloseTo(-1);
  });
});

describe('liquidation', () => {
  it('detects liquidation at and beyond the liquidation price', () => {
    const p = openPosition('long', 50_000, 100, 100, 0, 0);
    expect(isLiquidated(p, 49_600)).toBe(false);
    expect(isLiquidated(p, 49_500)).toBe(true);
    expect(isLiquidated(p, 40_000)).toBe(true);
  });
  it('loss is capped at the stake plus entry fee even on a gap', () => {
    const p = openPosition('short', 50_000, 100, 50, FEE_RATE, 0);
    const t = closePosition(p, 60_000, 1);
    expect(t.liquidated).toBe(true);
    expect(t.exit).toBeCloseTo(51_000);
    expect(t.net).toBe(-102.5); // -100 stake - 2.50 entry fee
  });
});

describe('stake limits', () => {
  it('keeps room for worst-case fees', () => {
    const max = maxAffordableStake(1000, 100, FEE_RATE);
    // stake * (1 + 2 * 100 * 0.0005) = stake * 1.1 <= 1000
    expect(max).toBeCloseTo(909.09, 2);
    expect(effectiveStake(5000, 1000, 100, FEE_RATE)).toBe(max);
    expect(effectiveStake(100, 1000, 100, FEE_RATE)).toBe(100);
  });
  it('is zero for an empty account', () => {
    expect(maxAffordableStake(0, 10, FEE_RATE)).toBe(0);
  });
  it('a full-size liquidation can never push the balance below zero', () => {
    const balance = 1000;
    const stake = maxAffordableStake(balance, 100, FEE_RATE);
    const p = openPosition('long', 50_000, stake, 100, FEE_RATE, 0);
    expect(balance + closePosition(p, 1, 1).net).toBeGreaterThanOrEqual(0);
    expect(balance + closePosition(p, 49_999, 1).net).toBeGreaterThanOrEqual(0);
  });
});

describe('openPosition validation', () => {
  it('rejects zero price and zero stake', () => {
    expect(() => openPosition('long', 0, 10, 1, 0, 0)).toThrow();
    expect(() => openPosition('long', 1, 0, 1, 0, 0)).toThrow();
  });
});
