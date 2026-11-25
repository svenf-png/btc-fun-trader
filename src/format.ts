const usdFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "10.000,00 $" style, optionally with explicit + sign. */
export function usd(v: number, signed = false): string {
  const s = `${usdFmt.format(Math.abs(v))} $`;
  if (v < 0 && Math.abs(v) >= 0.005) return `−${s}`;
  return signed && v >= 0.005 ? `+${s}` : s;
}

export function usdShort(v: number): string {
  return v >= 1000 ? `${intFmt.format(v)} $` : usd(v);
}

export function pct(v: number, signed = true): string {
  const s = `${pctFmt.format(Math.abs(v))} %`;
  if (v < 0 && Math.abs(v) >= 0.005) return `−${s}`;
  return signed && v >= 0.005 ? `+${s}` : s;
}

/** BTC price for the big header, e.g. "58.259,04". */
export function price(v: number): string {
  return usdFmt.format(v);
}

export function zoomLabel(sec: number): string {
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}
