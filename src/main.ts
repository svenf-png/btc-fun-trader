import './style.css';
import { Chart, type Tick, token } from './chart';
import { type Cue, flash, haptic, hasVibration, playSound, unlockAudio } from './feedback';
import { type FeedStatus, PriceFeed } from './feed';
import { pct, price, usd, usdShort, zoomLabel } from './format';
import type { Bet } from './grid-logic';
import { GridMode } from './grid-mode';
import { renderStats } from './stats-view';
import {
  type GameMode,
  START_CAPITAL,
  applyTrade,
  clearState,
  initialState,
  loadState,
  placeGridStake,
  resetAccount,
  saveState,
  settleGridBet,
} from './store';
import { Gestures, lockPageGestures } from './touch';
import { BUILD_ID, fetchRemoteBuild, isNewer, reloadToLatest } from './update';
import {
  type ClosedTrade,
  FEE_LEVELS,
  LEVERAGES,
  type Position,
  STAKES,
  type Side,
  breakEvenPrice,
  closePosition,
  effectiveStake,
  isLiquidated,
  livePnl,
  openPosition,
} from './trading';

const ZOOMS = [30, 60, 300];
const HISTORY_MS = 6 * 60 * 1000;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

// ---------- state ----------
let state = loadState();
let pos: Position | null = null;
let lastPrice = 0;
let feedStatus: FeedStatus = 'connecting';
let everLive = false;
const ticks: Tick[] = [];

const save = () => saveState(state);
const feeRate = () => state.settings.feeRate;

// ---------- elements ----------
const chart = new Chart($<HTMLCanvasElement>('chart'));
chart.ticks = ticks;
chart.setWindow(state.settings.zoom, true);

const el = {
  app: $('app'),
  zone: $('zone'),
  status: $('status'),
  source: $('source'),
  price: $('price'),
  zoom: $<HTMLButtonElement>('zoomBtn'),
  header: $('top'),
  footer: $('controls'),
  balance: $('balance'),
  stake: $('stake'),
  stakeDown: $<HTMLButtonElement>('stakeDown'),
  stakeUp: $<HTMLButtonElement>('stakeUp'),
  levs: $('levs'),
  posInfo: $('posInfo'),
  pnl: $('pnl'),
  pnlSide: $('pnlSide'),
  pnlUsd: $('pnlUsd'),
  pnlPct: $('pnlPct'),
  toast: $('toast'),
  liq: $('liq'),
  mode: $<HTMLButtonElement>('modeBtn'),
  chartError: $('chartError'),
};

// ---------- feedback ----------
function feedback(cue: Cue, flashKind?: 'up' | 'down' | 'neutral' | 'liq'): void {
  if (state.settings.sound) playSound(cue);
  if (state.settings.haptics) haptic(cue);
  // Without real vibration (iPhone) a subtle flash stands in for the haptic tick.
  const kind = flashKind ?? (state.settings.haptics && !hasVibration() ? 'neutral' : undefined);
  if (kind) flash(kind);
}

