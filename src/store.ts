// Game state, statistics and localStorage persistence.
// The reducers (applyTrade, resetAccount) are pure and unit-tested.

import { type ClosedTrade, type Side, roundCents } from './trading';

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

export interface Settings {
  stake: number;
  leverage: number;
  fees: boolean;
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
  stake: 100,
  leverage: 10,
  fees: true,
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
      equity: Array.isArray(d.equity) && d.equity.length ? d.equity : fresh.equity,
      trades: Array.isArray(d.trades) ? d.trades : [],
      settings: { ...defaultSettings(), ...d.settings },
    };
  } catch {
    return fresh;
  }
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
