// Pure trade math. No DOM, no time, no storage: everything here is unit-tested.

export type Side = 'long' | 'short';

export const LEVERAGES = [1, 5, 10, 25, 50, 100] as const;
export type Leverage = (typeof LEVERAGES)[number];

export const STAKES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** 0.05 % of position value, charged on entry and on exit. */
export const FEE_RATE = 0.0005;

export interface Position {
  side: Side;
  entry: number; // BTC price at open (USD)
  stake: number; // margin in USD
  leverage: number;
  notional: number; // stake * leverage
  qty: number; // BTC amount = notional / entry
  feeRate: number; // 0 when fees are disabled
  entryFee: number;
  liqPrice: number;
  openedAt: number; // epoch ms
}

export interface ClosedTrade {
  side: Side;
  entry: number;
  exit: number;
  stake: number;
  leverage: number;
  fees: number;
  gross: number;
  net: number; // gross - fees, the amount added to the balance
  pct: number; // net relative to stake, in percent
  liquidated: boolean;
  openedAt: number;
  closedAt: number;
}

export const roundCents = (v: number): number => Math.round(v * 100) / 100;

/** Price at which the unrealised loss equals the stake. */
export function liquidationPrice(side: Side, entry: number, leverage: number): number {
  return side === 'long' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
}

/**
 * Largest stake that is affordable: stake plus worst-case fees on both sides
 * must fit into the balance, so the balance can never go negative.
 */
export function maxAffordableStake(balance: number, leverage: number, feeRate: number): number {
  if (balance <= 0) return 0;
  const factor = 1 + 2 * leverage * feeRate;
  return Math.floor((balance / factor) * 100) / 100;
}

export function effectiveStake(
  wanted: number,
  balance: number,
  leverage: number,
  feeRate: number,
): number {
  return Math.max(0, Math.min(wanted, maxAffordableStake(balance, leverage, feeRate)));
}

export function openPosition(
  side: Side,
  entry: number,
  stake: number,
  leverage: number,
  feeRate: number,
  now: number,
): Position {
  if (!(entry > 0)) throw new Error('invalid entry price');
  if (!(stake > 0)) throw new Error('invalid stake');
  const notional = stake * leverage;
  return {
    side,
    entry,
    stake,
    leverage,
    notional,
    qty: notional / entry,
    feeRate,
    entryFee: notional * feeRate,
    liqPrice: liquidationPrice(side, entry, leverage),
    openedAt: now,
  };
}

/** Unrealised profit before fees, capped so the loss never exceeds the stake. */
export function grossPnl(pos: Position, price: number): number {
  const raw = pos.side === 'long' ? pos.qty * (price - pos.entry) : pos.qty * (pos.entry - price);
  return Math.max(raw, -pos.stake);
}

export function isLiquidated(pos: Position, price: number): boolean {
  return pos.side === 'long' ? price <= pos.liqPrice : price >= pos.liqPrice;
}

/** What the trader would get if closing right now, after both fees. */
export function livePnl(pos: Position, price: number): { net: number; pct: number } {
  const gross = grossPnl(pos, price);
  const exitFee = isLiquidated(pos, price) ? 0 : pos.qty * price * pos.feeRate;
  const net = gross - pos.entryFee - exitFee;
  return { net, pct: (net / pos.stake) * 100 };
}

export function closePosition(pos: Position, price: number, now: number): ClosedTrade {
  const liquidated = isLiquidated(pos, price);
  // A liquidation fills at the liquidation price; gaps beyond it are absorbed.
  const exit = liquidated ? pos.liqPrice : price;
  const gross = liquidated ? -pos.stake : grossPnl(pos, exit);
  const exitFee = liquidated ? 0 : pos.qty * exit * pos.feeRate;
  const fees = roundCents(pos.entryFee + exitFee);
  const net = roundCents(gross - pos.entryFee - exitFee);
  return {
    side: pos.side,
    entry: pos.entry,
    exit,
    stake: pos.stake,
    leverage: pos.leverage,
    fees,
    gross: roundCents(gross),
    net,
    pct: (net / pos.stake) * 100,
    liquidated,
    openedAt: pos.openedAt,
    closedAt: now,
  };
}
