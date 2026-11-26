import { describe, expect, it } from 'vitest';
import {
  START_CAPITAL,
  applyTrade,
  compactEquity,
  initialState,
  normalizeSettings,
  placeGridStake,
  settleGridBet,
  parseState,
  resetAccount,
  sideSummary,
  summarize,
} from '../src/store';
import { closePosition, openPosition } from '../src/trading';

const trade = (side: 'long' | 'short', exit: number, lev = 10) =>
  closePosition(openPosition(side, 50_000, 100, lev, 0, 0), exit, 1);

describe('applyTrade', () => {
  it('updates balance, lifetime pnl and per-side stats', () => {
    let s = initialState(0);
    s = applyTrade(s, trade('long', 50_500)); // +10
    s = applyTrade(s, trade('long', 49_750)); // -5
    s = applyTrade(s, trade('short', 49_000)); // +20
    expect(s.balance).toBe(START_CAPITAL + 25);
    expect(s.lifetimePnl).toBe(25);
    const long = sideSummary(s, 'long');
    expect(long.trades).toBe(2);
    expect(long.winRate).toBe(50);
    expect(long.best).toBe(10);
    expect(long.worst).toBe(-5);
    const all = summarize([s.stats.long, s.stats.short]);
    expect(all.trades).toBe(3);
    expect(all.avgWin).toBe(15);
    expect(all.avgLoss).toBe(-5);
    expect(s.equity).toHaveLength(4);
  });

  it('counts liquidations', () => {
    const s = applyTrade(initialState(0), trade('long', 40_000));
    expect(s.stats.long.liquidations).toBe(1);
    expect(s.balance).toBe(START_CAPITAL - 100);
  });
});

describe('resetAccount', () => {
  it('refills the balance but keeps lifetime pnl and stats', () => {
    let s = applyTrade(initialState(0), trade('long', 40_000));
    s = resetAccount(s, 5);
    expect(s.balance).toBe(START_CAPITAL);
    expect(s.resets).toBe(1);
    expect(s.lifetimePnl).toBe(-100);
    expect(s.stats.long.trades).toBe(1);
    expect(s.equity.at(-1)).toEqual({ t: 5, b: START_CAPITAL, r: 1 });
  });
});

describe('summarize', () => {
  it('returns nulls without trades', () => {
    const r = summarize([initialState(0).stats.long]);
    expect(r.winRate).toBeNull();
    expect(r.best).toBeNull();
  });
});

describe('compactEquity', () => {
  it('stays bounded and keeps reset markers and the newest points', () => {
    const pts = Array.from({ length: 2000 }, (_, i) => ({ t: i, b: i, ...(i === 1 ? { r: 1 as const } : {}) }));
    const c = compactEquity(pts, 1500);
    expect(c.length).toBeLessThan(2000);
    expect(c.some((p) => p.r === 1)).toBe(true);
    expect(c.at(-1)).toEqual(pts.at(-1));
  });
});

describe('parseState', () => {
  it('falls back to defaults on garbage', () => {
    expect(parseState('nope', 0).balance).toBe(START_CAPITAL);
    expect(parseState('{"v":2}', 0).balance).toBe(START_CAPITAL);
    expect(parseState(null, 0).settings.leverage).toBe(10);
  });
  it('restores saved data and fills missing settings', () => {
    const saved = { ...initialState(0), balance: 1234, settings: { stake: 50 } };
    const s = parseState(JSON.stringify(saved), 0);
    expect(s.balance).toBe(1234);
    expect(s.settings.stake).toBe(50);
    expect(s.settings.feeRate).toBe(0.0005);
  });
});

describe('normalizeSettings (fee levels)', () => {
  it('migrates the old on/off switch', () => {
    expect(normalizeSettings({ fees: false }).feeRate).toBe(0);
    expect(normalizeSettings({ fees: true }).feeRate).toBe(0.0005);
    expect('fees' in normalizeSettings({ fees: true })).toBe(false);
  });
  it('keeps a valid level and rejects anything else', () => {
    expect(normalizeSettings({ feeRate: 0.0002 }).feeRate).toBe(0.0002);
    expect(normalizeSettings({ feeRate: 0 }).feeRate).toBe(0);
    expect(normalizeSettings({ feeRate: 0.5 }).feeRate).toBe(0.0005);
    expect(normalizeSettings(null).feeRate).toBe(0.0005);
  });
  it('is applied when loading a saved game', () => {
    const old = { ...initialState(0), settings: { stake: 50, fees: false } };
    expect(parseState(JSON.stringify(old), 0).settings.feeRate).toBe(0);
  });
});

describe('grid bets in the game state', () => {
  const bet = (status: 'won' | 'lost' | 'void') => ({
    id: 1, start: 0, end: 1, lo: 0, hi: 1, stake: 100, mult: 2.5, placedAt: 0, status, settledAt: 5,
  });
  it('holds the stake, then pays stake × multiplier on a win', () => {
    let s = placeGridStake(initialState(0), 100);
    expect(s.balance).toBe(START_CAPITAL - 100);
    s = settleGridBet(s, bet('won'));
    expect(s.balance).toBe(START_CAPITAL + 150);
    expect(s.lifetimePnl).toBe(150);
    expect(s.grid).toEqual({ bets: 1, wins: 1, staked: 100, net: 150, best: 150 });
  });
  it('keeps the stake on a loss and refunds a void bet', () => {
    let s = settleGridBet(placeGridStake(initialState(0), 100), bet('lost'));
    expect(s.balance).toBe(START_CAPITAL - 100);
    expect(s.grid.net).toBe(-100);
    s = settleGridBet(placeGridStake(initialState(0), 100), bet('void'));
    expect(s.balance).toBe(START_CAPITAL);
    expect(s.grid.bets).toBe(0);
  });
  it('defaults to hold mode and repairs unknown modes', () => {
    expect(normalizeSettings({ mode: 'grid' }).mode).toBe('grid');
    expect(normalizeSettings({ mode: 'x' }).mode).toBe('hold');
    expect(parseState(JSON.stringify({ v: 1, balance: 5 }), 0).grid.bets).toBe(0);
  });
});
