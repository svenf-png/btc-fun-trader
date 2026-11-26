// Game state, statistics and localStorage persistence.
// The reducers (applyTrade, resetAccount) are pure and unit-tested.

import { type Bet, betNet } from './grid-logic';
import { type ClosedTrade, FEE_RATE, type Side, isFeeLevel, roundCents } from './trading';

export const START_CAPITAL = 10_000;
const STORAGE_KEY = 'btc-fun-trader:v1';
const MAX_TRADES = 500; // recent trade list (statistics use running aggregates)
const MAX_EQUITY_POINTS = 1500;

export interface SideStats {
  trades: number;
  wins: number;
  losses: number;
  sumWin: number;
  sumLoss: number; // negative or 0
  best: number | null;
  worst: number | null;
  liquidations: number;
  net: number;
}

export interface EquityPoint {
  t: number;
  b: number; // balance after the event
  r?: 1; // marks a reset
}

export type GameMode = 'hold' | 'tap' | 'grid';
export const GAME_MODES: GameMode[] = ['hold', 'tap', 'grid'];

export interface GridStats {
  bets: number;
  wins: number;
  staked: number;
  net: number;
  best: number | null; // largest win (net)
}

export const emptyGridStats = (): GridStats => ({ bets: 0, wins: 0, staked: 0, net: 0, best: null });

export interface Settings {
  mode: GameMode;
  asset: string; // 'BTC' | 'ETH' | 'SOL'
  stake: number;
  leverage: number;
  feeRate: number; // per side, one of FEE_LEVELS
  sound: boolean;
  haptics: boolean;
  zoom: number; // visible seconds
}

export interface GameState {
  v: 1;
  balance: number;
  lifetimePnl: number;
  resets: number;
  stats: { long: SideStats; short: SideStats };
  grid: GridStats;
  equity: EquityPoint[];
  trades: ClosedTrade[]; // newest first
  settings: Settings;
}

export const emptySideStats = (): SideStats => ({
  trades: 0,
  wins: 0,
  losses: 0,
  sumWin: 0,
  sumLoss: 0,
  best: null,
  worst: null,
  liquidations: 0,
  net: 0,
});

export const defaultSettings = (): Settings => ({
  mode: 'hold',
  asset: 'BTC',
  stake: 100,
  leverage: 10,
  feeRate: FEE_RATE,
  sound: true,
  haptics: true,
  zoom: 60,
});

export function initialState(now: number): GameState {
  return {
    v: 1,
    balance: START_CAPITAL,
    lifetimePnl: 0,
    resets: 0,
    stats: { long: emptySideStats(), short: emptySideStats() },
    grid: emptyGridStats(),
    equity: [{ t: now, b: START_CAPITAL }],
    trades: [],
    settings: defaultSettings(),
  };
}

function addToSide(s: SideStats, t: ClosedTrade): SideStats {
  const win = t.net > 0;
  return {
    trades: s.trades + 1,
    wins: s.wins + (win ? 1 : 0),
    losses: s.losses + (win ? 0 : 1),
    sumWin: roundCents(s.sumWin + (win ? t.net : 0)),
    sumLoss: roundCents(s.sumLoss + (win ? 0 : t.net)),
    best: s.best === null ? t.net : Math.max(s.best, t.net),
    worst: s.worst === null ? t.net : Math.min(s.worst, t.net),
    liquidations: s.liquidations + (t.liquidated ? 1 : 0),
    net: roundCents(s.net + t.net),
  };
}

/** Thin out old points so the curve keeps its shape but storage stays bounded. */
export function compactEquity(points: EquityPoint[], max = MAX_EQUITY_POINTS): EquityPoint[] {
  if (points.length <= max) return points;
  const half = Math.floor(points.length / 2);
  const older = points.slice(0, half).filter((p, i) => p.r === 1 || i % 2 === 0);
  return [...older, ...points.slice(half)];
}

export function applyTrade(state: GameState, t: ClosedTrade): GameState {
  const balance = Math.max(0, roundCents(state.balance + t.net));
  return {
    ...state,
    balance,
    lifetimePnl: roundCents(state.lifetimePnl + t.net),
    stats: { ...state.stats, [t.side]: addToSide(state.stats[t.side], t) },
    equity: compactEquity([...state.equity, { t: t.closedAt, b: balance }]),
    trades: [t, ...state.trades].slice(0, MAX_TRADES),
  };
}

