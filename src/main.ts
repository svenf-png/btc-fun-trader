import './style.css';
import { Chart, type Tick } from './chart';
import { type Cue, flash, haptic, hasVibration, playSound, unlockAudio } from './feedback';
import { type FeedStatus, PriceFeed } from './feed';
import { pct, price, usd, usdShort, zoomLabel } from './format';
import { renderStats } from './stats-view';
import { START_CAPITAL, applyTrade, clearState, initialState, loadState, resetAccount, saveState } from './store';
import { Gestures, lockPageGestures } from './touch';
import {
  type ClosedTrade,
  FEE_RATE,
  LEVERAGES,
  type Position,
  STAKES,
  type Side,
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
const feeRate = () => (state.settings.fees ? FEE_RATE : 0);

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
      ? `Position ${usdShort(s * lev)} · Liquidation bei ±${move} %${state.settings.fees ? ' · Gebühr 0,05 %' : ''}${capped ? ' · Einsatz begrenzt' : ''}`
      : 'Kontostand zu niedrig: im Menü 📊 zurücksetzen';
  el.zoom.textContent = zoomLabel(state.settings.zoom);
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
  chart.position = { side: pos.side, entry: pos.entry, liq: pos.liqPrice, winning: win };
  const txt = usd(net, true);
  if (txt !== shownPnl) {
    shownPnl = txt;
    el.pnlUsd.textContent = txt;
    el.pnlPct.textContent = pct(p);
    el.app.classList.toggle('win', win);
    el.app.classList.toggle('lose', !win);
  }
}

const gestures = new Gestures(el.zone, {
  holdStart: openTrade,
  holdEnd: () => closeTrade(),
  holdVoid: voidTrade,
  pinchStart: () => undefined,
  pinch: (scale) => {
    const base = state.settings.zoom;
    chart.setWindow(Math.max(20, Math.min(400, base / scale)), true);
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
  },
});

// ---------- render loop ----------
function layoutInsets(): void {
  const h = window.innerHeight;
  const top = el.header.getBoundingClientRect().bottom;
  const bottom = h - el.footer.getBoundingClientRect().top;
  chart.insets = { top: top + 16, bottom: bottom + 16 };
  el.zone.style.setProperty('--zone-t', `${Math.round(top)}px`);
  el.zone.style.setProperty('--zone-b', `${Math.round(bottom)}px`);
}
window.addEventListener('resize', layoutInsets);

function frame(now: number): void {
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
    feed.stop();
  } else {
    feed.restart();
  }
});
window.addEventListener('online', () => feed.restart());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => chart.readColors());

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

type ToggleKey = 'fees' | 'sound' | 'haptics';
function renderSettings(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[data-setting]')) {
    input.checked = state.settings[input.dataset.setting as ToggleKey];
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

// unlock audio on the very first interaction anywhere
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

// ---------- boot ----------
lockPageGestures();
renderControls();
layoutInsets();
requestAnimationFrame(frame);
feed.start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