let toastTimer = 0;
function toast(html: { title: string; sub?: string; kind: 'up' | 'down' | 'warn' | 'info' }, ms = 1600): void {
  el.toast.replaceChildren();
  const t = document.createElement('div');
  t.className = 'toast-title';
  t.textContent = html.title;
  el.toast.append(t);
  if (html.sub) {
    const s = document.createElement('div');
    s.className = 'toast-sub';
    s.textContent = html.sub;
    el.toast.append(s);
  }
  el.toast.className = `show ${html.kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.className = '';
  }, ms);
}

// ---------- controls ----------
function stakeNow(): number {
  return effectiveStake(state.settings.stake, state.balance, state.settings.leverage, feeRate());
}

function renderControls(): void {
  el.balance.textContent = usd(state.balance);
  const s = stakeNow();
  const capped = s < state.settings.stake;
  el.stake.textContent = usdShort(s);
  el.stake.classList.toggle('capped', capped);
  const lev = state.settings.leverage;
  for (const b of el.levs.querySelectorAll<HTMLButtonElement>('button')) {
    const on = Number(b.dataset.lev) === lev;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  el.stakeDown.disabled = state.settings.stake <= STAKES[0];
  el.stakeUp.disabled = state.settings.stake >= STAKES[STAKES.length - 1];
  const move = (100 / lev).toLocaleString('de-DE', { maximumFractionDigits: 1 });
  el.posInfo.textContent =
    s >= 1
      ? `Position ${usdShort(s * lev)} · Liquidation bei ±${move} %${feeRate() > 0 ? ` · Gebühr ${feeLabel()}` : ' · ohne Gebühr'}${capped ? ' · Einsatz begrenzt' : ''}`
      : 'Kontostand zu niedrig: im Menü 📊 zurücksetzen';
  if (isGrid()) {
    const open = grid.openBets.length;
    el.stake.textContent = usdShort(gridStake());
    el.stake.classList.remove('capped');
    el.posInfo.textContent =
      gridStake() >= 1
        ? `Raster: Feld rechts antippen · Einsatz ${usdShort(gridStake())} je Feld${open ? ` · ${open} offen` : ''}`
        : 'Kontostand zu niedrig: im Menü 📊 zurücksetzen';
  }
  el.zoom.textContent = zoomLabel(state.settings.zoom);
  el.mode.textContent = isGrid() ? '▦ Raster' : '✋ Halten';
  el.mode.setAttribute('aria-label', `Spielmodus: ${isGrid() ? 'Raster' : 'Halten'}, antippen zum Wechseln`);
}

for (const lev of LEVERAGES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.lev = String(lev);
  b.textContent = `${lev}x`;
  b.addEventListener('click', () => {
    state.settings.leverage = lev;
    save();
    renderControls();
  });
  el.levs.append(b);
}

function stepStake(dir: 1 | -1): void {
  const cur = state.settings.stake;
  const i = STAKES.findIndex((v) => v >= cur);
  const idx = Math.max(0, Math.min(STAKES.length - 1, (i === -1 ? STAKES.length - 1 : i) + dir));
  state.settings.stake = STAKES[idx];
  save();
  renderControls();
}
el.stakeDown.addEventListener('click', () => stepStake(-1));
el.stakeUp.addEventListener('click', () => stepStake(1));

function setZoom(sec: number): void {
  state.settings.zoom = sec;
  chart.setWindow(sec);
  save();
  renderControls();
}
el.zoom.addEventListener('click', () => {
  const i = ZOOMS.indexOf(state.settings.zoom);
  setZoom(ZOOMS[(i + 1) % ZOOMS.length]);
});

// ---------- trading ----------
function canTrade(): string | null {
  if (feedStatus !== 'live' || !lastPrice) return 'Keine Live-Verbindung';
  if (stakeNow() < 1) return 'Kontostand zu niedrig';
  return null;
}

function openTrade(side: Side): boolean {
  unlockAudio();
  if (isGrid()) return false; // grid mode: a tap places a bet instead (see placeBet)
  const reason = canTrade();
  if (reason) {
    feedback('denied');
    toast({ title: reason, sub: reason.startsWith('Konto') ? 'Im Menü 📊 zurücksetzen' : 'Warte auf LIVE', kind: 'warn' });
    return false;
  }
  pos = openPosition(side, lastPrice, stakeNow(), state.settings.leverage, feeRate(), Date.now());
  el.app.classList.add('holding', side);
  el.pnlSide.textContent = `${side === 'long' ? '▲ LONG' : '▼ SHORT'} ${pos.leverage}x · ${usdShort(pos.stake)}`;
  el.pnl.hidden = false;
  el.toast.className = '';
  updatePnl();
  feedback(side === 'long' ? 'enterLong' : 'enterShort');
  return true;
}

function clearPosition(): void {
  pos = null;
  chart.position = null;
  el.app.classList.remove('holding', 'long', 'short', 'win', 'lose');
  el.pnl.hidden = true;
}

function finish(trade: ClosedTrade, note?: string): void {
  clearPosition();
  state = applyTrade(state, trade);
  save();
  renderControls();
  if (trade.liquidated) {
    feedback('liquidation', 'liq');
    showLiquidation(trade);
    return;
  }
  const win = trade.net > 0;
  feedback(win ? 'win' : 'loss', win ? 'up' : 'down');
  toast({ title: usd(trade.net, true), sub: note ? `${pct(trade.pct)} · ${note}` : pct(trade.pct), kind: win ? 'up' : 'down' }, note ? 2600 : 1600);
}

function closeTrade(note?: string): void {
  if (!pos) return;
  finish(closePosition(pos, lastPrice, Date.now()), note);
}

function voidTrade(): void {
  clearPosition();
  toast({ title: 'Zoom', sub: 'Trade verworfen', kind: 'info' }, 900);
}

function showLiquidation(trade: ClosedTrade): void {
  el.liq.querySelector('.liq-sub')!.textContent = `${usd(trade.net, true)} · ${trade.leverage}x ${trade.side === 'long' ? 'Long' : 'Short'}`;
  el.liq.hidden = false;
  el.app.classList.add('shake');
  setTimeout(() => el.app.classList.remove('shake'), 700);
  setTimeout(() => {
    el.liq.hidden = true;
  }, 2200);
}

let shownPnl = '';
function updatePnl(): void {
  if (!pos) return;
  const { net, pct: p } = livePnl(pos, lastPrice);
  const win = net >= 0;
  chart.position = {
    side: pos.side,
    entry: pos.entry,
    liq: pos.liqPrice,
    breakEven: pos.feeRate > 0 ? breakEvenPrice(pos.side, pos.entry, pos.feeRate) : undefined,
    winning: win,
  };
  const txt = usd(net, true);
  if (txt !== shownPnl) {
    shownPnl = txt;
    el.pnlUsd.textContent = txt;
    el.pnlPct.textContent = pct(p);
    el.app.classList.toggle('win', win);
    el.app.classList.toggle('lose', !win);
  }
}

const grid = new GridMode();
const gestures = new Gestures(el.zone, {
  holdStart: openTrade,
  holdEnd: () => closeTrade(),
  holdVoid: voidTrade,
  pinchStart: () => undefined,
  pinch: (scale) => {
    const base = state.settings.zoom;
    chart.setWindow(Math.max(20, Math.min(400, base / scale)), true);
  },
  tap: (x, y) => {
    if (isGrid()) placeBet(x, y);
  },
  pinchEnd: (scale) => {
    const i = ZOOMS.indexOf(state.settings.zoom);
    let next = i;
    if (scale > 1.2) next = Math.max(0, i - 1);
    else if (scale < 0.83) next = Math.min(ZOOMS.length - 1, i + 1);
    setZoom(ZOOMS[next === -1 ? 1 : next]);
  },
});

// ---------- price feed ----------
let shownPrice = '';
let chartError = '';
const feed = new PriceFeed({
  onPrice: (p, at) => {
    lastPrice = p;
    const last = ticks[ticks.length - 1];
    if (last && grid.openBets.length) {
      for (const bet of grid.onTick({ t: last.t, p: last.p }, { t: at, p })) settleBet(bet);
    }
    if (last && at - last.t < 16) last.p = p; // coalesce bursts within one frame
    else ticks.push({ t: at, p });
    while (ticks.length > 2 && ticks[0].t < at - HISTORY_MS) ticks.shift();
    if (pos) {
      if (isLiquidated(pos, p)) {
        gestures.release();
        finish(closePosition(pos, p, Date.now()));
      } else updatePnl();
    }
  },
  onStatus: (s, source) => {
    feedStatus = s;
    if (s === 'live') everLive = true;
    // Before the first price we are "connecting"; after that any non-live state is "getrennt".
    const shown = s === 'live' ? 'live' : everLive ? 'offline' : 'connecting';
    el.status.dataset.state = shown;
    el.status.querySelector('.label')!.textContent =
      shown === 'live' ? 'LIVE' : shown === 'connecting' ? 'verbinde…' : 'getrennt';
    el.source.textContent = `BTC/USD · ${source}`;
    el.app.classList.toggle('offline', s !== 'live');
    if (s !== 'live' && pos) {
      gestures.release();
      closeTrade('Verbindung weg: zum letzten Kurs geschlossen');
    }
    if (s !== 'live') voidBets('Verbindung weg: offene Felder erstattet');
  },
});

// ---------- render loop ----------
// Measured every frame, relative to the canvas: a one-off measurement at start-up can
// happen before iOS has applied the stylesheet and would then stay wrong.
let insetKey = '';
function layoutInsets(): void {
  const canvas = $('chart').getBoundingClientRect();
  const top = Math.round(el.header.getBoundingClientRect().bottom - canvas.top);
  const bottom = Math.round(canvas.bottom - el.footer.getBoundingClientRect().top);
  const key = `${top}|${bottom}`;
  if (key === insetKey) return;
  insetKey = key;
  chart.insets = { top: top + 16, bottom: bottom + 16 };
  el.zone.style.setProperty('--zone-t', `${Math.max(0, top)}px`);
  el.zone.style.setProperty('--zone-b', `${Math.max(0, bottom)}px`);
}

function frame(now: number): void {
  layoutInsets();
  if (lastPrice) {
    const txt = price(lastPrice);
    if (txt !== shownPrice) {
      const up = lastPrice >= Number(el.price.dataset.v ?? 0);
      el.price.dataset.v = String(lastPrice);
      el.price.dataset.dir = up ? 'up' : 'down';
      el.price.textContent = txt;
      shownPrice = txt;
    }
  }
  requestAnimationFrame(frame); // schedule first: a render error must never stop the loop
  if (grid.bets.length) {
    for (const bet of grid.expire(Date.now())) settleBet(bet);
    chart.extraRange = grid.range;
    if (chart.geom) grid.prune(chart.geom);
  } else chart.extraRange = null;
  try {
    chart.render(now);
    if (chartError) {
      chartError = '';
      el.chartError.hidden = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (msg !== chartError) {
      chartError = msg;
      el.chartError.textContent = `Chart-Fehler: ${msg}`;
      el.chartError.hidden = false;
    }
  }
}

// ---------- lifecycle ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (pos) {
      gestures.release();
      closeTrade('App verlassen: Position geschlossen');
    }
    voidBets('App verlassen: offene Felder erstattet');
    feed.stop();
  } else {
    feed.restart();
  }
});
window.addEventListener('online', () => feed.restart());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chart.readColors();
  colors = gridColors();
});

// ---------- sheets ----------
function openSheet(id: 'stats' | 'settings'): void {
  if (pos) return;
  if (id === 'stats') renderStats($('statsBody'), state);
  else renderSettings();
  $(id).hidden = false;
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) {
  b.addEventListener('click', () => {
    $(b.dataset.close!).hidden = true;
  });
}
$('statsBtn').addEventListener('click', () => openSheet('stats'));
$('settingsBtn').addEventListener('click', () => openSheet('settings'));

function confirmDialog(title: string, text: string, ok: string): Promise<boolean> {
  const dlg = $('confirm');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = ok;
  dlg.hidden = false;
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      dlg.hidden = true;
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      resolve(v);
    };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
  });
}

async function doReset(): Promise<void> {
  const ok = await confirmDialog(
    'Konto zurücksetzen?',
    `Kontostand wird auf ${usd(START_CAPITAL)} Spielgeld aufgefüllt. Lifetime-PnL und Statistik bleiben erhalten.`,
    'Zurücksetzen',
  );
  if (!ok) return;
  state = resetAccount(state, Date.now());
  save();
  renderControls();
  renderStats($('statsBody'), state);
  toast({ title: `${usd(START_CAPITAL)}`, sub: 'Konto aufgefüllt', kind: 'info' });
}

async function doWipe(): Promise<void> {
  const ok = await confirmDialog('Alles löschen?', 'Kontostand, Statistik, Lifetime-PnL und Einstellungen werden gelöscht.', 'Löschen');
  if (!ok) return;
  clearState();
  state = initialState(Date.now());
  save();
  renderControls();
  renderSettings();
}

document.addEventListener('click', (e) => {
  const t = (e.target as Element | null)?.closest<HTMLElement>('[data-action]');
  if (t?.dataset.action === 'reset') void doReset();
  if (t?.dataset.action === 'wipe') void doWipe();
});

type ToggleKey = 'sound' | 'haptics';
function renderSettings(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[data-setting]')) {
    input.checked = state.settings[input.dataset.setting as ToggleKey];
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#feeLevels button')) {
    const on = Number(b.dataset.fee) === state.settings.feeRate;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('hapticNote').textContent = hasVibration()
    ? 'Dieses Gerät unterstützt Vibration.'
    : 'iPhone: Safari bietet Web-Apps keine Vibrations-Schnittstelle. Es wird ein inoffizieller Trick versucht, der auf neueren iOS-Versionen wirkungslos sein kann. Ersatz: Sound und Bildschirm-Flash.';
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[data-setting]')) {
  input.addEventListener('change', () => {
    state.settings[input.dataset.setting as ToggleKey] = input.checked;
    save();
    renderControls();
    if (input.dataset.setting === 'sound' && input.checked) {
      unlockAudio();
      playSound('win');
    }
  });
}

const feeLabel = () => FEE_LEVELS.find((l) => l.rate === feeRate())?.label ?? '';
for (const level of FEE_LEVELS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.fee = String(level.rate);
  const strong = document.createElement('b');
  strong.textContent = level.label;
  const hint = document.createElement('small');
  hint.textContent = level.hint;
  b.append(strong, hint);
  b.addEventListener('click', () => {
    if (pos) return; // never change the fee of an open position
    state.settings.feeRate = level.rate;
    save();
    renderControls();
    renderSettings();
  });
  $('feeLevels').append(b);
}

// unlock audio on the very first interaction anywhere
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

// ---------- grid mode ----------
function isGrid(): boolean {
  return state.settings.mode === 'grid';
}

function gridStake(): number {
  return Math.max(0, Math.min(state.settings.stake, Math.floor(state.balance * 100) / 100));
}

function gridColors() {
  return {
    cell: token('--chart-line', '#a78bfa'),
    text: token('--muted', '#8f89b3'),
    accent: token('--chart-line', '#a78bfa'),
    up: token('--up', '#2ee6a6'),
    down: token('--down', '#ff5277'),
    strong: token('--text', '#f4f1ff'),
  };
}
let colors = gridColors();

function applyMode(): void {
  const on = isGrid();
  chart.futureFraction = on ? 0.42 : 0;
  chart.overlay = on
    ? (ctx, g) => {
        if (lastPrice) grid.update(g, ticks, state.settings.zoom, lastPrice);
        grid.draw(ctx, g, state.settings.zoom, colors);
      }
    : null;
  el.app.classList.toggle('grid-mode', on);
  renderControls();
}

el.mode.addEventListener('click', () => {
  if (pos) return;
  if (grid.openBets.length) {
    toast({ title: 'Erst offene Felder abwarten', kind: 'warn' }, 1400);
    return;
  }
  state.settings.mode = (isGrid() ? 'hold' : 'grid') as GameMode;
  save();
  applyMode();
  toast({
    title: isGrid() ? '▦ Raster' : '✋ Halten',
    sub: isGrid() ? 'Feld rechts antippen: Kurs muss es berühren' : 'Oben halten = Long, unten = Short',
    kind: 'info',
  }, 1800);
});

function placeBet(x: number, y: number): void {
  unlockAudio();
  const g = chart.geom;
  if (!g) return;
  if (feedStatus !== 'live' || !lastPrice) {
    feedback('denied');
    toast({ title: 'Keine Live-Verbindung', sub: 'Warte auf LIVE', kind: 'warn' });
    return;
  }
  const cell = grid.hit(x, y, g, state.settings.zoom);
  if (!cell) {
    toast({ title: 'Feld rechts antippen', sub: 'Nur zukünftige Felder rechts der Linie', kind: 'info' }, 1300);
    return;
  }
  if (grid.openBets.some((b) => b.start === cell.start && b.lo === cell.lo)) return; // already placed
  const stake = gridStake();
  if (stake < 1) {
    feedback('denied');
    toast({ title: 'Kontostand zu niedrig', sub: 'Im Menü 📊 zurücksetzen', kind: 'warn' });
    return;
  }
  grid.place(cell, stake, lastPrice, Date.now());
  state = placeGridStake(state, stake);
  save();
  renderControls();
  feedback(cell.lo >= lastPrice ? 'enterLong' : 'enterShort');
}

function settleBet(bet: Bet): void {
  state = settleGridBet(state, bet);
  save();
  renderControls();
  if (bet.status === 'won') {
    const net = bet.stake * (bet.mult - 1);
    feedback('win', 'up');
    toast({ title: usd(net, true), sub: `Treffer · ${bet.mult.toLocaleString('de-DE')}×`, kind: 'up' }, 1500);
  } else if (bet.status === 'lost') {
    if (state.settings.sound) playSound('loss');
  }
}

function voidBets(note: string): void {
  const voided = grid.voidOpen(Date.now());
  if (!voided.length) return;
  for (const bet of voided) settleBet(bet);
  toast({ title: '↺ Erstattet', sub: note, kind: 'info' }, 2200);
}

// ---------- boot ----------
lockPageGestures();
applyMode();
renderControls();
layoutInsets();
requestAnimationFrame(frame);
feed.start();

// ---------- updates ----------
const updateBtn = $<HTMLButtonElement>('updateBtn');
$('buildId').textContent = BUILD_ID;
let updateReady = false;

async function checkForUpdate(): Promise<boolean> {
  const remote = await fetchRemoteBuild(import.meta.env.BASE_URL);
  updateReady = isNewer(BUILD_ID, remote);
  updateBtn.hidden = !updateReady;
  return updateReady;
}

updateBtn.addEventListener('click', () => {
  if (!pos) void reloadToLatest();
});

$('checkUpdate').addEventListener('click', async () => {
  if (pos) return;
  const btn = $<HTMLButtonElement>('checkUpdate');
  btn.disabled = true;
  btn.textContent = 'Suche…';
  const newer = await checkForUpdate();
  if (newer) {
    btn.textContent = 'Lade neue Version…';
    await reloadToLatest();
    return;
  }
  btn.disabled = false;
  btn.textContent = '⟳ Neue Version laden';
  toast({ title: 'Aktuell', sub: `Version ${BUILD_ID} ist die neueste`, kind: 'info' });
});

if (import.meta.env.PROD) {
  setTimeout(() => void checkForUpdate(), 3000);
  setInterval(() => void checkForUpdate(), 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkForUpdate();
  });
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