/** Grid bet placed: the stake leaves the balance right away (held until settled). */
export function placeGridStake(state: GameState, stake: number): GameState {
  return { ...state, balance: Math.max(0, roundCents(state.balance - stake)) };
}

/** Grid bet settled: pays out wins, refunds voids, books the result. */
export function settleGridBet(state: GameState, bet: Bet): GameState {
  if (bet.status === 'open') return state;
  if (bet.status === 'void') return { ...state, balance: roundCents(state.balance + bet.stake) };
  const net = betNet(bet);
  const payout = bet.status === 'won' ? roundCents(bet.stake + net) : 0;
  const balance = roundCents(state.balance + payout);
  const g = state.grid;
  return {
    ...state,
    balance,
    lifetimePnl: roundCents(state.lifetimePnl + net),
    grid: {
      bets: g.bets + 1,
      wins: g.wins + (bet.status === 'won' ? 1 : 0),
      staked: roundCents(g.staked + bet.stake),
      net: roundCents(g.net + net),
      best: bet.status === 'won' ? Math.max(g.best ?? 0, net) : g.best,
    },
    equity: compactEquity([...state.equity, { t: bet.settledAt ?? Date.now(), b: balance }]),
  };
}

export function resetAccount(state: GameState, now: number): GameState {
  return {
    ...state,
    balance: START_CAPITAL,
    resets: state.resets + 1,
    equity: compactEquity([...state.equity, { t: now, b: START_CAPITAL, r: 1 }]),
  };
}

export interface Summary {
  trades: number;
  wins: number;
  winRate: number | null; // 0..100
  avgWin: number | null;
  avgLoss: number | null;
  best: number | null;
  worst: number | null;
  liquidations: number;
  net: number;
}

export function summarize(sides: SideStats[]): Summary {
  const sum = (f: (s: SideStats) => number) => sides.reduce((a, s) => a + f(s), 0);
  const trades = sum((s) => s.trades);
  const wins = sum((s) => s.wins);
  const losses = sum((s) => s.losses);
  const bests = sides.map((s) => s.best).filter((v): v is number => v !== null);
  const worsts = sides.map((s) => s.worst).filter((v): v is number => v !== null);
  return {
    trades,
    wins,
    winRate: trades ? (wins / trades) * 100 : null,
    avgWin: wins ? sum((s) => s.sumWin) / wins : null,
    avgLoss: losses ? sum((s) => s.sumLoss) / losses : null,
    best: bests.length ? Math.max(...bests) : null,
    worst: worsts.length ? Math.min(...worsts) : null,
    liquidations: sum((s) => s.liquidations),
    net: roundCents(sum((s) => s.net)),
  };
}

export const sideSummary = (state: GameState, side: Side): Summary =>
  summarize([state.stats[side]]);

// ---------- persistence ----------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Accepts only well-formed data; anything else falls back to defaults. */
export function parseState(raw: string | null, now: number): GameState {
  const fresh = initialState(now);
  if (!raw) return fresh;
  try {
    const d = JSON.parse(raw) as Partial<GameState>;
    if (d?.v !== 1 || !isNum(d.balance)) return fresh;
    return {
      ...fresh,
      ...d,
      stats: {
        long: { ...emptySideStats(), ...d.stats?.long },
        short: { ...emptySideStats(), ...d.stats?.short },
      },
      grid: { ...emptyGridStats(), ...d.grid },
      equity: Array.isArray(d.equity) && d.equity.length ? d.equity : fresh.equity,
      trades: Array.isArray(d.trades) ? d.trades : [],
      settings: normalizeSettings(d.settings),
    };
  } catch {
    return fresh;
  }
}

/** Fills missing settings and migrates the old on/off fee switch to a fee level. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & { fees?: unknown };
  const { fees, ...rest } = r;
  const merged: Settings = { ...defaultSettings(), ...rest };
  if (!isFeeLevel(r.feeRate)) merged.feeRate = fees === false ? 0 : FEE_RATE;
  if (!GAME_MODES.includes(merged.mode)) merged.mode = 'hold';
  if (!['BTC', 'ETH', 'SOL'].includes(merged.asset)) merged.asset = 'BTC';
  return merged;
}

export function loadState(): GameState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* private mode or blocked storage: play without persistence */
  }
  return parseState(raw, Date.now());
}

export function saveState(state: GameState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or blocked storage: keep playing in memory */
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
