import { withAlpha } from './chart';
import { pct, usd } from './format';
import { type EquityPoint, type GameState, START_CAPITAL, type Summary, sideSummary, summarize } from './store';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const money = (v: number | null) => (v === null ? '–' : usd(v, true));
const tone = (v: number | null) => (v === null || Math.abs(v) < 0.005 ? '' : v > 0 ? 'up' : 'down');

function card(label: string, value: string, toneCls = '', big = false): HTMLElement {
  const c = node('div', `card${big ? ' big' : ''}`);
  c.append(node('div', 'card-label', label), node('div', `card-value ${toneCls}`, value));
  return c;
}

function summaryRows(s: Summary): [string, string, string][] {
  return [
    ['Trades', String(s.trades), ''],
    ['Win Rate', s.winRate === null ? '–' : pct(s.winRate, false), ''],
    ['Ø Gewinn', money(s.avgWin), tone(s.avgWin)],
    ['Ø Verlust', money(s.avgLoss), tone(s.avgLoss)],
    ['Bester', money(s.best), tone(s.best)],
    ['Schlechtester', money(s.worst), tone(s.worst)],
    ['Liquidationen', String(s.liquidations), ''],
    ['Netto', money(s.net), tone(s.net)],
  ];
}

export function renderStats(root: HTMLElement, state: GameState): void {
  root.replaceChildren();
  const all = summarize([state.stats.long, state.stats.short]);
  const long = sideSummary(state, 'long');
  const short = sideSummary(state, 'short');

  const top = node('div', 'cards');
  top.append(
    card('Kontostand', usd(state.balance), '', true),
    card('Lifetime-PnL', usd(state.lifetimePnl, true), tone(state.lifetimePnl), true),
    card('Resets', String(state.resets)),
    card('Seit Start', pct(((state.balance - START_CAPITAL) / START_CAPITAL) * 100), tone(state.balance - START_CAPITAL)),
  );
  root.append(top);

  root.append(node('h3', '', 'Kontostand-Verlauf'));
  const wrap = node('div', 'equity');
  const canvas = node('canvas');
  wrap.append(canvas);
  root.append(wrap);
  requestAnimationFrame(() => drawEquity(canvas, state.equity));

  root.append(node('h3', '', 'Übersicht'));
  const table = node('table', 'stats-table');
  const head = node('tr');
  head.append(node('th', '', ''), node('th', '', 'Gesamt'), node('th', 'up', '▲ Long'), node('th', 'down', '▼ Short'));
  table.append(head);
  const rows = [summaryRows(all), summaryRows(long), summaryRows(short)];
  rows[0].forEach(([label], i) => {
    const tr = node('tr');
    tr.append(node('td', 'label', label));
    for (const r of rows) tr.append(node('td', r[i][2], r[i][1]));
    table.append(tr);
  });
  root.append(table);

  if (state.trades.length) {
    root.append(node('h3', '', 'Letzte Trades'));
    const list = node('ul', 'trades');
    for (const t of state.trades.slice(0, 25)) {
      const li = node('li');
      const when = new Date(t.closedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      li.append(
        node('span', t.side === 'long' ? 'up' : 'down', `${t.side === 'long' ? '▲' : '▼'} ${t.leverage}x`),
        node('span', 'muted', `${when} · ${((t.closedAt - t.openedAt) / 1000).toFixed(1)} s${t.liquidated ? ' · 💥' : ''}`),
        node('span', tone(t.net), usd(t.net, true)),
      );
      list.append(li);
    }
    root.append(list);
  } else {
    root.append(node('p', 'muted empty', 'Noch keine Trades. Finger auf den Chart: oben halten = Long, unten halten = Short.'));
  }
}

function drawEquity(canvas: HTMLCanvasElement, pts: EquityPoint[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = getComputedStyle(document.documentElement);
  const up = cs.getPropertyValue('--up').trim();
  const down = cs.getPropertyValue('--down').trim();
  const muted = cs.getPropertyValue('--muted').trim();
  const grid = cs.getPropertyValue('--grid').trim();
  const W = r.width;
  const H = r.height;
  const padY = 14;
  const values = pts.map((p) => p.b);
  let lo = Math.min(START_CAPITAL, ...values);
  let hi = Math.max(START_CAPITAL, ...values);
  if (hi - lo < 1) {
    lo -= 50;
    hi += 50;
  }
  const n = Math.max(1, pts.length - 1);
  // x by trade index, not time: sessions with long pauses stay readable
  const X = (i: number) => 4 + (i / n) * (W - 8);
  const Y = (v: number) => H - padY - ((v - lo) / (hi - lo)) * (H - 2 * padY);

  ctx.clearRect(0, 0, W, H);
  // start capital reference
  ctx.strokeStyle = grid;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, Y(START_CAPITAL));
  ctx.lineTo(W, Y(START_CAPITAL));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = muted;
  ctx.font = '600 10px ui-rounded, system-ui, sans-serif';
  ctx.fillText(usd(START_CAPITAL), 6, Y(START_CAPITAL) - 5);

  // reset markers
  ctx.strokeStyle = withAlpha(muted.startsWith('#') ? muted : '#888888', 0.5);
  pts.forEach((p, i) => {
    if (!p.r) return;
    ctx.beginPath();
    ctx.moveTo(X(i), 0);
    ctx.lineTo(X(i), H);
    ctx.stroke();
  });

  if (pts.length < 2) {
    ctx.fillStyle = muted;
    ctx.fillText('Noch keine Daten', W / 2 - 40, H / 2);
    return;
  }
  const last = values[values.length - 1];
  const color = last >= START_CAPITAL ? up : down;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.b)) : ctx.moveTo(X(i), Y(p.b))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(X(pts.length - 1), H);
  ctx.lineTo(X(0), H);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, withAlpha(color, 0.3));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fill();
}
